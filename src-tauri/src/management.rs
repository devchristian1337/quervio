//! Administrative work uses separate Sessions and single-use, target-bound previews.
use crate::explorer::{CommandResult, ExplorerState, message};
use quervio_core::{
    management::{self, DataTable, Resource, ServerCapabilities},
    session::Session,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant},
};
use tauri::{Manager, State, ipc::Channel};

struct Pending {
    session: Session,
    script: String,
    created: Instant,
}
struct BridgePending {
    id: String,
    database: Option<String>,
    action: String,
    arguments: serde_json::Value,
    connection: serde_json::Value,
    created: Instant,
}
#[derive(Default)]
pub struct ManagementState {
    pending: Mutex<HashMap<String, Pending>>,
    bridge: Mutex<HashMap<String, BridgePending>>,
    running: Mutex<HashMap<String, quervio_core::execution::CancelToken>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    token: String,
    server: String,
    database: String,
    script: String,
    expires_in_seconds: u32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: String,
    pub message: String,
    pub completed: Option<u64>,
}

pub(crate) async fn session(
    explorer: &ExplorerState,
    id: &str,
    database: Option<&str>,
) -> CommandResult<Session> {
    let mut connection = explorer.connection(id)?;
    if let Some(db) = database {
        connection.default_database = Some(db.into());
    }
    let password = explorer.credential(&connection, None).await?;
    Session::open(&connection, password, "Quervio - Management")
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn management_capabilities(
    explorer: State<'_, ExplorerState>,
    id: String,
    database: Option<String>,
) -> CommandResult<ServerCapabilities> {
    let mut session = session(&explorer, &id, database.as_deref()).await?;
    let result = management::capabilities(&mut session)
        .await
        .map_err(message);
    let _ = session.close().await;
    result
}

#[tauri::command]
pub async fn management_read(
    explorer: State<'_, ExplorerState>,
    id: String,
    database: Option<String>,
    resource: Resource,
) -> CommandResult<DataTable> {
    let mut session = session(&explorer, &id, database.as_deref()).await?;
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        management::read(&mut session, resource),
    )
    .await;
    // Dropping the Session on timeout terminates work; no shared editor lock.
    match result {
        Ok(result) => {
            let _ = session.close().await;
            result.map_err(message)
        }
        Err(_) => Err("Management read timed out after 30 seconds.".into()),
    }
}

#[tauri::command]
pub async fn management_prepare(
    explorer: State<'_, ExplorerState>,
    state: State<'_, ManagementState>,
    id: String,
    database: Option<String>,
    script: String,
) -> CommandResult<Preview> {
    if script.trim().is_empty() {
        return Err("There is no operation to preview.".into());
    }
    if script.len() > 8 * 1024 * 1024 {
        return Err("The administrative script exceeds 8 MB.".into());
    }
    let mut session = session(&explorer, &id, database.as_deref()).await?;
    let info = session.server_info().await.map_err(message)?;
    let token = uuid::Uuid::new_v4().to_string();
    let preview = Preview {
        token: token.clone(),
        server: info.server_name,
        database: info.database,
        script: script.clone(),
        expires_in_seconds: 300,
    };
    let mut pending = state.pending.lock().unwrap();
    pending.retain(|_, p| p.created.elapsed() < Duration::from_secs(300));
    if pending.len() >= 16 {
        return Err("Close an existing operation preview before preparing another.".into());
    }
    pending.insert(
        token,
        Pending {
            session,
            script,
            created: Instant::now(),
        },
    );
    Ok(preview)
}

#[tauri::command]
pub fn management_discard(state: State<'_, ManagementState>, token: String) {
    state.pending.lock().unwrap().remove(&token);
    state.bridge.lock().unwrap().remove(&token);
}

#[tauri::command]
pub async fn management_apply(
    state: State<'_, ManagementState>,
    token: String,
    confirmed: bool,
    on_event: Channel<Progress>,
) -> CommandResult<Vec<String>> {
    if !confirmed {
        return Err("The operation has not been confirmed; nothing was run.".into());
    }
    let mut pending = state
        .pending
        .lock()
        .unwrap()
        .remove(&token)
        .ok_or("The operation preview is missing or already used.")?;
    if pending.created.elapsed() >= Duration::from_secs(300) {
        return Err("The preview expired. Prepare it again.".into());
    }
    let _ = on_event.send(Progress {
        phase: "running".into(),
        message: "Executing the confirmed script on the previewed Session.".into(),
        completed: None,
    });
    let cancel = quervio_core::execution::CancelToken::new();
    state
        .running
        .lock()
        .unwrap()
        .insert(token.clone(), cancel.clone());
    let mut messages = Vec::new();
    let result = pending
        .session
        .command_controlled(&pending.script, &cancel, |text| {
            messages.push(text.clone());
            let _ = on_event.send(Progress {
                phase: "running".into(),
                message: text,
                completed: None,
            });
        })
        .await
        .map(|_| messages)
        .map_err(message);
    state.running.lock().unwrap().remove(&token);
    let _ = pending.session.close().await;
    let _ = on_event.send(Progress {
        phase: if result.is_ok() {
            "completed"
        } else {
            "failed"
        }
        .into(),
        message: if result.is_ok() {
            "Operation completed."
        } else {
            "Operation failed; subsequent batches were not submitted."
        }
        .into(),
        completed: None,
    });
    result
}

#[tauri::command]
pub fn management_cancel(state: State<'_, ManagementState>, token: String) -> CommandResult<()> {
    let running = state.running.lock().unwrap();
    if let Some(cancel) = running.get(&token) {
        cancel.cancel();
    }
    Ok(())
}

#[tauri::command]
pub async fn management_shutdown(state: State<'_, ManagementState>) -> CommandResult<()> {
    for cancel in state.running.lock().unwrap().values() {
        cancel.cancel();
    }
    crate::processes::shutdown().await;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependency {
    name: String,
    path: Option<String>,
    available: bool,
    help: String,
}

pub(crate) fn bridge_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(path) = selected_component(app, "bridge") {
        return Some(path);
    }
    let mut paths = vec![];
    if let Some(path) = std::env::var_os("QUERVIO_MICROSOFT_BRIDGE") {
        paths.push(PathBuf::from(path));
    }
    if let Ok(resource) = app.path().resource_dir() {
        paths.push(resource.join("microsoft/Quervio.MicrosoftBridge.exe"));
    }
    paths.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources/microsoft/Quervio.MicrosoftBridge.exe"),
    );
    if let Ok(data) = app.path().app_data_dir() {
        paths.push(data.join("components/microsoft/Quervio.MicrosoftBridge.exe"));
    }
    paths.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../tools/Quervio.MicrosoftBridge/bin/Release/net10.0/win-x64/publish/Quervio.MicrosoftBridge.exe"));
    paths.into_iter().find(|p| p.is_file())
}

#[tauri::command]
pub fn management_dependencies(app: tauri::AppHandle) -> Vec<Dependency> {
    let bridge = bridge_path(&app);
    let sts = crate::language::service_path(&app);
    vec![Dependency{name:"Microsoft bridge (.NET 10, SMO, DacFx, SqlClient)".into(),available:bridge.is_some(),path:bridge.map(|p|p.display().to_string()),help:"Build tools/Quervio.MicrosoftBridge with scripts/build-microsoft.ps1, or select an existing published executable.".into()},Dependency{name:"SQL Tools Service".into(),available:sts.is_some(),path:sts.map(|p|p.display().to_string()),help:"Select Microsoft.SqlTools.ServiceLayer.exe from an official SQL Tools Service distribution.".into()}]
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BridgeRequest {
    pub action: String,
    pub arguments: serde_json::Value,
    pub confirmed: bool,
}

#[tauri::command]
pub fn management_bridge_prepare(
    explorer: State<'_, ExplorerState>,
    state: State<'_, ManagementState>,
    id: String,
    database: Option<String>,
    request: BridgeRequest,
) -> CommandResult<serde_json::Value> {
    let connection = explorer.connection(&id)?;
    let snapshot = serde_json::to_value(&connection).map_err(message)?;
    let token = uuid::Uuid::new_v4().to_string();
    let result = serde_json::json!({"token":token,"server":connection.server,"database":database.clone().or(connection.default_database.clone()).unwrap_or("master".into()),"action":request.action});
    let mut pending = state.bridge.lock().unwrap();
    pending.retain(|_, p| p.created.elapsed() < Duration::from_secs(300));
    if pending.len() >= 16 {
        return Err("Too many pending Microsoft operations.".into());
    }
    pending.insert(
        token,
        BridgePending {
            id,
            database,
            action: request.action,
            arguments: request.arguments,
            connection: snapshot,
            created: Instant::now(),
        },
    );
    Ok(result)
}

#[tauri::command]
pub async fn management_bridge(
    app: tauri::AppHandle,
    explorer: State<'_, ExplorerState>,
    state: State<'_, ManagementState>,
    id: String,
    database: Option<String>,
    request: BridgeRequest,
    preview_token: Option<String>,
    on_event: Channel<Progress>,
) -> CommandResult<serde_json::Value> {
    let operation_id = preview_token
        .clone()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if crate::microsoft::is_write(&request.action) {
        if !request.confirmed {
            return Err("The Microsoft operation was not confirmed.".into());
        }
        let token =
            preview_token.ok_or("Prepare a Microsoft operation preview before confirming it.")?;
        let pending = state
            .bridge
            .lock()
            .unwrap()
            .remove(&token)
            .ok_or("Microsoft preview expired or already used.")?;
        let snapshot = serde_json::to_value(explorer.connection(&id)?).map_err(message)?;
        if pending.created.elapsed() >= Duration::from_secs(300)
            || pending.id != id
            || pending.database != database
            || pending.action != request.action
            || pending.arguments != request.arguments
            || pending.connection != snapshot
        {
            return Err("The destination or operation changed. Generate a new preview.".into());
        }
    }
    let cancel = quervio_core::execution::CancelToken::new();
    {
        let mut running = state.running.lock().unwrap();
        if running.contains_key(&operation_id) {
            return Err("This operation is already running.".into());
        }
        running.insert(operation_id.clone(), cancel.clone());
    }
    let result =
        crate::microsoft::run(&app, &explorer, &id, database, request, on_event, cancel).await;
    state.running.lock().unwrap().remove(&operation_id);
    result
}

#[tauri::command]
pub fn management_component_select(
    app: tauri::AppHandle,
    kind: String,
    path: PathBuf,
) -> CommandResult<()> {
    let expected = match kind.as_str() {
        "bridge" => "Quervio.MicrosoftBridge.exe",
        "language" => "MicrosoftSqlToolsServiceLayer.exe",
        _ => return Err("Unknown component.".into()),
    };
    let name = path.file_name().and_then(|n| n.to_str());
    if !path.is_file()
        || (name != Some(expected)
            && !(kind == "language" && name == Some("Microsoft.SqlTools.ServiceLayer.exe")))
    {
        return Err(format!("Select {expected}."));
    }
    let dir = app
        .path()
        .app_data_dir()
        .map_err(message)?
        .join("components");
    std::fs::create_dir_all(&dir).map_err(message)?;
    std::fs::write(
        dir.join(format!("{kind}.json")),
        serde_json::to_vec(&path).map_err(message)?,
    )
    .map_err(message)
}

#[tauri::command]
pub async fn management_install_language(
    app: tauri::AppHandle,
    on_event: Channel<Progress>,
) -> CommandResult<()> {
    let resource = app
        .path()
        .resource_dir()
        .map_err(message)?
        .join("install-sqltools.ps1");
    let script = if resource.is_file() {
        resource
    } else {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../scripts/install-sqltools.ps1")
    };
    if !script.is_file() {
        return Err("SQL Tools Service installer script is missing.".into());
    }
    let root = app
        .path()
        .app_data_dir()
        .map_err(message)?
        .join("components");
    let shell = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| "C:\\Windows".into())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let mut command = tokio::process::Command::new(shell);
    command
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(script)
        .arg("-ComponentsRoot")
        .arg(root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let _ = on_event.send(Progress {
        phase: "installing".into(),
        message: "Downloading the official versioned SQL Tools Service and checking SHA-256."
            .into(),
        completed: None,
    });
    let result = command.output().await.map_err(message)?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).into_owned());
    }
    let _ = on_event.send(Progress {
        phase: "completed".into(),
        message: String::from_utf8_lossy(&result.stdout).into_owned(),
        completed: None,
    });
    Ok(())
}

pub(crate) fn selected_component(app: &tauri::AppHandle, kind: &str) -> Option<PathBuf> {
    let path = app
        .path()
        .app_data_dir()
        .ok()?
        .join("components")
        .join(format!("{kind}.json"));
    let selected: PathBuf = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    selected.is_file().then_some(selected)
}
