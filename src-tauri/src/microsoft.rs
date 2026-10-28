//! One-shot Microsoft operations. Credentials travel over stdin, never command arguments.
use crate::{
    explorer::{CommandResult, ExplorerState, message},
    management::{BridgeRequest, Progress},
};
use serde_json::{Value, json};
use std::process::Stdio;
use tauri::ipc::Channel;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::Command,
};

pub fn is_write(action: &str) -> bool {
    matches!(
        action,
        "import"
            | "dacPublish"
            | "bacpacImport"
            | "azureRestore"
            | "azureRetention"
            | "columnEncryption"
            | "createColumnKeys"
            | "rotateMasterKey"
            | "encryptedQuery"
    )
}

pub async fn access_token(data_dir: &std::path::Path) -> CommandResult<(String, u64)> {
    let selected = data_dir.join("components/bridge.json");
    let mut paths = Vec::new();
    if let Ok(bytes) = std::fs::read(selected) {
        if let Ok(path) = serde_json::from_slice::<std::path::PathBuf>(&bytes) {
            paths.push(path);
        }
    }
    if let Some(path) = std::env::var_os("QUERVIO_MICROSOFT_BRIDGE") {
        paths.push(path.into());
    }
    if let Ok(executable) = std::env::current_exe() {
        if let Some(dir) = executable.parent() {
            paths.push(dir.join("microsoft/Quervio.MicrosoftBridge.exe"));
        }
    }
    paths.push(
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/microsoft/Quervio.MicrosoftBridge.exe"),
    );
    let path=paths.into_iter().find(|p|p.is_file()).ok_or("Microsoft Entra authentication requires the Microsoft bridge. Open Tools > Microsoft Components.")?;
    let mut command = Command::new(path);
    command
        .arg("--access-token")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let child = command.spawn().map_err(message)?;
    let _registration =
        crate::processes::Registration::new(child.id().ok_or("Entra process ID is missing.")?);
    let output = tokio::time::timeout(
        std::time::Duration::from_secs(180),
        child.wait_with_output(),
    )
    .await
    .map_err(|_| "Microsoft Entra sign-in timed out.")?
    .map_err(message)?;
    let value: Value = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Invalid Microsoft Entra provider response.")?;
    if !output.status.success() {
        return Err(value["message"]
            .as_str()
            .unwrap_or("Microsoft Entra sign-in failed.")
            .into());
    }
    let token = value["accessToken"]
        .as_str()
        .ok_or("Microsoft Entra did not return an access token.")?
        .to_string();
    let expires = value["expiresOn"]
        .as_u64()
        .ok_or("Microsoft Entra token expiry is missing.")?;
    Ok((token, expires))
}

pub async fn run(
    app: &tauri::AppHandle,
    explorer: &ExplorerState,
    id: &str,
    database: Option<String>,
    request: BridgeRequest,
    on_event: Channel<Progress>,
    cancel: quervio_core::execution::CancelToken,
) -> CommandResult<Value> {
    let read_only = matches!(
        request.action.as_str(),
        "script"
            | "dacPreview"
            | "importPreview"
            | "export"
            | "extract"
            | "bacpacExport"
            | "azureList"
            | "azureBackups"
            | "version"
    );
    let known = read_only
        || matches!(
            request.action.as_str(),
            "import"
                | "dacPublish"
                | "bacpacImport"
                | "azureRestore"
                | "azureRetention"
                | "columnEncryption"
                | "createColumnKeys"
                | "rotateMasterKey"
                | "encryptedQuery"
        );
    if !known {
        return Err("Unknown Microsoft operation.".into());
    }
    if !read_only && !request.confirmed {
        return Err("Confirm the Microsoft operation before executing it.".into());
    }
    let path = crate::management::selected_component(app, "bridge")
        .or_else(|| crate::management::bridge_path(app))
        .ok_or("The Microsoft bridge is not configured. Open Tools > Components.")?;
    let mut connection = explorer.connection(id)?;
    if let Some(db) = database {
        connection.default_database = Some(db);
    }
    let password = explorer.password(id, None)?;
    let input = json!({"connection":connection,"password":password,"action":request.action,"arguments":request.arguments,"confirmed":request.confirmed});
    let mut command = Command::new(path);
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = command.spawn().map_err(message)?;
    let _registration =
        crate::processes::Registration::new(child.id().ok_or("Microsoft process ID is missing.")?);
    let mut stdin = child.stdin.take().ok_or("Bridge stdin unavailable")?;
    stdin
        .write_all(&serde_json::to_vec(&input).map_err(message)?)
        .await
        .map_err(message)?;
    stdin.write_all(b"\n").await.map_err(message)?;
    drop(stdin);
    let mut lines = BufReader::new(child.stdout.take().ok_or("Bridge stdout unavailable")?).lines();
    let mut output = None;
    loop {
        let line = tokio::select! {line=lines.next_line()=>line.map_err(message)?,_=tokio::time::sleep(std::time::Duration::from_millis(200))=>{if cancel.is_cancelled(){if let Some(pid)=child.id(){crate::processes::terminate_tree(pid).await;}let _=child.kill().await;let _=child.wait().await;return Err("Microsoft operation cancelled. Server and Azure changes may remain or continue.".into());}continue;}};
        let Some(line) = line else {
            break;
        };
        let event: Value =
            serde_json::from_str(&line).map_err(|_| "Invalid Microsoft bridge response.")?;
        match event["type"].as_str() {
            Some("progress") => {
                let _ = on_event.send(Progress {
                    phase: event["phase"].as_str().unwrap_or("running").into(),
                    message: event["message"].as_str().unwrap_or("").into(),
                    completed: event["completed"].as_u64(),
                });
            }
            Some("result") => output = Some(Ok(event["value"].clone())),
            Some("error") => {
                output = Some(Err(event["message"]
                    .as_str()
                    .unwrap_or("Microsoft operation failed.")
                    .to_string()))
            }
            _ => {}
        }
    }
    let status = child.wait().await.map_err(message)?;
    match output {
        Some(result) => result,
        None => Err(format!(
            "Microsoft bridge exited without a result ({status})."
        )),
    }
}
