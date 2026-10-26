//! Splitting a script into Batches on `GO`, the way SSMS and sqlcmd do it.
//!
//! `GO` separates Batches only when it stands alone on a line, optionally
//! followed by a repeat count and a `--` comment. A `GO` inside a string,
//! a quoted identifier or a block comment is just text.

/// One Batch of a script, sent to the Server as a unit.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Batch {
    pub text: String,
    /// Zero-based line of the script where this Batch starts, so a Server
    /// error line inside the Batch maps back to the editor.
    pub first_line: u32,
    /// How many times to run it (`GO 5`).
    pub repeat: u32,
}

/// Where the scanner is at the end of a line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Code,
    /// Inside `/* ... */`; T-SQL block comments nest.
    BlockComment(u32),
    /// Inside a literal or identifier closed by this character.
    Quoted(char),
}

/// Splits `script` into Batches, dropping Batches that are only whitespace.
pub fn split(script: &str) -> Vec<Batch> {
    let mut batches = Vec::new();
    let mut current = String::new();
    let mut first_line = 0u32;
    let mut state = State::Code;

    for (index, line) in script.split_inclusive('\n').enumerate() {
        let index = index as u32;
        if state == State::Code
            && let Some(repeat) = separator(line)
        {
            push(&mut batches, &mut current, first_line, repeat);
            first_line = index + 1;
            continue;
        }
        if current.is_empty() {
            first_line = index;
        }
        current.push_str(line);
        state = scan(line, state);
    }
    push(&mut batches, &mut current, first_line, 1);
    batches
}

fn push(batches: &mut Vec<Batch>, text: &mut String, first_line: u32, repeat: u32) {
    let taken = std::mem::take(text);
    if taken.trim().is_empty() || repeat == 0 {
        return;
    }
    batches.push(Batch {
        text: taken,
        first_line,
        repeat,
    });
}

/// The repeat count when `line` is a `GO` separator.
fn separator(line: &str) -> Option<u32> {
    let line = match line.find("--") {
        Some(comment) => &line[..comment],
        None => line,
    };
    let mut words = line.split_whitespace();
    if !words.next()?.eq_ignore_ascii_case("go") {
        return None;
    }
    match (words.next(), words.next()) {
        (None, _) => Some(1),
        (Some(count), None) => count.parse().ok(),
        _ => None,
    }
}

/// Advances the scanner over one line.
fn scan(line: &str, mut state: State) -> State {
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        state = match state {
            State::Code => match c {
                '-' if chars.peek() == Some(&'-') => return State::Code,
                '/' if chars.peek() == Some(&'*') => {
                    chars.next();
                    State::BlockComment(1)
                }
                '\'' => State::Quoted('\''),
                '"' => State::Quoted('"'),
                '[' => State::Quoted(']'),
                _ => State::Code,
            },
            State::BlockComment(depth) => match c {
                '/' if chars.peek() == Some(&'*') => {
                    chars.next();
                    State::BlockComment(depth + 1)
                }
                '*' if chars.peek() == Some(&'/') => {
                    chars.next();
                    if depth == 1 {
                        State::Code
                    } else {
                        State::BlockComment(depth - 1)
                    }
                }
                _ => state,
            },
            State::Quoted(close) if c == close => {
                // A doubled closing character is an escaped one.
                if chars.peek() == Some(&close) {
                    chars.next();
                    state
                } else {
                    State::Code
                }
            }
            State::Quoted(_) => state,
        };
    }
    state
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(script: &str) -> Vec<(String, u32, u32)> {
        split(script)
            .into_iter()
            .map(|b| (b.text.trim_end().to_string(), b.first_line, b.repeat))
            .collect()
    }

    #[test]
    fn a_script_without_go_is_one_batch() {
        assert_eq!(
            texts("SELECT 1;\nSELECT 2;"),
            [("SELECT 1;\nSELECT 2;".into(), 0, 1)]
        );
    }

    #[test]
    fn go_on_its_own_line_separates_batches_and_keeps_line_numbers() {
        let script =
            "CREATE TABLE t (x int)\nGO\n\nCREATE VIEW v AS SELECT x FROM t\ngo\r\nSELECT * FROM v";
        assert_eq!(
            texts(script),
            [
                ("CREATE TABLE t (x int)".into(), 0, 1),
                ("\nCREATE VIEW v AS SELECT x FROM t".into(), 2, 1),
                ("SELECT * FROM v".into(), 5, 1),
            ]
        );
    }

    #[test]
    fn go_accepts_a_count_a_comment_and_surrounding_spaces() {
        assert_eq!(
            texts("INSERT t DEFAULT VALUES\n   GO 3   -- three rows\nSELECT 1"),
            [
                ("INSERT t DEFAULT VALUES".into(), 0, 3),
                ("SELECT 1".into(), 2, 1)
            ]
        );
    }

    #[test]
    fn go_with_other_words_is_not_a_separator() {
        assert_eq!(texts("SELECT 1 AS go\nGO TO x\nGOTO done").len(), 1);
    }

    #[test]
    fn go_zero_runs_nothing() {
        assert_eq!(
            texts("SELECT 1\nGO 0\nSELECT 2"),
            [("SELECT 2".into(), 2, 1)]
        );
    }

    #[test]
    fn go_inside_strings_identifiers_and_comments_is_text() {
        let script =
            "SELECT 'a\nGO\nb', [x\nGO\ny] /* c\nGO\n/* nested\nGO\n*/\nGO\n*/\nGO\nSELECT 2";
        let batches = split(script);
        assert_eq!(batches.len(), 2, "{batches:#?}");
        assert_eq!(batches[1].text, "SELECT 2");
        assert_eq!(batches[1].first_line, 12);
    }

    #[test]
    fn escaped_quotes_do_not_end_a_string() {
        let batches = split("SELECT 'it''s\nGO\nstill'\nGO\nSELECT 2");
        assert_eq!(batches.len(), 2);
        assert_eq!(batches[1].text, "SELECT 2");
    }

    #[test]
    fn a_line_comment_hides_quotes_until_the_end_of_line() {
        let batches = split("SELECT 1 -- don't\nGO\nSELECT 2");
        assert_eq!(batches.len(), 2);
    }

    #[test]
    fn empty_batches_are_dropped() {
        // Leading blank lines stay in the Batch so its line numbers match the editor.
        assert_eq!(
            texts("GO\n\nGO\n  \nSELECT 1\nGO\n"),
            [("  \nSELECT 1".into(), 3, 1)]
        );
        assert!(split("").is_empty());
    }
}
