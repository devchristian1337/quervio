//! Commands behind Query Tabs. Each Query Tab owns one Session for its whole
//! life, so temp tables, SET options and transactions survive between
//! Executions, as in SSMS.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use querydeck_core::execution::{CancelToken, ExecutionEvent, Outcome};
use querydeck_core::session::{ServerInfo, Session};
use tauri::State;
use tauri::ipc::Channel;

use crate::explorer::{CommandResult, ExplorerState, message};

const APPLICATION_NAME: &str = "Querydeck - Query";

#[derive(Default)]
pub struct QueryState {
    sessions: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Session>>>>,
    // Kept apart from the sessions: cancelling must not wait for the
    // Session lock that the running Execution holds.
    running: Mutex<HashMap<String, CancelToken>>,
}

impl QueryState {
    async fn session(&self, tab_id: &str) -> CommandResult<Arc<tokio::sync::Mutex<Session>>> {
        self.sessions
            .lock()
            .await
            .get(tab_id)
            .cloned()
            .ok_or_else(|| "this Query Tab is not connected".to_string())
    }
}

/// Opens the Session of a Query Tab, optionally switching to `database`.
#[tauri::command]
pub async fn query_open(
    explorer: State<'_, ExplorerState>,
    state: State<'_, QueryState>,
    tab_id: String,
    connection_id: String,
    database: Option<String>,
) -> CommandResult<ServerInfo> {
    let connection = explorer.connection(&connection_id)?;
    let password = explorer.password(&connection_id, None)?;
    let mut session = Session::open(&connection, password, APPLICATION_NAME)
        .await
        .map_err(message)?;
    if let Some(database) = database {
        session.use_database(&database).await.map_err(message)?;
    }
    let info = session.server_info().await.map_err(message)?;
    let previous = state
        .sessions
        .lock()
        .await
        .insert(tab_id, Arc::new(tokio::sync::Mutex::new(session)));
    drop(previous);
    Ok(info)
}

#[tauri::command]
pub async fn query_close(state: State<'_, QueryState>, tab_id: String) -> CommandResult<()> {
    if let Some(cancel) = state.running.lock().unwrap().remove(&tab_id) {
        cancel.cancel();
    }
    let session = state.sessions.lock().await.remove(&tab_id);
    if let Some(session) = session.and_then(|shared| Arc::try_unwrap(shared).ok()) {
        let _ = session.into_inner().close().await;
    }
    Ok(())
}

/// Runs `script` and streams its events; resolves when the Execution ends.
#[tauri::command]
pub async fn query_execute(
    state: State<'_, QueryState>,
    tab_id: String,
    script: String,
    base_line: u32,
    on_event: Channel<ExecutionEvent>,
) -> CommandResult<Outcome> {
    let session = state.session(&tab_id).await?;
    let cancel = CancelToken::new();
    {
        let mut running = state.running.lock().unwrap();
        if running.contains_key(&tab_id) {
            return Err("this Query Tab is already executing".into());
        }
        running.insert(tab_id.clone(), cancel.clone());
    }
    let outcome = session
        .lock()
        .await
        .execute(&script, base_line, &cancel, |event| {
            // The tab may have been closed meanwhile; nothing to deliver to.
            let _ = on_event.send(event);
        })
        .await;
    state.running.lock().unwrap().remove(&tab_id);
    Ok(outcome)
}

#[tauri::command]
pub fn query_cancel(state: State<'_, QueryState>, tab_id: String) {
    if let Some(cancel) = state.running.lock().unwrap().get(&tab_id) {
        cancel.cancel();
    }
}
