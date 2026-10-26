//! Commands behind Query Tabs. Each Query Tab owns one Session for its whole
//! life, so temp tables, SET options and transactions survive between
//! Executions, as in SSMS.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use querydeck_core::execution::{CancelToken, ExecutionEvent, Outcome};
use querydeck_core::results::{CellValue, ResultLimits, SharedResults};
use querydeck_core::session::{ServerInfo, Session};
use tauri::State;
use tauri::ipc::{Channel, Response};

use crate::explorer::{CommandResult, ExplorerState, message};

const APPLICATION_NAME: &str = "Querydeck - Query";

#[derive(Default)]
pub struct QueryState {
    sessions: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Session>>>>,
    // Kept apart from the sessions: cancelling must not wait for the
    // Session lock that the running Execution holds.
    running: Mutex<HashMap<String, CancelToken>>,
    // Also apart: the grid reads rows while the Execution is still writing them.
    results: Mutex<HashMap<String, SharedResults>>,
}

/// Characters of each cell sent to the grid; the value viewer fetches the rest.
const PREVIEW_CHARS: usize = 500;

impl QueryState {
    async fn session(&self, tab_id: &str) -> CommandResult<Arc<tokio::sync::Mutex<Session>>> {
        self.sessions
            .lock()
            .await
            .get(tab_id)
            .cloned()
            .ok_or_else(|| "this Query Tab is not connected".to_string())
    }

    fn results(&self, tab_id: &str) -> SharedResults {
        self.results
            .lock()
            .unwrap()
            .entry(tab_id.to_string())
            .or_default()
            .clone()
    }

    /// Runs `read` on Result Set `set` of a tab, if it exists.
    fn with_set<T>(
        &self,
        tab_id: &str,
        set: usize,
        read: impl FnOnce(&querydeck_core::results::ResultSet) -> T,
    ) -> CommandResult<T> {
        let results = self.results(tab_id);
        let sets = results.read().unwrap();
        let set = sets.get(set).ok_or("that result set no longer exists")?;
        Ok(read(set))
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
    state.results.lock().unwrap().remove(&tab_id);
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
    let results = state.results(&tab_id);
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
        .execute(
            &script,
            base_line,
            &cancel,
            &results,
            ResultLimits::default(),
            |event| {
                // The tab may have been closed meanwhile; nothing to deliver to.
                let _ = on_event.send(event);
            },
        )
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

/// A window of rows in the binary layout of `ResultSet::window`.
#[tauri::command]
pub fn result_rows(
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    start: usize,
    count: usize,
) -> CommandResult<Response> {
    state
        .with_set(&tab_id, set, |set| set.window(start, count, PREVIEW_CHARS))
        .map(Response::new)
}

/// The full text of one cell, for the value viewer.
#[tauri::command]
pub fn result_cell(
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    row: usize,
    column: usize,
) -> CommandResult<Option<CellValue>> {
    state.with_set(&tab_id, set, |set| set.cell(row, column))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyFormat {
    /// Tab-separated, as SSMS copies.
    Text,
    TextWithHeaders,
    /// Markdown table, for pasting into an LLM.
    Markdown,
}

/// What a copy put on the clipboard, for the confirmation shown to the user.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopySummary {
    rows: usize,
    columns: usize,
}

/// Puts a block of cells on the Windows clipboard. Written from Rust so large
/// copies never cross into the webview and do not depend on its focus.
#[tauri::command]
pub fn result_copy(
    app: tauri::AppHandle,
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    rows: (usize, usize),
    columns: (usize, usize),
    format: CopyFormat,
) -> CommandResult<CopySummary> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let (text, summary) = state.with_set(&tab_id, set, |set| {
        let rows = rows.0.min(set.row_count())..rows.1.min(set.row_count());
        let columns = columns.0.min(set.columns().len())..columns.1.min(set.columns().len());
        let summary = CopySummary {
            rows: rows.len(),
            columns: columns.len(),
        };
        let text = match format {
            CopyFormat::Text => set.copy_text(rows, columns, false),
            CopyFormat::TextWithHeaders => set.copy_text(rows, columns, true),
            CopyFormat::Markdown => set.markdown(rows, columns),
        };
        (text, summary)
    })?;
    app.clipboard().write_text(text).map_err(message)?;
    Ok(summary)
}

/// Writes a whole Result Set to `path` as a Markdown table.
#[tauri::command]
pub fn result_export_markdown(
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    path: std::path::PathBuf,
) -> CommandResult<()> {
    use std::io::Write;
    let file = std::fs::File::create(&path).map_err(message)?;
    let mut writer = std::io::BufWriter::new(file);
    state
        .with_set(&tab_id, set, |set| {
            set.write_markdown(&mut writer, 0..usize::MAX, 0..usize::MAX)
        })?
        .and_then(|()| writer.flush())
        .map_err(message)
}
