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
    fn flush(&mut self, repeat: u32) {
        if !self.sql.trim().is_empty() {
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
    fn expand(&self, text: &str) -> Result<String, String> {
        let mut output = String::new();
        let mut rest = text;
        while let Some(index) = rest.find("$(") {
            output.push_str(&rest[..index]);
            let value = &rest[index + 2..];
            let end = value.find(')').ok_or("Unterminated SQLCMD variable.")?;
            let name = &value[..end];
            let replacement = self
                .variables
                .get(name)
                .cloned()
                .or_else(|| std::env::var(name).ok())
                .ok_or_else(|| format!("SQLCMD variable {name} is not defined."))?;
            output.push_str(&replacement);
            rest = &value[end + 1..];
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
        self.bytes += text.len();
        if self.bytes > 8 * 1024 * 1024 {
            return Err("Expanded SQLCMD script exceeds 8 MB.".into());
        }
        for (index, line) in text.lines().enumerate() {
            let trim = line.trim();
            if self.lexer.clear() && !trim.starts_with("--") {
                let expanded = self.expand(trim)?;
                let trimmed = expanded.trim();
                let head = trimmed
                    .split_whitespace()
                    .next()
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let tail = trimmed.get(head.len()..).unwrap_or("").trim();
                if head == "go" || head == "!!:go" {
                    let count = tail.split("--").next().unwrap_or("").trim();
                    let repeat = if count.is_empty() {
                        1
                    } else {
                        count
                            .parse::<u32>()
                            .map_err(|_| "Invalid GO repeat count.")?
                    };
                    if repeat > 1000 {
                        return Err("GO repeats are limited to 1000.".into());
                    }
                    self.flush(repeat);
                    continue;
                }
                if head == ":setvar" {
                    let tokens = words(tail)?;
                    if tokens.len() < 1 || tokens.len() > 2 {
                        return Err("Use :setvar name \"value\".".into());
                    }
                    if tokens.len() == 1 {
                        self.variables.remove(&tokens[0]);
                    } else {
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
                if head.starts_with(':') || head == "!!" {
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
                        "!!" | ":!!" => self.steps.push(Step::Shell(tail.into())),
                        ":quit" => self.steps.push(Step::Quit),
                        _ if head.starts_with(":exit(") || head == ":exit" => {
                            self.steps.push(Step::Exit(
                                trimmed[5..]
                                    .trim()
                                    .trim_start_matches('(')
                                    .trim_end_matches(')')
                                    .to_string(),
                            ))
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
            self.lexer.feed(&expanded);
            self.sql.push_str(&expanded);
            self.sql.push('\n');
            self.lines.push(SourceLine {
                file: file.map(|f| f.display().to_string()),
                line: base_line + index as u32 + 1,
            });
        }
        Ok(())
    }
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
}
