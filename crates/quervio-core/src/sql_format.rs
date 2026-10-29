//! Format Document and Format Selection: sqruff's T-SQL dialect with its
//! layout rules and keyword case only (docs/adr/0006-formatter-sqruff.md),
//! so table, column and function names keep the case they were written in.
//! The editor splits the script on GO and checks that the result has the
//! same tokens (src/lib/format-sql.ts); this only lays out one Batch.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use sqruff_lib::core::config::FluffConfig;
use sqruff_lib::core::linter::core::Linter;

/// Settings > Editor > Formatting.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Style {
    pub uppercase_keywords: bool,
    pub indent: Indent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize)]
pub enum Indent {
    #[serde(rename = "2")]
    Two,
    #[serde(rename = "4")]
    Four,
    #[serde(rename = "tab")]
    Tab,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Formatted {
    pub text: String,
    /// The first line (1-based, in the Batch) that sqruff could not parse.
    /// From there to the end of that statement the text is left as written.
    pub unparsed_line: Option<usize>,
}

/// Lays out one Batch: the statements in it, without GO lines.
pub fn format_batch(sql: &str, style: Style) -> Result<Formatted, String> {
    // sqruff lexes N'x' as a name and a string, and its spacing rule puts a
    // space between them, which makes N an alias. The strings go through
    // without the prefix and get it back afterwards.
    let (sql, prefixes) = without_unicode_prefixes(sql);
    let linted = linter(style)?
        .lint_string(&sql, None, true)
        .map_err(|error| error.value)?;
    let unparsed_line = linted
        .violations()
        .iter()
        .filter(|violation| violation.rule.is_none())
        .map(|violation| violation.line_no)
        .min();
    Ok(Formatted {
        text: with_unicode_prefixes(&linted.fix_string(), &prefixes)?,
        unparsed_line,
    })
}

/// `sql` without the N of N'…' strings, and for each one removed, which
/// string (counted from 0) it belonged to and how it was written.
fn without_unicode_prefixes(sql: &str) -> (String, Vec<(usize, char)>) {
    let mut prefixes = Vec::new();
    let mut out = String::with_capacity(sql.len());
    let mut copied = 0;
    for (index, start) in string_starts(sql).into_iter().enumerate() {
        let before = &sql[..start];
        let Some(letter) = before.chars().next_back().filter(|c| matches!(c, 'N' | 'n')) else {
            continue;
        };
        let prefix = start - 1;
        // Only a lone N: in `aN'x'` the N ends a name.
        if sql[..prefix].chars().next_back().is_some_and(is_name_char) {
            continue;
        }
        out.push_str(&sql[copied..prefix]);
        copied = start;
        prefixes.push((index, letter));
    }
    out.push_str(&sql[copied..]);
    (out, prefixes)
}

/// Puts the prefixes back before the same strings of the formatted text.
fn with_unicode_prefixes(formatted: &str, prefixes: &[(usize, char)]) -> Result<String, String> {
    if prefixes.is_empty() {
        return Ok(formatted.to_string());
    }
    let starts = string_starts(formatted);
    let mut out = formatted.to_string();
    for &(index, letter) in prefixes.iter().rev() {
        let start = *starts
            .get(index)
            .ok_or("Formatting lost a string literal; nothing was changed.")?;
        out.insert(start, letter);
    }
    Ok(out)
}

fn is_name_char(c: char) -> bool {
    c.is_alphanumeric() || matches!(c, '_' | '@' | '#' | '$')
}

/// Byte offsets of the opening quote of each string literal, read the way
/// SQL Server reads the script: `--` and nested `/* */` comments, doubled
/// quotes inside strings, and "…" and […] names skipped.
fn string_starts(sql: &str) -> Vec<usize> {
    let bytes = sql.as_bytes();
    let mut starts = Vec::new();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                i = sql[i..].find('\n').map_or(bytes.len(), |end| i + end);
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let mut depth = 0;
                while i < bytes.len() {
                    if bytes[i..].starts_with(b"/*") {
                        depth += 1;
                        i += 2;
                    } else if bytes[i..].starts_with(b"*/") {
                        depth -= 1;
                        i += 2;
                        if depth == 0 {
                            break;
                        }
                    } else {
                        i += 1;
                    }
                }
            }
            quote @ (b'\'' | b'"' | b'[') => {
                let close = if quote == b'[' { b']' } else { quote };
                if quote == b'\'' {
                    starts.push(i);
                }
                i += 1;
                while i < bytes.len() {
                    if bytes[i] == close {
                        // A doubled closing character is an escaped one.
                        if bytes.get(i + 1) == Some(&close) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            _ => i += 1,
        }
    }
    starts
}

/// One Linter per style: building one reads the rules, which takes longer
/// than formatting a Batch.
fn linter(style: Style) -> Result<Arc<Linter>, String> {
    static LINTERS: OnceLock<Mutex<HashMap<Style, Arc<Linter>>>> = OnceLock::new();
    let mut linters = LINTERS.get_or_init(Default::default).lock().unwrap();
    if let Some(linter) = linters.get(&style) {
        return Ok(linter.clone());
    }
    let config = FluffConfig::try_from_source(&config(style), None).map_err(|error| error.value)?;
    // Parse errors are reported, so a part left unformatted can be named.
    let linter = Arc::new(Linter::new(config, None, None, true)?);
    linters.insert(style, linter.clone());
    Ok(linter)
}

/// Layout rules only, plus the case of keywords and of NULL: none of them
/// changes what the Server runs.
fn config(style: Style) -> String {
    let (unit, size) = match style.indent {
        Indent::Two => ("space", 2),
        Indent::Four => ("space", 4),
        Indent::Tab => ("tab", 4),
    };
    let case = if style.uppercase_keywords { "upper" } else { "lower" };
    format!(
        "[sqruff]
dialect = tsql
rules = CP01,CP04,LT01,LT02,LT03,LT04,LT05,LT06,LT07,LT08,LT09,LT10,LT11,LT12,LT13,LT14,LT15

[sqruff:indentation]
indent_unit = {unit}
tab_space_size = {size}
# A comment ending a line that gets split stays after the code it
# followed; moving it before would change the order of the tokens.
trailing_comments = after

[sqruff:rules:capitalisation.keywords]
capitalisation_policy = {case}

[sqruff:rules:capitalisation.literals]
capitalisation_policy = {case}
"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    const STYLE: Style = Style {
        uppercase_keywords: true,
        indent: Indent::Four,
    };

    fn format(sql: &str) -> Formatted {
        format_batch(sql, STYLE).unwrap()
    }

    #[test]
    fn lays_out_a_query_and_keeps_the_case_of_names() {
        let formatted = format(
            "select a.Id,b.Name from dbo.T a join dbo.U b on a.id=b.id where a.x>1 and b.y like '%a%' order by b.Name desc",
        );
        assert_eq!(
            formatted.text,
            "SELECT\n    a.Id,\n    b.Name\nFROM dbo.T a\nJOIN dbo.U b ON a.id = b.id\nWHERE a.x > 1 AND b.y LIKE '%a%'\nORDER BY b.Name DESC\n"
        );
        assert_eq!(formatted.unparsed_line, None);
    }

    #[test]
    fn keeps_comments_strings_and_bracketed_names() {
        let formatted = format(
            "-- keep this\nselect [Order Id] = c.id, 'it''s' as s /* inline */ from #tmp c option (recompile)",
        );
        assert!(formatted.text.starts_with("-- keep this\nSELECT\n"));
        assert!(formatted.text.contains("[Order Id] = c.id"));
        assert!(formatted.text.contains("'it''s' AS s"));
        assert!(formatted.text.contains("/* inline */"));
        assert!(formatted.text.contains("OPTION (RECOMPILE)"));
    }

    #[test]
    fn follows_the_style() {
        let lower = format_batch(
            "SELECT a, b FROM t WHERE c IS NULL",
            Style {
                uppercase_keywords: false,
                indent: Indent::Two,
            },
        )
        .unwrap();
        assert_eq!(lower.text, "select\n  a,\n  b\nfrom t\nwhere c is null\n");
        let tab = format_batch(
            "select a, b from t",
            Style {
                uppercase_keywords: true,
                indent: Indent::Tab,
            },
        )
        .unwrap();
        assert_eq!(tab.text, "SELECT\n\ta,\n\tb\nFROM t\n");
    }

    #[test]
    fn keeps_unicode_strings_together() {
        let formatted = format(
            "select N'it''s' as x, n'b' y, [N'not'] z, 'plain' p from t where a=N'z' -- N'c'\n",
        );
        assert_eq!(
            formatted.text,
            "SELECT\n    N'it''s' AS x,\n    n'b' y,\n    [N'not'] z,\n    'plain' p\nFROM t\nWHERE a = N'z' -- N'c'\n"
        );
    }

    #[test]
    fn leaves_an_n_that_ends_a_name() {
        assert_eq!(
            without_unicode_prefixes("select xN'q', N'r'"),
            ("select xN'q', 'r'".to_string(), vec![(1, 'N')])
        );
    }

    #[test]
    fn reads_strings_as_the_server_does() {
        let sql = "a /* x /* 'no' */ 'no' */ 'yes' -- 'no'\n\"'no'\" [']]'] 'it''s'";
        let starts = string_starts(sql);
        assert_eq!(
            starts.iter().map(|&start| &sql[start..start + 4]).collect::<Vec<_>>(),
            ["'yes", "'it'"]
        );
    }

    #[test]
    fn speaks_the_editor_s_json() {
        let style: Style = serde_json::from_str(r#"{"uppercaseKeywords":false,"indent":"tab"}"#).unwrap();
        assert_eq!(
            style,
            Style {
                uppercase_keywords: false,
                indent: Indent::Tab
            }
        );
        assert_eq!(
            serde_json::to_string(&format("select 1")).unwrap(),
            r#"{"text":"SELECT 1\n","unparsedLine":null}"#
        );
    }

    #[test]
    fn names_the_first_line_it_could_not_parse() {
        let formatted = format("select 1\nselect 1 // 2 from t\n");
        assert_eq!(formatted.unparsed_line, Some(2));
        assert!(formatted.text.contains("1 // 2"));
    }
}
