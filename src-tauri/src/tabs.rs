//! Durable query-tab snapshots. The caller holds one mutex across load/save.
use serde::Serialize;
use serde_json::Value;
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Serialize)]
pub struct LoadedTabs {
    snapshot: Option<String>,
    recovered: bool,
}

pub struct TabSnapshots {
    path: PathBuf,
    backup: PathBuf,
}

impl TabSnapshots {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("tabs.json"),
            backup: data_dir.join("tabs.json.bak"),
        }
    }

    pub fn load(&self) -> Result<LoadedTabs, String> {
        let current = read(&self.path);
        if let Ok(Some(snapshot)) = &current {
            return Ok(LoadedTabs {
                snapshot: Some(snapshot.clone()),
                recovered: false,
            });
        }
        match read(&self.backup) {
            Ok(Some(snapshot)) => Ok(LoadedTabs {
                snapshot: Some(snapshot),
                recovered: true,
            }),
            Ok(None) if matches!(current, Ok(None)) => Ok(LoadedTabs {
                snapshot: None,
                recovered: false,
            }),
            _ => Err("The query tab snapshots could not be read or are invalid.".into()),
        }
    }

    pub fn save(&self, snapshot: &str) -> Result<(), String> {
        validate(snapshot)?;
        match fs::read_to_string(&self.path) {
            Ok(previous) if validate(previous.trim_start_matches('\u{feff}')).is_ok() => {
                if previous == snapshot {
                    // Upgrade an existing tabs.json even when its text has not
                    // changed since the app learned to keep a backup.
                    if !matches!(read(&self.backup), Ok(Some(_))) {
                        atomic_write(&self.backup, previous.as_bytes())?;
                    }
                    return Ok(());
                }
                // Only rotate a validated snapshot; never replace the last good
                // backup with the damaged primary after a recovery.
                atomic_write(&self.backup, previous.as_bytes())?;
            }
            // A primary that is not UTF-8 is damaged like invalid JSON: replace
            // it, keeping the backup, instead of failing every later save.
            Err(error)
                if !matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::InvalidData
                ) =>
            {
                return Err(error.to_string());
            }
            _ => {
                if !matches!(read(&self.backup), Ok(Some(_))) {
                    // Seed the backup on the first save as well.
                    atomic_write(&self.backup, snapshot.as_bytes())?;
                }
            }
        }
        atomic_write(&self.path, snapshot.as_bytes())
    }
}

fn read(path: &Path) -> Result<Option<String>, String> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let text = text.trim_start_matches('\u{feff}');
            validate(text)?;
            Ok(Some(text.to_owned()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn validate(text: &str) -> Result<(), String> {
    // Keep the existing JSON format, including snapshots predating plan/SQLCMD
    // modes. Reject valid JSON with the wrong shape, not just truncated JSON.
    let invalid = || "The query tab snapshot is invalid.".to_string();
    let value: Value = serde_json::from_str(text).map_err(|_| invalid())?;
    let tabs = value
        .get("tabs")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    let active = value
        .get("active")
        .and_then(Value::as_u64)
        .ok_or_else(invalid)?;
    if active >= tabs.len().max(1) as u64 {
        return Err(invalid());
    }
    for tab in tabs {
        if !["title", "connectionId", "text"]
            .iter()
            .all(|key| tab.get(key).is_some_and(Value::is_string))
            || !["database", "filePath"]
                .iter()
                .all(|key| tab.get(key).is_some_and(|v| v.is_null() || v.is_string()))
            || !tab.get("dirty").is_some_and(Value::is_boolean)
            || tab.get("sqlcmdMode").is_some_and(|v| !v.is_boolean())
            || tab
                .get("planMode")
                .is_some_and(|v| !matches!(v.as_str(), Some("none" | "estimated" | "actual")))
        {
            return Err(invalid());
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    // Separate temporary files for primary and backup. A process killed during
    // write leaves the previously committed file intact.
    let temporary = path.with_file_name(format!(
        "{}.tmp",
        path.file_name().unwrap().to_string_lossy()
    ));
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (PathBuf, TabSnapshots) {
        let dir = std::env::temp_dir().join(format!("quervio-tabs-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let store = TabSnapshots::new(&dir);
        (dir, store)
    }

    fn snapshot(sql: &str) -> String {
        serde_json::json!({ "tabs": [{ "title": "Query 1", "connectionId": "missing",
            "database": null, "filePath": null, "dirty": true, "text": sql }], "active": 0 })
        .to_string()
    }

    #[test]
    fn corrupt_primary_recovers_the_previous_sql_without_rotating_corruption() {
        let (dir, store) = setup();
        let first = snapshot("SELECT N'primo 🐟';");
        store.save(&first).unwrap();
        store.save(&snapshot("SELECT 2;")).unwrap();
        fs::write(&store.path, "{truncated").unwrap();
        let loaded = store.load().unwrap();
        assert!(loaded.recovered);
        assert_eq!(loaded.snapshot.as_deref(), Some(first.as_str()));
        store.save(&snapshot("SELECT 3;")).unwrap();
        assert_eq!(fs::read_to_string(&store.backup).unwrap(), first);
        assert!(!store.load().unwrap().recovered);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_primary_that_is_not_utf8_is_replaced_by_the_next_save() {
        let (dir, store) = setup();
        let first = snapshot("SELECT 1;");
        store.save(&first).unwrap();
        store.save(&snapshot("SELECT 2;")).unwrap();
        fs::write(&store.path, [0xff, 0xfe, 0x00, 0x7b]).unwrap();
        assert!(store.load().unwrap().recovered);
        let next = snapshot("SELECT 3;");
        store.save(&next).unwrap();
        assert_eq!(fs::read_to_string(&store.path).unwrap(), next);
        assert_eq!(fs::read_to_string(&store.backup).unwrap(), first);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn interrupted_writes_do_not_replace_committed_snapshots() {
        let (dir, store) = setup();
        let first = snapshot("SELECT 1;");
        store.save(&first).unwrap();
        fs::write(dir.join("tabs.json.tmp"), "{half-written").unwrap();
        assert_eq!(
            store.load().unwrap().snapshot.as_deref(),
            Some(first.as_str())
        );
        fs::remove_file(&store.path).unwrap();
        assert!(store.load().unwrap().recovered);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn invalid_shapes_and_failed_writes_preserve_the_good_copy() {
        let (dir, store) = setup();
        let first = snapshot("SELECT 1;");
        store.save(&first).unwrap();
        for bad in [
            "null",
            "{}",
            r#"{"tabs":[{}],"active":0}"#,
            r#"{"tabs":[],"active":2}"#,
        ] {
            assert!(store.save(bad).is_err());
            fs::write(&store.path, bad).unwrap();
            assert!(store.load().unwrap().recovered);
        }
        // Deterministic I/O failure, including when tests run as root/admin.
        fs::create_dir(dir.join("tabs.json.tmp")).unwrap();
        assert!(store.save(&snapshot("SELECT 2;")).is_err());
        assert_eq!(
            store.load().unwrap().snapshot.as_deref(),
            Some(first.as_str())
        );
        fs::write(&store.backup, "broken too").unwrap();
        assert!(store.load().is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn repeated_saves_keep_the_previous_distinct_snapshot_and_accept_a_bom() {
        let (dir, store) = setup();
        assert!(store.load().unwrap().snapshot.is_none());
        let first = snapshot("SELECT 1;");
        let second = snapshot("SELECT 2;");
        // A snapshot left by an older app has no backup yet.
        fs::write(&store.path, &first).unwrap();
        store.save(&first).unwrap();
        assert_eq!(fs::read_to_string(&store.backup).unwrap(), first);
        store.save(&second).unwrap();
        store.save(&second).unwrap();
        assert_eq!(fs::read_to_string(&store.backup).unwrap(), first);
        fs::write(&store.path, format!("\u{feff}{second}")).unwrap();
        assert_eq!(
            store.load().unwrap().snapshot.as_deref(),
            Some(second.as_str())
        );
        fs::remove_dir_all(dir).unwrap();
    }
}
