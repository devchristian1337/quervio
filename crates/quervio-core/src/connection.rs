//! Saved Connections: how to reach a Server, persisted as JSON. Passwords
//! never go in this file; they live in a [`crate::secrets::SecretStore`].

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{Error, Result};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedConnection {
    pub id: String,
    /// Label shown in the Object Explorer; the server address when empty.
    pub name: String,
    /// The Object Explorer folder it sits in; none at the top level. Saved
    /// before groups existed, a connection reads as ungrouped.
    #[serde(default)]
    pub group: Option<String>,
    /// Address as SSMS accepts it: `host`, `host\instance`, `host,port`, `tcp:host,port`.
    pub server: String,
    pub authentication: Authentication,
    pub default_database: Option<String>,
    pub environment: Environment,
    pub encrypt: Encrypt,
    pub trust_server_certificate: bool,
}

impl SavedConnection {
    pub fn display_name(&self) -> &str {
        if self.name.trim().is_empty() {
            &self.server
        } else {
            &self.name
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Authentication {
    #[serde(rename_all = "camelCase")]
    Sql {
        user_name: String,
    },
    Windows,
    Entra,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Environment {
    Production,
    Test,
    Development,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Encrypt {
    Mandatory,
    Optional,
    Strict,
}

/// The Saved Connections file.
#[derive(Debug)]
pub struct ConnectionStore {
    path: PathBuf,
    connections: Vec<SavedConnection>,
}

impl ConnectionStore {
    /// Opens the store at `path`; a missing file is an empty store.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let connections = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(error) => return Err(error.into()),
        };
        Ok(Self { path, connections })
    }

    pub fn list(&self) -> &[SavedConnection] {
        &self.connections
    }

    pub fn get(&self, id: &str) -> Result<&SavedConnection> {
        self.connections
            .iter()
            .find(|connection| connection.id == id)
            .ok_or_else(|| Error::UnknownConnection(id.to_string()))
    }

    /// Adds or replaces a connection, giving it an id when it has none.
    pub fn save(&mut self, mut connection: SavedConnection) -> Result<SavedConnection> {
        if connection.id.is_empty() {
            connection.id = uuid::Uuid::new_v4().to_string();
        }
        match self.connections.iter_mut().find(|c| c.id == connection.id) {
            Some(existing) => *existing = connection.clone(),
            None => self.connections.push(connection.clone()),
        }
        self.write()?;
        Ok(connection)
    }

    /// Moves connections into a group, or out of any with None, in one write.
    pub fn set_group(&mut self, ids: &[String], group: Option<&str>) -> Result<Vec<SavedConnection>> {
        let group = group.map(str::trim).filter(|name| !name.is_empty()).map(str::to_string);
        let mut moved = Vec::new();
        for connection in self.connections.iter_mut().filter(|c| ids.contains(&c.id)) {
            connection.group = group.clone();
            moved.push(connection.clone());
        }
        self.write()?;
        Ok(moved)
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        self.connections.retain(|connection| connection.id != id);
        self.write()
    }

    /// Writes through a temporary file so a crash never leaves half a file.
    fn write(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = temporary_path(&self.path);
        fs::write(&temporary, serde_json::to_vec_pretty(&self.connections)?)?;
        fs::rename(&temporary, &self.path)?;
        Ok(())
    }
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(".tmp");
    path.with_file_name(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> SavedConnection {
        SavedConnection {
            id: String::new(),
            name: "Cliente Rossi".into(),
            group: Some("Rossi".into()),
            server: r"srv01\SQL2022".into(),
            authentication: Authentication::Sql {
                user_name: "support".into(),
            },
            default_database: Some("H2O".into()),
            environment: Environment::Production,
            encrypt: Encrypt::Mandatory,
            trust_server_certificate: true,
        }
    }

    #[test]
    fn save_assigns_an_id_and_survives_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join("connections.json");

        let mut store = ConnectionStore::open(&path).unwrap();
        assert!(store.list().is_empty());
        let saved = store.save(sample()).unwrap();
        assert!(!saved.id.is_empty());

        let reopened = ConnectionStore::open(&path).unwrap();
        assert_eq!(reopened.list(), [saved]);
    }

    #[test]
    fn save_with_an_existing_id_replaces_it() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ConnectionStore::open(dir.path().join("c.json")).unwrap();
        let mut saved = store.save(sample()).unwrap();
        saved.environment = Environment::Test;
        store.save(saved.clone()).unwrap();

        assert_eq!(store.list(), [saved]);
    }

    #[test]
    fn remove_deletes_only_that_connection() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = ConnectionStore::open(dir.path().join("c.json")).unwrap();
        let first = store.save(sample()).unwrap();
        let second = store.save(sample()).unwrap();
        store.remove(&first.id).unwrap();

        assert_eq!(store.list(), [second]);
        assert!(matches!(
            store.get(&first.id),
            Err(Error::UnknownConnection(_))
        ));
    }

    #[test]
    fn set_group_moves_connections_and_reads_old_files_as_ungrouped() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        fs::write(&path, r#"[{"id":"a","name":"","server":"s","authentication":{"kind":"windows"},"defaultDatabase":null,"environment":"test","encrypt":"mandatory","trustServerCertificate":false}]"#).unwrap();
        let mut store = ConnectionStore::open(&path).unwrap();
        assert_eq!(store.get("a").unwrap().group, None);
        let other = store.save(sample()).unwrap();

        let moved = store.set_group(&["a".into()], Some(" Aurelia ")).unwrap();
        assert_eq!(moved.len(), 1);
        assert_eq!(ConnectionStore::open(&path).unwrap().get("a").unwrap().group.as_deref(), Some("Aurelia"));
        store.set_group(&["a".into(), other.id.clone()], Some("")).unwrap();
        assert!(store.list().iter().all(|c| c.group.is_none()));
    }

    #[test]
    fn json_shape_is_stable_for_the_frontend() {
        let json = serde_json::to_value(SavedConnection {
            id: "1".into(),
            ..sample()
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "id": "1",
                "name": "Cliente Rossi",
                "group": "Rossi",
                "server": r"srv01\SQL2022",
                "authentication": { "kind": "sql", "userName": "support" },
                "defaultDatabase": "H2O",
                "environment": "production",
                "encrypt": "mandatory",
                "trustServerCertificate": true
            })
        );
    }

    #[test]
    fn display_name_falls_back_to_the_server() {
        let mut connection = sample();
        connection.name = "  ".into();
        assert_eq!(connection.display_name(), r"srv01\SQL2022");
    }
}
