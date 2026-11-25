//! SQLCMD editor preprocessing. File access requires separate consent before
//! includes are snapshotted; executing the expanded script needs final approval.
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLine {
    pub file: Option<String>,
    pub line: u32,
}
#[derive(Clone)]
pub enum Step {
    Sql {
        sql: String,
        lines: Vec<SourceLine>,
        repeat: u32,
    },
    Connect {
        server: String,
        user: Option<String>,
        password: Option<String>,
        timeout: Option<u32>,
    },
    Shell(String),
    Output {
        path: String,
        error: bool,
    },
    OnError {
        exit: bool,
    },
    Quit,
    Exit(String),
}
#[derive(Clone)]
pub struct Script {
    pub steps: Vec<Step>,
}

#[derive(Debug, thiserror::Error)]
pub enum PrepareError {
    #[error("Allow SQLCMD include file access before preparing this script.")]
    FileAccessRequired,
    #[error("{0}")]
    Invalid(String),
}

impl From<String> for PrepareError {
    fn from(message: String) -> Self {
        Self::Invalid(message)
    }
}

impl From<&str> for PrepareError {
    fn from(message: &str) -> Self {
        Self::Invalid(message.into())
    }
}
#[derive(Default)]
struct Lexer {
    quote: bool,
    bracket: bool,
    double: bool,
    comment: u32,
}
impl Lexer {
    fn clear(&self) -> bool {
        !self.quote && !self.bracket && !self.double && self.comment == 0
    }
    fn feed(&mut self, line: &str) {
        let bytes = line.as_bytes();
        let mut i = 0;
        while i < bytes.len() {
            let a = bytes[i];
            let b = bytes.get(i + 1).copied();
            if self.comment > 0 {
                if a == b'/' && b == Some(b'*') {
                    self.comment += 1;
                    i += 2;
                } else if a == b'*' && b == Some(b'/') {
                    self.comment -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
                continue;
            }
            if self.quote {
                if a == b'\'' {
                    if b == Some(b'\'') {
                        i += 2;
                        continue;
                    }
                    self.quote = false;
                }
                i += 1;
                continue;
            }
            if self.bracket {
                if a == b']' {
                    if b == Some(b']') {
                        i += 2;
                        continue;
                    }
                    self.bracket = false;
                }
                i += 1;
                continue;
            }
            if self.double {
                if a == b'"' {
                    if b == Some(b'"') {
                        i += 2;
                        continue;
                    }
                    self.double = false;
                }
                i += 1;
                continue;
            }
            if a == b'-' && b == Some(b'-') {
                break;
            }
            if a == b'/' && b == Some(b'*') {
                self.comment = 1;
                i += 2;
                continue;
            }
            if a == b'\'' {
                self.quote = true;
            }
            if a == b'[' {
                self.bracket = true;
            }
            if a == b'"' {
                self.double = true;
            }
            i += 1;
        }
    }
}
const MAX_EXPANDED_BYTES: usize = 8 * 1024 * 1024;

struct Parser {
    steps: Vec<Step>,
    variables: HashMap<String, String>,
    sql: String,
    lines: Vec<SourceLine>,
    lexer: Lexer,
    stack: Vec<PathBuf>,
    bytes: usize,
    allow_file_reads: bool,
}
impl Parser {
    fn account_bytes(&mut self, added: usize) -> Result<(), PrepareError> {
        self.bytes = self.bytes.saturating_add(added);
        if self.bytes > MAX_EXPANDED_BYTES {
            return Err("Expanded SQLCMD script exceeds 8 MB.".into());
        }
        Ok(())
    }
    fn flush(&mut self, repeat: u32) {
        if !self.sql.trim().is_empty() && repeat > 0 {
            self.steps.push(Step::Sql {
                sql: std::mem::take(&mut self.sql),
                lines: std::mem::take(&mut self.lines),
                repeat,
            });
        } else {
            self.sql.clear();
            self.lines.clear();
        }
    }
    fn expand(&self, text: &str) -> Result<String, PrepareError> {
        let budget = MAX_EXPANDED_BYTES.saturating_sub(self.bytes);
        let mut output = String::new();
        let mut rest = text;
        while let Some(index) = rest.find("$(") {
            let prefix = &rest[..index];
            if output.len().saturating_add(prefix.len()) > budget {
                return Err("Expanded SQLCMD script exceeds 8 MB.".into());
            }
            output.push_str(prefix);
            let value = &rest[index + 2..];
            let end = value
                .find(')')
                .ok_or_else(|| PrepareError::Invalid("Unterminated SQLCMD variable.".into()))?;
            let name = &value[..end];
            let replacement = self
                .variables
                .get(name)
                .cloned()
                .or_else(|| std::env::var(name).ok())
                .ok_or_else(|| {
                    PrepareError::Invalid(format!("SQLCMD variable {name} is not defined."))
                })?;
            if output.len().saturating_add(replacement.len()) > budget {
                return Err("Expanded SQLCMD script exceeds 8 MB.".into());
            }
            output.push_str(&replacement);
            rest = &value[end + 1..];
        }
        if output.len().saturating_add(rest.len()) > budget {
            return Err("Expanded SQLCMD script exceeds 8 MB.".into());
        }
        output.push_str(rest);
        Ok(output)
    }
    fn parse(
        &mut self,
        text: &str,
        file: Option<&Path>,
        base_line: u32,
    ) -> Result<(), PrepareError> {
        self.account_bytes(text.len())?;
        for (index, line) in text.lines().enumerate() {
            let trim = line.trim();
            if self.lexer.clear() && !trim.starts_with("--") {
                let expanded = self.expand(trim)?;
                let trimmed = expanded.trim();
                if let Some(repeat) = go_repeat(trimmed)? {
                    self.flush(repeat);
                    continue;
                }
                let head = trimmed
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let tail = trimmed.get(head.len()..).unwrap_or("").trim();
                if head == ":setvar" {
                    let tokens = words(tail)?;
                    if tokens.len() < 1 || tokens.len() > 2 {
                        return Err("Use :setvar name \"value\".".into());
                    }
                    if tokens.len() == 1 {
                        self.variables.remove(&tokens[0]);
                    } else {
                        self.account_bytes(tokens[1].len())?;
                        self.variables.insert(tokens[0].clone(), tokens[1].clone());
                    }
                    continue;
                }
                if head == ":r" {
                    // Even resolving a UNC path or a local junction may contact a
                    // remote host using the Windows user's identity.
                    if !self.allow_file_reads {
                        return Err(PrepareError::FileAccessRequired);
                    }
                    let tokens = words(tail)?;
                    if tokens.len() != 1 {
                        return Err("Use :r \"filename\".".into());
                    }
                    let path = PathBuf::from(&tokens[0]);
                    let path = if path.is_absolute() {
                        path
                    } else {
                        file.and_then(Path::parent)
                            .unwrap_or(Path::new("."))
                            .join(path)
                    };
                    let path = path
                        .canonicalize()
                        .map_err(|e| format!("Cannot include {}: {e}", path.display()))?;
                    if self.stack.len() >= 16 || self.stack.contains(&path) {
                        return Err("Recursive or excessively nested SQLCMD include.".into());
                    }
                    let contents = crate::files::read_script(&path).map_err(|e| e.to_string())?;
                    self.stack.push(path.clone());
                    self.parse(&contents, Some(&path), 0)?;
                    self.stack.pop();
                    continue;
                }
                if trimmed.starts_with("!!") {
                    self.flush(1);
                    self.steps.push(Step::Shell(trimmed[2..].trim().into()));
                    continue;
                }
                if trimmed.starts_with(":!!") {
                    self.flush(1);
                    self.steps.push(Step::Shell(trimmed[3..].trim().into()));
                    continue;
                }
                if head.starts_with(':') {
                    self.flush(1);
                    match head.as_str() {
                        ":connect" => {
                            let tokens = words(tail)?;
                            if tokens.is_empty() {
                                return Err("A SQLCMD server is required.".into());
                            }
                            let mut user = None;
                            let mut password = None;
                            let mut timeout = None;
                            let mut i = 1;
                            while i < tokens.len() {
                                let value = tokens
                                    .get(i + 1)
                                    .ok_or("Missing :connect option value.")?
                                    .clone();
                                match tokens[i].as_str() {
                                    "-U" => user = Some(value),
                                    "-P" => password = Some(value),
                                    "-l" => {
                                        timeout = Some(
                                            value
                                                .parse()
                                                .map_err(|_| "Invalid connection timeout.")?,
                                        )
                                    }
                                    _ => return Err("Unsupported :connect option.".into()),
                                }
                                i += 2;
                            }
                            self.steps.push(Step::Connect {
                                server: tokens[0].clone(),
                                user,
                                password,
                                timeout,
                            });
                        }
                        ":on" => {
                            let tokens = words(tail)?;
                            if tokens.len() != 2
                                || !tokens[0].eq_ignore_ascii_case("error")
                                || !["ignore", "exit"]
                                    .iter()
                                    .any(|v| tokens[1].eq_ignore_ascii_case(v))
                            {
                                return Err("Use :on error ignore|exit.".into());
                            }
                            self.steps.push(Step::OnError {
                                exit: tokens[1].eq_ignore_ascii_case("exit"),
                            });
                        }
                        ":out" | ":error" => {
                            let tokens = words(tail)?;
                            if tokens.len() != 1 {
                                return Err(
                                    "Output redirection requires one path or stdout/stderr.".into(),
                                );
                            }
                            self.steps.push(Step::Output {
                                path: tokens[0].clone(),
                                error: head == ":error",
                            });
                        }
                        ":quit" => self.steps.push(Step::Quit),
                        _ if head.starts_with(":exit(") || head == ":exit" => {
                            let arg = trimmed[5..].trim();
                            let inner = arg
                                .strip_prefix('(')
                                .and_then(|s| s.strip_suffix(')'))
                                .unwrap_or(arg)
                                .trim();
                            self.steps.push(Step::Exit(inner.to_string()));
                        }
                        _ => {
                            return Err(format!(
                                "Unsupported SQLCMD command {head}. Nothing was executed."
                            )
                            .into());
                        }
                    }
                    continue;
                }
            }
            let expanded = self.expand(line)?;
            if expanded.len() > line.len() {
                self.account_bytes(expanded.len() - line.len())?;
            }
            let source = SourceLine {
                // Only :r includes name a file; the editor's own lines, saved
                // or not, are editor lines that a message can jump to.
                file: (!self.stack.is_empty())
                    .then(|| file.map(|f| f.display().to_string()))
                    .flatten(),
                line: base_line + index as u32 + 1,
            };
            for expanded_line in expanded.split('\n') {
                let expanded_line = expanded_line.strip_suffix('\r').unwrap_or(expanded_line);
                if self.lexer.clear()
                    && !expanded_line.trim().starts_with("--")
                    && let Some(repeat) = go_repeat(expanded_line.trim())?
                {
                    self.flush(repeat);
                    continue;
                }
                self.lexer.feed(expanded_line);
                self.sql.push_str(expanded_line);
                self.sql.push('\n');
                self.lines.push(source.clone());
            }
        }
        Ok(())
    }
}

fn go_repeat(trimmed: &str) -> Result<Option<u32>, PrepareError> {
    let head = trimmed
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    if head != "go" && head != "!!:go" {
        return Ok(None);
    }
    let tail = trimmed.get(head.len()..).unwrap_or("").trim();
    let count = tail.split("--").next().unwrap_or("").trim();
    if count.is_empty() {
        return Ok(Some(1));
    }
    if count.bytes().all(|b| b.is_ascii_digit()) {
        let repeat = count
            .parse::<u32>()
            .map_err(|_| PrepareError::Invalid("GO repeats are limited to 1000.".into()))?;
        if repeat > 1000 {
            return Err("GO repeats are limited to 1000.".into());
        }
        return Ok(Some(repeat));
    }
    if head == "!!:go" {
        return Err("Invalid GO repeat count.".into());
    }
    Ok(None)
}
fn words(text: &str) -> Result<Vec<String>, String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut quoted = false;
    let mut present = false;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            present = true;
            if quoted && chars.peek() == Some(&'"') {
                word.push('"');
                chars.next();
            } else {
                quoted = !quoted;
            }
        } else if c.is_whitespace() && !quoted {
            if present {
                words.push(std::mem::take(&mut word));
                present = false;
            }
        } else {
            word.push(c);
            present = true;
        }
    }
    if quoted {
        return Err("Unterminated quoted SQLCMD argument.".into());
    }
    if present {
        words.push(word);
    }
    Ok(words)
}
/// Prepares a script without filesystem access unless the caller has obtained
/// explicit consent for reading its includes, including nested/network paths.
pub fn prepare(
    text: &str,
    file: Option<&Path>,
    base_line: u32,
    allow_file_reads: bool,
) -> Result<Script, PrepareError> {
    let mut parser = Parser {
        steps: Vec::new(),
        variables: HashMap::new(),
        sql: String::new(),
        lines: Vec::new(),
        lexer: Lexer::default(),
        stack: Vec::new(),
        bytes: 0,
        allow_file_reads,
    };
    // The editor file is only a base path. Do not canonicalize it here:
    // that would access the filesystem before include consent, even without :r.
    parser.parse(text, file, base_line)?;
    parser.flush(1);
    Ok(Script {
        steps: parser.steps,
    })
}
impl Script {
    pub fn preview(&self) -> String {
        self.steps
            .iter()
            .map(|step| match step {
                Step::Sql { sql, repeat, .. } => format!("{sql}GO {repeat}"),
                Step::Connect { server, .. } => format!(":connect {server} (credentials hidden)"),
                Step::Shell(command) => format!("!! {command}"),
                Step::Output { path, error } => {
                    format!(":{} {path}", if *error { "error" } else { "out" })
                }
                Step::OnError { exit } => {
                    format!(":on error {}", if *exit { "exit" } else { "ignore" })
                }
                Step::Quit => ":quit".into(),
                Step::Exit(sql) => format!(":exit({sql})"),
            })
            .collect::<Vec<_>>()
            .join("\n")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn commands_in_multiline_comments_are_not_executed() {
        let script = prepare("/*\n!! del x\n*/\nSELECT 1", None, 0, false).unwrap();
        assert_eq!(script.steps.len(), 1);
        assert!(matches!(&script.steps[0],Step::Sql{sql,..} if sql.contains("!! del")));
    }
    #[test]
    fn variables_and_original_lines() {
        let script = prepare(
            ":setvar name \"Some DB\"\nSELECT '$(name)';\nGO 2",
            None,
            4,
            false,
        )
        .unwrap();
        assert!(
            matches!(&script.steps[0],Step::Sql{sql,lines,repeat:2} if sql.contains("Some DB") && lines[0].line==6)
        );
    }
    #[test]
    fn refuses_missing_variables_before_execution() {
        assert!(prepare("SELECT '$(missing)'", None, 0, false).is_err());
    }
    #[test]
    fn recognizes_output_and_os_commands() {
        let script = prepare(
            ":out \"C:\\folder name\\out.txt\"\n!! dir\n:on error exit",
            None,
            0,
            false,
        )
        .unwrap();
        assert_eq!(script.steps.len(), 3);
    }
    #[test]
    fn preview_hides_connect_password() {
        let script = prepare(":connect localhost -U sa -P secret", None, 0, false).unwrap();
        assert!(!script.preview().contains("secret"));
    }

    #[test]
    fn includes_require_consent_before_any_path_resolution() {
        for text in [
            ":r missing-include.sql",
            r#":r "\\quervio-audit.invalid\share\include.sql""#,
            r#":r "\\?\UNC\quervio-audit.invalid\share\include.sql""#,
            ":setvar directive \":r\"\n$(directive) missing-include.sql",
        ] {
            assert!(matches!(
                prepare(text, None, 0, false),
                Err(PrepareError::FileAccessRequired)
            ));
        }
    }

    #[test]
    fn commented_includes_and_remote_editor_paths_do_not_require_file_access() {
        let script = prepare(
            "/*\n:r missing.sql\n*/\nSELECT 1;",
            Some(Path::new(r"\\quervio-audit.invalid\share\editor.sql")),
            0,
            false,
        )
        .unwrap();
        assert_eq!(script.steps.len(), 1);
    }

    #[test]
    fn authorized_nested_includes_are_snapshotted_and_cycles_rejected() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("root.sql");
        let child = dir.path().join("child.sql");
        let nested = dir.path().join("nested.sql");
        std::fs::write(&child, ":r nested.sql").unwrap();
        std::fs::write(&nested, "SELECT 1;").unwrap();
        let script = prepare(":r child.sql", Some(&root), 0, true).unwrap();
        std::fs::write(&nested, "SELECT 2;").unwrap();
        assert!(script.preview().contains("SELECT 1;"));
        std::fs::write(&nested, ":r child.sql").unwrap();
        assert!(prepare(":r child.sql", Some(&root), 0, true).is_err());
    }

    #[test]
    fn exponential_setvar_expansion_is_capped_at_8mb() {
        let mut bomb = String::from(
            ":setvar v0 \"0123456789012345678901234567890123456789012345678901234567890123\"\n",
        );
        for i in 1..=18 {
            bomb.push_str(&format!(":setvar v{i} \"$(v{p})$(v{p})\"\n", p = i - 1));
        }
        bomb.push_str("SELECT '$(v18)';\n");
        let err = prepare(&bomb, None, 0, false).err().expect("must fail");
        assert!(err.to_string().contains("8 MB"), "{err}");
    }

    #[test]
    fn exit_preserves_inner_parentheses_and_shell_works_without_space() {
        let exit = prepare(":exit(SELECT (1 + 2))", None, 0, false).unwrap();
        assert!(matches!(&exit.steps[0], Step::Exit(sql) if sql == "SELECT (1 + 2)"));

        let shell = prepare("!!whoami\n:!!hostname", None, 0, false).unwrap();
        assert!(matches!(&shell.steps[0], Step::Shell(cmd) if cmd == "whoami"));
        assert!(matches!(&shell.steps[1], Step::Shell(cmd) if cmd == "hostname"));
    }

    #[test]
    fn go_identifier_go_zero_and_signed_go_match_batch_semantics() {
        let go_col = prepare("SELECT\n  go AS alias\nFROM dbo.T", None, 0, false).unwrap();
        assert_eq!(go_col.steps.len(), 1);
        assert!(matches!(&go_col.steps[0], Step::Sql { sql, repeat: 1, .. } if sql.contains("go AS alias")));

        let go_zero = prepare("SELECT 1\nGO 0\nSELECT 2", None, 0, false).unwrap();
        assert_eq!(go_zero.steps.len(), 1);
        assert!(matches!(&go_zero.steps[0], Step::Sql { sql, repeat: 1, .. } if sql.trim() == "SELECT 2"));

        let go_signed = prepare("SELECT 1\nGO +2", None, 0, false).unwrap();
        assert_eq!(go_signed.steps.len(), 1);
        assert!(matches!(&go_signed.steps[0], Step::Sql { sql, repeat: 1, .. } if sql.contains("GO +2")));
    }

    #[test]
    fn multiline_variable_expansion_keeps_line_map_and_splits_go() {
        let var = "QUERVIO_TEST_SQLCMD_MULTILINE";
        // SAFETY: unique env var name used only by this test.
        unsafe { std::env::set_var(var, "1\nGO\nSELECT 2") };
        let script = prepare(&format!("SELECT $({var})\nSELECT 3"), None, 0, false).unwrap();
        unsafe { std::env::remove_var(var) };
        assert_eq!(script.steps.len(), 2);
        for step in &script.steps {
            let Step::Sql { sql, lines, .. } = step else {
                panic!("expected Sql step");
            };
            assert_eq!(sql.lines().count(), lines.len());
            assert_eq!(crate::batch::split(sql).len(), 1);
        }
    }
}
