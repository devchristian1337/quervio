//! Spotting Destructive Statements before a script runs on Production:
//! UPDATE/DELETE without WHERE (Unfiltered Writes), TRUNCATE TABLE, DROP and
//! ALTER TABLE.
//!
//! This is a careful scan of T-SQL tokens, not a parser. It ignores
//! comments, strings and quoted names, temp tables (`#t`) and table
//! variables (`@t`), and the body of a CREATE/ALTER PROCEDURE, FUNCTION,
//! TRIGGER or VIEW, which only defines code. Dynamic SQL inside `EXEC('...')`
//! is not looked at. When the script cannot be scanned (an unterminated
//! string or comment) the result is `uncertain`, and the caller should ask
//! anyway.

use serde::Serialize;

use crate::batch;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DestructiveKind {
    UpdateWithoutWhere,
    DeleteWithoutWhere,
    Truncate,
    Drop,
    AlterTable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Finding {
    pub kind: DestructiveKind,
    /// The object it touches, as written (e.g. `dbo.Orders`).
    pub target: String,
    /// One-based line in the editor.
    pub line: u32,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Check {
    pub findings: Vec<Finding>,
    pub uncertain: bool,
}

impl Check {
    pub fn needs_confirmation(&self) -> bool {
        self.uncertain || !self.findings.is_empty()
    }
}

/// Scans `script`, whose first line is editor line `base_line` (zero-based).
pub fn check(script: &str, base_line: u32) -> Check {
    let mut result = Check::default();
    for batch in batch::split(script) {
        match lex(&batch.text) {
            Some(tokens) => scan(&tokens, base_line + batch.first_line, &mut result.findings),
            None => result.uncertain = true,
        }
    }
    result
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Kind {
    /// A keyword or bare name, upper-cased.
    Word(String),
    /// A `[bracketed]` or `"quoted"` name, as written.
    Quoted(String),
    Symbol(char),
}

#[derive(Debug, Clone)]
struct Token {
    kind: Kind,
    /// The token as written, for showing names in their own case.
    text: String,
    /// Zero-based line within the batch.
    line: u32,
}

impl Token {
    fn is_word(&self, word: &str) -> bool {
        matches!(&self.kind, Kind::Word(w) if w == word)
    }

    fn is_symbol(&self, symbol: char) -> bool {
        self.kind == Kind::Symbol(symbol)
    }
}

/// Splits T-SQL into tokens; `None` when a string, quoted name or block
/// comment never ends.
fn lex(text: &str) -> Option<Vec<Token>> {
    let chars: Vec<char> = text.chars().collect();
    let mut tokens = Vec::new();
    let mut line = 0u32;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        match c {
            '\n' => {
                line += 1;
                i += 1;
            }
            c if c.is_whitespace() => i += 1,
            '-' if chars.get(i + 1) == Some(&'-') => {
                while i < chars.len() && chars[i] != '\n' {
                    i += 1;
                }
            }
            '/' if chars.get(i + 1) == Some(&'*') => {
                let mut depth = 0;
                loop {
                    match (chars.get(i), chars.get(i + 1)) {
                        (Some('/'), Some('*')) => {
                            depth += 1;
                            i += 2;
                        }
                        (Some('*'), Some('/')) => {
                            depth -= 1;
                            i += 2;
                            if depth == 0 {
                                break;
                            }
                        }
                        (Some('\n'), _) => {
                            line += 1;
                            i += 1;
                        }
                        (Some(_), _) => i += 1,
                        (None, _) => return None,
                    }
                }
            }
            '\'' | '"' | '[' => {
                let close = if c == '[' { ']' } else { c };
                let start = i;
                let start_line = line;
                i += 1;
                loop {
                    match chars.get(i) {
                        None => return None,
                        Some(&ch) if ch == close => {
                            // A doubled closing character is an escaped one.
                            if chars.get(i + 1) == Some(&close) {
                                i += 2;
                            } else {
                                i += 1;
                                break;
                            }
                        }
                        Some('\n') => {
                            line += 1;
                            i += 1;
                        }
                        Some(_) => i += 1,
                    }
                }
                if c != '\'' {
                    let text: String = chars[start..i].iter().collect();
                    tokens.push(Token {
                        kind: Kind::Quoted(text.clone()),
                        text,
                        line: start_line,
                    });
                }
                // String literals carry no structure we need.
            }
            c if c.is_alphanumeric() || matches!(c, '_' | '@' | '#' | '$') => {
                let start = i;
                while i < chars.len()
                    && (chars[i].is_alphanumeric() || matches!(chars[i], '_' | '@' | '#' | '$'))
                {
                    i += 1;
                }
                let word: String = chars[start..i].iter().collect();
                tokens.push(Token {
                    kind: Kind::Word(word.to_uppercase()),
                    text: word,
                    line,
                });
            }
            c => {
                tokens.push(Token {
                    kind: Kind::Symbol(c),
                    text: c.to_string(),
                    line,
                });
                i += 1;
            }
        }
    }
    Some(tokens)
}

/// Words that start a new statement when no `;` separates them.
const STATEMENT_STARTS: &[&str] = &[
    "SELECT",
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "EXEC",
    "EXECUTE",
    "DECLARE",
    "SET",
    "IF",
    "ELSE",
    "BEGIN",
    "END",
    "WHILE",
    "PRINT",
    "RETURN",
    "USE",
    "GRANT",
    "REVOKE",
    "DENY",
    "RAISERROR",
    "THROW",
    "COMMIT",
    "ROLLBACK",
    "SAVE",
    "WAITFOR",
    "GOTO",
    "BREAK",
    "CONTINUE",
    "OPEN",
    "CLOSE",
    "FETCH",
    "DEALLOCATE",
    "BULK",
    "WITH",
];

/// Objects whose CREATE/ALTER makes the rest of the batch a definition.
const MODULES: &[&str] = &["PROCEDURE", "PROC", "FUNCTION", "TRIGGER", "VIEW"];

fn scan(tokens: &[Token], line_offset: u32, findings: &mut Vec<Finding>) {
    let mut depth = 0i32;
    let mut i = 0;
    while i < tokens.len() {
        let token = &tokens[i];
        if token.is_symbol('(') {
            depth += 1;
        } else if token.is_symbol(')') {
            depth -= 1;
        }
        if depth != 0 {
            i += 1;
            continue;
        }
        let next_word = |offset: usize| match tokens.get(i + offset).map(|t| &t.kind) {
            Some(Kind::Word(w)) => Some(w.as_str()),
            _ => None,
        };
        let line = line_offset + token.line + 1;
        let mut report = |kind, target: Option<String>| {
            if let Some(target) = target {
                findings.push(Finding { kind, target, line });
            }
        };

        // SQL Server only takes a module's CREATE/ALTER as the first statement
        // of a batch; elsewhere the words are something else, such as the
        // permission in `GRANT CREATE VIEW`.
        if i == 0
            && ((token.is_word("CREATE") || token.is_word("ALTER"))
                && next_word(1).is_some_and(|w| MODULES.contains(&w))
                || token.is_word("CREATE")
                    && next_word(1) == Some("OR")
                    && next_word(3).is_some_and(|w| MODULES.contains(&w)))
        {
            // The rest of the batch is a module body: defined, not run.
            return;
        }

        if token.is_word("UPDATE") && next_word(1) != Some("STATISTICS") {
            let target = name_after(tokens, skip_top(tokens, i + 1));
            if !has_where(tokens, i + 1, &["SET"]) {
                report(DestructiveKind::UpdateWithoutWhere, target);
            }
        } else if token.is_word("DELETE") {
            let mut at = skip_top(tokens, i + 1);
            if tokens.get(at).is_some_and(|t| t.is_word("FROM")) {
                at += 1;
            }
            let target = name_after(tokens, at);
            if !has_where(tokens, i + 1, &[]) {
                report(DestructiveKind::DeleteWithoutWhere, target);
            }
        } else if token.is_word("TRUNCATE") && next_word(1) == Some("TABLE") {
            report(DestructiveKind::Truncate, name_after(tokens, i + 2));
        } else if token.is_word("DROP") && next_word(1).is_some() {
            let mut at = i + 2;
            if next_word(2) == Some("IF") && next_word(3) == Some("EXISTS") {
                at += 2;
            }
            report(DestructiveKind::Drop, name_after(tokens, at));
        } else if token.is_word("ALTER") && next_word(1) == Some("TABLE") {
            report(DestructiveKind::AlterTable, name_after(tokens, i + 2));
            // Its DROP COLUMN / DROP CONSTRAINT is part of this finding.
            i = alter_table_end(tokens, i + 2);
            continue;
        }
        i += 1;
    }
}

/// Skips `TOP (n) [PERCENT]` after UPDATE/DELETE.
fn skip_top(tokens: &[Token], mut at: usize) -> usize {
    if tokens.get(at).is_some_and(|t| t.is_word("TOP")) {
        at += 1;
        if tokens.get(at).is_some_and(|t| t.is_symbol('(')) {
            let mut depth = 0;
            while let Some(token) = tokens.get(at) {
                if token.is_symbol('(') {
                    depth += 1;
                } else if token.is_symbol(')') {
                    depth -= 1;
                }
                at += 1;
                if depth == 0 {
                    break;
                }
            }
        } else {
            at += 1;
        }
        if tokens.get(at).is_some_and(|t| t.is_word("PERCENT")) {
            at += 1;
        }
    }
    at
}

/// The (possibly qualified) name starting at `at`; `None` for temp tables
/// and table variables, which are private to the Session.
fn name_after(tokens: &[Token], mut at: usize) -> Option<String> {
    let mut parts = Vec::new();
    loop {
        match tokens.get(at) {
            Some(token) if matches!(token.kind, Kind::Word(_) | Kind::Quoted(_)) => {
                parts.push(token.text.clone())
            }
            _ => break,
        }
        at += 1;
        // `db..table` leaves an empty schema; keep it.
        while tokens.get(at).is_some_and(|t| t.is_symbol('.')) {
            parts.push(String::new());
            at += 1;
        }
        if !parts.last().is_some_and(String::is_empty) {
            break;
        }
        parts.pop();
        parts.push(String::new());
    }
    let parts: Vec<_> = parts.into_iter().filter(|p| !p.is_empty()).collect();
    let last = parts.last()?;
    let bare = last.trim_start_matches(['[', '"']);
    if bare.starts_with('#') || bare.starts_with('@') {
        return None;
    }
    Some(parts.join("."))
}

/// Whether the statement starting at `from` has a top-level WHERE before it
/// ends.
fn has_where(tokens: &[Token], from: usize, belongs: &[&str]) -> bool {
    let end = statement_end(tokens, from, belongs);
    let mut depth = 0;
    tokens[from..end].iter().any(|token| {
        if token.is_symbol('(') {
            depth += 1;
        } else if token.is_symbol(')') {
            depth -= 1;
        }
        depth == 0 && token.is_word("WHERE")
    })
}

/// Index just past the statement starting at `from`: a top-level `;`, or a
/// word that starts the next statement and is not one of `belongs`, the
/// words that are part of the current one (SET in an UPDATE, DROP in an
/// ALTER TABLE).
fn statement_end(tokens: &[Token], from: usize, belongs: &[&str]) -> usize {
    let mut depth = 0;
    for (offset, token) in tokens[from..].iter().enumerate() {
        let at = from + offset;
        if token.is_symbol('(') {
            depth += 1;
        } else if token.is_symbol(')') {
            depth -= 1;
        }
        if depth != 0 {
            continue;
        }
        if token.is_symbol(';') {
            return at;
        }
        if let Kind::Word(word) = &token.kind {
            let starts =
                STATEMENT_STARTS.contains(&word.as_str()) && !belongs.contains(&word.as_str());
            // `WITH (ROWLOCK)` is a table hint, not a CTE.
            let is_hint = word == "WITH" && tokens.get(at + 1).is_some_and(|t| t.is_symbol('('));
            if starts && !is_hint {
                return at;
            }
        }
    }
    tokens.len()
}

/// What a DROP drops when it starts a statement of its own; inside an
/// ALTER TABLE, DROP is followed by COLUMN, CONSTRAINT or a name instead.
const DROPPED_OBJECTS: &[&str] = &[
    "TABLE",
    "VIEW",
    "INDEX",
    "PROCEDURE",
    "PROC",
    "FUNCTION",
    "TRIGGER",
    "DATABASE",
    "SCHEMA",
    "TYPE",
    "SYNONYM",
    "SEQUENCE",
    "USER",
    "LOGIN",
    "ROLE",
    "ASSEMBLY",
    "STATISTICS",
    "DEFAULT",
    "RULE",
    "XML",
    "FULLTEXT",
    "EXTERNAL",
    "PARTITION",
    "QUEUE",
    "SERVICE",
    "CERTIFICATE",
    "SYMMETRIC",
    "ASYMMETRIC",
    "CREDENTIAL",
    "EVENT",
    "SERVER",
    "AGGREGATE",
    "SECURITY",
];

/// Index just past the ALTER TABLE whose clauses start at `from`. Without a
/// `;`, a DROP TABLE, ALTER TABLE or SET NOCOUNT on a later line starts the
/// next statement, while DROP COLUMN, ALTER COLUMN, SET (...) and
/// WITH CHECK belong to this one.
fn alter_table_end(tokens: &[Token], from: usize) -> usize {
    let mut depth = 0;
    for (offset, token) in tokens[from..].iter().enumerate() {
        let at = from + offset;
        if token.is_symbol('(') {
            depth += 1;
        } else if token.is_symbol(')') {
            depth -= 1;
        }
        if depth != 0 {
            continue;
        }
        if token.is_symbol(';') {
            return at;
        }
        let Kind::Word(word) = &token.kind else {
            continue;
        };
        if !STATEMENT_STARTS.contains(&word.as_str()) {
            continue;
        }
        let next = tokens.get(at + 1);
        let next_word = match next.map(|t| &t.kind) {
            Some(Kind::Word(w)) => Some(w.as_str()),
            _ => None,
        };
        let belongs = match word.as_str() {
            "DROP" => !next_word.is_some_and(|w| DROPPED_OBJECTS.contains(&w)),
            "ALTER" => next_word == Some("COLUMN"),
            "SET" => next.is_some_and(|t| t.is_symbol('(')),
            "WITH" => {
                matches!(next_word, Some("CHECK" | "NOCHECK"))
                    || next.is_some_and(|t| t.is_symbol('('))
            }
            _ => false,
        };
        if !belongs {
            return at;
        }
    }
    tokens.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(script: &str) -> Vec<(DestructiveKind, String, u32)> {
        let result = check(script, 0);
        assert!(!result.uncertain, "unexpectedly uncertain: {script}");
        result
            .findings
            .into_iter()
            .map(|f| (f.kind, f.target, f.line))
            .collect()
    }

    use DestructiveKind::*;

    #[test]
    fn filtered_writes_are_fine() {
        assert!(kinds("UPDATE dbo.Orders SET Total = 0 WHERE Id = 1").is_empty());
        assert!(kinds("DELETE FROM dbo.Orders WHERE Id IN (SELECT Id FROM x)").is_empty());
        assert!(
            kinds(
                "UPDATE o SET o.Total = 0 FROM dbo.Orders o JOIN c ON c.Id = o.Id WHERE c.Bad = 1"
            )
            .is_empty()
        );
        assert!(kinds("UPDATE dbo.Orders WITH (ROWLOCK) SET Total = 0 WHERE Id = 1").is_empty());
        assert!(kinds("DELETE TOP (10) FROM dbo.Log WHERE At < '2020-01-01'").is_empty());
        assert!(kinds("UPDATE t SET x = (SELECT 1 WHERE 1 = 1) WHERE id = 2").is_empty());
    }

    #[test]
    fn unfiltered_writes_are_found() {
        assert_eq!(
            kinds("UPDATE dbo.Orders SET Total = 0"),
            [(UpdateWithoutWhere, "dbo.Orders".into(), 1)]
        );
        assert_eq!(
            kinds("DELETE dbo.Orders"),
            [(DeleteWithoutWhere, "dbo.Orders".into(), 1)]
        );
        assert_eq!(
            kinds("delete from [Sales].[Order];"),
            [(DeleteWithoutWhere, "[Sales].[Order]".into(), 1)]
        );
        // A WHERE inside a subquery does not filter the UPDATE itself.
        assert_eq!(
            kinds("UPDATE t SET x = (SELECT 1 FROM y WHERE y.a = 1)").len(),
            1
        );
    }

    #[test]
    fn a_where_after_the_statement_ends_does_not_count() {
        assert_eq!(kinds("DELETE FROM t; SELECT * FROM u WHERE 1 = 1").len(), 1);
        assert_eq!(kinds("DELETE FROM t\nSELECT * FROM u WHERE 1 = 1").len(), 1);
    }

    #[test]
    fn schema_changes_are_found() {
        assert_eq!(
            kinds("TRUNCATE TABLE dbo.Log"),
            [(Truncate, "dbo.Log".into(), 1)]
        );
        assert_eq!(
            kinds("DROP TABLE IF EXISTS dbo.Old"),
            [(Drop, "dbo.Old".into(), 1)]
        );
        assert_eq!(
            kinds("DROP PROCEDURE dbo.usp_x"),
            [(Drop, "dbo.usp_x".into(), 1)]
        );
        assert_eq!(
            kinds("ALTER TABLE dbo.T DROP COLUMN x"),
            [(AlterTable, "dbo.T".into(), 1)]
        );
    }

    #[test]
    fn temp_tables_and_table_variables_are_private() {
        assert!(
            kinds("CREATE TABLE #t (x int); DELETE FROM #t; TRUNCATE TABLE #t; DROP TABLE #t")
                .is_empty()
        );
        assert!(kinds("DECLARE @t TABLE (x int); DELETE @t; UPDATE @t SET x = 1").is_empty());
    }

    #[test]
    fn comments_strings_and_statistics_are_ignored() {
        assert!(kinds("-- DELETE FROM t\n/* DROP TABLE t */ SELECT 'DELETE FROM t'").is_empty());
        assert!(kinds("UPDATE STATISTICS dbo.Orders").is_empty());
        assert!(kinds("SELECT [DELETE] FROM t").is_empty());
    }

    #[test]
    fn module_bodies_are_definitions() {
        assert!(kinds("CREATE PROCEDURE dbo.p AS DELETE FROM dbo.T").is_empty());
        assert!(
            kinds("CREATE OR ALTER TRIGGER tr ON t AFTER INSERT AS UPDATE t SET x = 1").is_empty()
        );
        // ...but only in their own batch.
        assert_eq!(
            kinds("CREATE PROCEDURE dbo.p AS SELECT 1\nGO\nDELETE FROM dbo.T"),
            [(DeleteWithoutWhere, "dbo.T".into(), 3)]
        );
    }

    #[test]
    fn permissions_on_modules_are_not_module_definitions() {
        assert_eq!(
            kinds(
                "REVOKE CREATE VIEW FROM public;\nDELETE FROM dbo.Orders;\nDROP TABLE dbo.Customers;"
            ),
            [
                (DeleteWithoutWhere, "dbo.Orders".into(), 2),
                (Drop, "dbo.Customers".into(), 3)
            ]
        );
        assert_eq!(
            kinds("GRANT CREATE PROCEDURE TO [nobody];\nDELETE FROM dbo.Orders"),
            [(DeleteWithoutWhere, "dbo.Orders".into(), 2)]
        );
        assert_eq!(
            kinds("DENY CREATE FUNCTION TO [nobody]; TRUNCATE TABLE dbo.Log"),
            [(Truncate, "dbo.Log".into(), 1)]
        );
    }

    #[test]
    fn an_alter_table_ends_where_the_next_statement_starts() {
        assert_eq!(
            kinds(
                "CREATE TABLE #t (x int)\nALTER TABLE #t ADD y int\nDROP TABLE dbo.Customers\nALTER TABLE dbo.Orders DROP COLUMN Total"
            ),
            [
                (Drop, "dbo.Customers".into(), 3),
                (AlterTable, "dbo.Orders".into(), 4)
            ]
        );
        assert_eq!(
            kinds("ALTER TABLE dbo.T ADD y int\nDROP TABLE dbo.Customers"),
            [
                (AlterTable, "dbo.T".into(), 1),
                (Drop, "dbo.Customers".into(), 2)
            ]
        );
        // Its own clauses stay part of it.
        assert_eq!(
            kinds(
                "ALTER TABLE dbo.T WITH CHECK ADD CONSTRAINT ck CHECK (x > 0)\nALTER TABLE dbo.T ALTER COLUMN x bigint\nALTER TABLE dbo.T DROP CONSTRAINT ck, COLUMN y\nALTER TABLE dbo.T SET (LOCK_ESCALATION = TABLE)"
            ),
            [
                (AlterTable, "dbo.T".into(), 1),
                (AlterTable, "dbo.T".into(), 2),
                (AlterTable, "dbo.T".into(), 3),
                (AlterTable, "dbo.T".into(), 4)
            ]
        );
        assert_eq!(
            kinds("ALTER TABLE #t DROP COLUMN x\nSET NOCOUNT ON\nDELETE FROM dbo.Log").len(),
            1
        );
    }

    #[test]
    fn lines_count_from_the_editor() {
        let result = check("SELECT 1\nGO\n\nDELETE FROM t", 9);
        assert_eq!(result.findings[0].line, 13);
    }

    #[test]
    fn unterminated_text_is_uncertain() {
        assert!(check("SELECT 'oops", 0).uncertain);
        assert!(check("/* never closed", 0).needs_confirmation());
        assert!(!check("SELECT 1", 0).needs_confirmation());
    }
}
