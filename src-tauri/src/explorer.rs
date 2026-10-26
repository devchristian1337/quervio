//! Commands behind the Connect dialog and the Object Explorer. The Object
//! Explorer keeps one Session per connected Server, separate from the
//! Sessions of Query Tabs.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use querydeck_core::catalog::{self, CatalogItem, ObjectFolder, TableFolder};
use querydeck_core::connection::{Authentication, ConnectionStore, SavedConnection};
use querydeck_core::secrets::{DpapiSecretStore, SecretStore};
use querydeck_core::session::{ServerInfo, Session};
use tauri::State;

const APPLICATION_NAME: &str = "Querydeck - Object Explorer";

type SharedSession = Arc<tokio::sync::Mutex<Session>>;

pub struct ExplorerState {
    connections: Mutex<ConnectionStore>,
    secrets: DpapiSecretStore,
    sessions: tokio::sync::Mutex<HashMap<String, SharedSession>>,
}

impl ExplorerState {
    pub fn open(data_dir: &Path) -> querydeck_core::Result<Self> {
        Ok(Self {
            connections: Mutex::new(ConnectionStore::open(data_dir.join("connections.json"))?),
            secrets: DpapiSecretStore::new(data_dir.join("secrets.json")),
            sessions: tokio::sync::Mutex::new(HashMap::new()),
        })
    }

    fn connection(&self, id: &str) -> CommandResult<SavedConnection> {
        Ok(self
            .connections
            .lock()
            .unwrap()
            .get(id)
            .map_err(message)?
            .clone())
    }

    /// The stored password, or the one typed in the dialog when given.
    fn password(&self, id: &str, typed: Option<String>) -> CommandResult<Option<String>> {
        match typed.filter(|password| !password.is_empty()) {
            Some(password) => Ok(Some(password)),
            None if id.is_empty() => Ok(None),
            None => self.secrets.get(id).map_err(message),
        }
    }

    async fn session(&self, id: &str) -> CommandResult<SharedSession> {
        if let Some(session) = self.sessions.lock().await.get(id) {
            return Ok(Arc::clone(session));
        }
        self.connect(id).await.map(|(session, _)| session)
    }

    async fn connect(&self, id: &str) -> CommandResult<(SharedSession, ServerInfo)> {
        let connection = self.connection(id)?;
        let password = self.password(id, None)?;
        let mut session = Session::open(&connection, password, APPLICATION_NAME)
            .await
            .map_err(message)?;
        let info = session.server_info().await.map_err(message)?;
        let session = Arc::new(tokio::sync::Mutex::new(session));
        let previous = self
            .sessions
            .lock()
            .await
            .insert(id.to_string(), Arc::clone(&session));
        close(previous).await;
        Ok((session, info))
    }

    async fn disconnect(&self, id: &str) {
        let session = self.sessions.lock().await.remove(id);
        close(session).await;
    }
}

async fn close(session: Option<SharedSession>) {
    if let Some(session) = session.and_then(|shared| Arc::try_unwrap(shared).ok()) {
        // The Server cleans up a dropped connection anyway; nothing to report.
        let _ = session.into_inner().close().await;
    }
}

type CommandResult<T> = Result<T, String>;

fn message(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[tauri::command]
pub fn list_connections(state: State<'_, ExplorerState>) -> Vec<SavedConnection> {
    state.connections.lock().unwrap().list().to_vec()
}

/// Saves the connection and, for SQL logins, the password when one was typed.
#[tauri::command]
pub async fn save_connection(
    state: State<'_, ExplorerState>,
    connection: SavedConnection,
    password: Option<String>,
) -> CommandResult<SavedConnection> {
    let saved = state
        .connections
        .lock()
        .unwrap()
        .save(connection)
        .map_err(message)?;
    match (&saved.authentication, password.filter(|p| !p.is_empty())) {
        (Authentication::Sql { .. }, Some(password)) => {
            state.secrets.set(&saved.id, &password).map_err(message)?
        }
        (Authentication::Sql { .. }, None) => {}
        (Authentication::Windows, _) => state.secrets.delete(&saved.id).map_err(message)?,
    }
    // Settings may have changed; the next expand reconnects with them.
    state.disconnect(&saved.id).await;
    Ok(saved)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, ExplorerState>, id: String) -> CommandResult<()> {
    state.disconnect(&id).await;
    state
        .connections
        .lock()
        .unwrap()
        .remove(&id)
        .map_err(message)?;
    state.secrets.delete(&id).map_err(message)
}

/// Logs in with the dialog's current values without saving anything.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, ExplorerState>,
    connection: SavedConnection,
    password: Option<String>,
) -> CommandResult<ServerInfo> {
    let password = state.password(&connection.id, password)?;
    let mut session = Session::open(&connection, password, APPLICATION_NAME)
        .await
        .map_err(message)?;
    let info = session.server_info().await.map_err(message)?;
    let _ = session.close().await;
    Ok(info)
}

#[tauri::command]
pub async fn explorer_connect(
    state: State<'_, ExplorerState>,
    id: String,
) -> CommandResult<ServerInfo> {
    state.connect(&id).await.map(|(_, info)| info)
}

#[tauri::command]
pub async fn explorer_disconnect(state: State<'_, ExplorerState>, id: String) -> CommandResult<()> {
    state.disconnect(&id).await;
    Ok(())
}

#[tauri::command]
pub async fn explorer_databases(
    state: State<'_, ExplorerState>,
    id: String,
) -> CommandResult<Vec<CatalogItem>> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    catalog::databases(&mut session).await.map_err(message)
}

#[tauri::command]
pub async fn explorer_objects(
    state: State<'_, ExplorerState>,
    id: String,
    database: String,
    folder: ObjectFolder,
) -> CommandResult<Vec<CatalogItem>> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    catalog::objects(&mut session, &database, folder)
        .await
        .map_err(message)
}

#[tauri::command]
pub async fn explorer_table_children(
    state: State<'_, ExplorerState>,
    id: String,
    database: String,
    object_id: i64,
    folder: TableFolder,
) -> CommandResult<Vec<CatalogItem>> {
    let session = state.session(&id).await?;
    let mut session = session.lock().await;
    catalog::table_children(&mut session, &database, object_id, folder)
        .await
        .map_err(message)
}
