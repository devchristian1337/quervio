//! Saved Connections: how to reach a Server, persisted as JSON. Passwords
//! never go in this file; they live in a [`crate::secrets::SecretStore`].

use std::fs;
use std::io::Write;
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
    groups: Vec<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct StoredConnections {
    connections: Vec<SavedConnection>,
    #[serde(default)]
    groups: Vec<String>,
}

// Versions before explicit groups stored just an array of connections.
#[derive(Deserialize)]
#[serde(untagged)]
enum ConnectionFile {
    Catalog(StoredConnections),
    Legacy(Vec<SavedConnection>),
}

impl ConnectionStore {
    /// Opens the store at `path`; a missing file is an empty store.
    pub fn open(path: impl Into<PathBuf>) -> Result<Self> {
        let path = path.into();
        let data = match fs::read(&path) {
            Ok(bytes) => match serde_json::from_slice(&bytes)? {
                ConnectionFile::Catalog(data) => data,
                ConnectionFile::Legacy(connections) => StoredConnections { connections, groups: Vec::new() },
            },
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => StoredConnections::default(),
            Err(error) => return Err(error.into()),
        };
        let mut store = Self { path, connections: data.connections, groups: data.groups };
        store.groups = store.list_groups();
        Ok(store)
    }

    pub fn list(&self) -> &[SavedConnection] {
        &self.connections
    }

    /// Groups have their own lifetime, including when their last server is deleted.
    pub fn list_groups(&self) -> Vec<String> {
        merged_groups(&self.groups, &self.connections)
    }

    /// Renames a group (even an empty one), or explicitly ungroups its servers.
    pub fn update_group(&mut self, name: &str, new_name: Option<&str>) -> Result<()> {
        let new_name = new_name.map(str::trim).filter(|s| !s.is_empty());
        let mut next_groups = self.groups.clone();
        next_groups.retain(|g| g != name);
        let mut next_connections = self.connections.clone();
        for connection in next_connections
            .iter_mut()
            .filter(|c| c.group.as_deref() == Some(name))
        {
            connection.group = new_name.map(str::to_string);
        }
        if let Some(name) = new_name {
            next_groups.push(name.to_string());
        }
        next_groups = merged_groups(&next_groups, &next_connections);
        self.write_data(&next_connections, &next_groups)?;
        self.connections = next_connections;
        self.groups = next_groups;
        Ok(())
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
        let mut next_connections = self.connections.clone();
        match next_connections.iter_mut().find(|c| c.id == connection.id) {
            Some(existing) => *existing = connection.clone(),
            None => next_connections.push(connection.clone()),
        }
        let next_groups = merged_groups(&self.groups, &next_connections);
        self.write_data(&next_connections, &next_groups)?;
        self.connections = next_connections;
        self.groups = next_groups;
        Ok(connection)
    }

    /// Moves connections into a group, or out of any with None, in one write.
    pub fn set_group(&mut self, ids: &[String], group: Option<&str>) -> Result<Vec<SavedConnection>> {
        let group = group
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_string);
        let mut next_connections = self.connections.clone();
        let mut moved = Vec::new();
        for connection in next_connections.iter_mut().filter(|c| ids.contains(&c.id)) {
            connection.group = group.clone();
            moved.push(connection.clone());
        }
        let next_groups = merged_groups(&self.groups, &next_connections);
        self.write_data(&next_connections, &next_groups)?;
        self.connections = next_connections;
        self.groups = next_groups;
        Ok(moved)
    }

    pub fn remove(&mut self, id: &str) -> Result<()> {
        let next_groups = merged_groups(&self.groups, &self.connections);
        let mut next_connections = self.connections.clone();
        next_connections.retain(|connection| connection.id != id);
        self.write_data(&next_connections, &next_groups)?;
        self.connections = next_connections;
        self.groups = next_groups;
        Ok(())
    }

    /// Writes through a unique flushed temporary file so a crash never leaves
    /// half a file and a failure leaves existing state untouched.
    fn write_data(&self, connections: &[SavedConnection], groups: &[String]) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = temporary_path(&self.path);
        let data = StoredConnections {
            connections: connections.to_vec(),
            groups: groups.to_vec(),
        };
        let bytes = serde_json::to_vec_pretty(&data)?;
        let write_result = (|| -> std::io::Result<()> {
            let mut file = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            Ok(())
        })();
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        if let Err(error) = fs::rename(&temporary, &self.path) {
            let _ = fs::remove_file(&temporary);
            return Err(error.into());
        }
        Ok(())
    }
}

fn merged_groups(explicit: &[String], connections: &[SavedConnection]) -> Vec<String> {
    let mut groups = explicit.to_vec();
    groups.extend(connections.iter().filter_map(|c| c.group.clone()));
    groups.sort();
    groups.dedup();
    groups
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
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
    fn deleting_the_last_server_keeps_the_group_after_reopening() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        // Start from the original array format, as existing installations do.
        let mut connection = sample();
        connection.id = "existing".into();
        fs::write(&path, serde_json::to_vec(&[connection]).unwrap()).unwrap();
        let mut store = ConnectionStore::open(&path).unwrap();
        store.remove("existing").unwrap();
        let mut reopened = ConnectionStore::open(&path).unwrap();
        assert!(reopened.list().is_empty());
        assert_eq!(reopened.list_groups(), ["Rossi"]);
        reopened.update_group("Rossi", Some("Renamed")).unwrap();
        assert_eq!(ConnectionStore::open(&path).unwrap().list_groups(), ["Renamed"]);
        reopened.update_group("Renamed", None).unwrap();
        assert!(ConnectionStore::open(&path).unwrap().list_groups().is_empty());
    }

    #[test]
    fn updating_a_group_preserves_connections_and_merges_existing_groups() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let mut store = ConnectionStore::open(&path).unwrap();
        let first = store.save(sample()).unwrap();
        let mut second = sample();
        second.group = Some("Other".into());
        store.save(second).unwrap();
        store.update_group("Rossi", Some("Other")).unwrap();
        assert_eq!(store.list_groups(), ["Other"]);
        assert_eq!(store.get(&first.id).unwrap().group.as_deref(), Some("Other"));
        store.update_group("Other", None).unwrap();
        let reopened = ConnectionStore::open(&path).unwrap();
        assert_eq!(reopened.list().len(), 2);
        assert!(reopened.list().iter().all(|c| c.group.is_none()));
        assert!(reopened.list_groups().is_empty());
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

    #[test]
    fn failed_write_leaves_in_memory_state_unchanged_and_cleans_up_temp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("connections.json");
        let mut store = ConnectionStore::open(&path).unwrap();
        fs::create_dir(&path).unwrap();
        assert!(store.save(sample()).is_err());
        assert!(store.list().is_empty());
        assert!(store.list_groups().is_empty());
        let leftover: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftover.is_empty(), "leftover temp files: {leftover:?}");
    }
}
