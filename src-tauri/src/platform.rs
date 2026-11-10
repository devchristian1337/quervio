//! Names and commands that differ between the supported desktop platforms.
#[cfg(windows)]
use std::path::PathBuf;

pub const BRIDGE: &str = if cfg!(windows) {
    "Quervio.MicrosoftBridge.exe"
} else {
    "Quervio.MicrosoftBridge"
};

pub const SQLTOOLS: &[&str] = if cfg!(windows) {
    &["MicrosoftSqlToolsServiceLayer.exe", "Microsoft.SqlTools.ServiceLayer.exe"]
} else {
    &["MicrosoftSqlToolsServiceLayer", "Microsoft.SqlTools.ServiceLayer"]
};

pub fn microsoft_resources() -> &'static str {
    if cfg!(target_os = "linux") { "resources/linux/microsoft" } else { "resources/microsoft" }
}

pub fn local_shell(text: &str) -> tokio::process::Command {
    #[cfg(windows)]
    let mut command = {
        let root = std::env::var_os("SystemRoot").map(PathBuf::from)
            .unwrap_or_else(|| r"C:\Windows".into());
        // cmd.exe parses its own command line and misreads argv[0] when it
        // contains a forward slash. Build the path with native separators.
        let mut command = tokio::process::Command::new(root.join("System32").join("cmd.exe"));
        // cmd.exe reads its command line itself. Passed as an argument, the
        // text would be quoted for CommandLineToArgvW and every `"` would
        // become `\"`, which cmd.exe does not undo. With /S it removes only
        // the outer quotes added here and runs the rest exactly as written.
        command.args(["/D", "/S", "/C"]).raw_arg(format!("\"{text}\""));
        command
    };
    #[cfg(not(windows))]
    let mut command = {
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", text]);
        command
    };
    crate::processes::configure(&mut command);
    command
}

pub fn component_name(kind: &str, path: &std::path::Path) -> bool {
    let name = path.file_name().and_then(|name| name.to_str());
    match kind {
        "bridge" => name == Some(BRIDGE),
        "language" => name.is_some_and(|name| SQLTOOLS.contains(&name)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn local_shell_executes_and_reports_failure() {
        let result = super::local_shell("echo quervio-shell").output().await.unwrap();
        assert!(result.status.success(), "status={} stderr={}", result.status, String::from_utf8_lossy(&result.stderr));
        assert!(String::from_utf8_lossy(&result.stdout).contains("quervio-shell"));
        assert!(!super::local_shell("exit 7").status().await.unwrap().success());
    }

    #[tokio::test]
    async fn local_shell_runs_quotes_as_written() {
        // The previewed SQLCMD `!!` text is what runs: quotes stay quotes.
        let result = super::local_shell(r#"echo "quervio shell""#).output().await.unwrap();
        assert!(result.status.success());
        let text = String::from_utf8_lossy(&result.stdout);
        assert!(!text.contains('\\'), "{text}");
        assert!(text.contains("quervio shell"), "{text}");
    }
}
