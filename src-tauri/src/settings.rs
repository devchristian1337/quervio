//! The user's settings, stored as JSON written by the frontend. Rust only
//! keeps the file; the shape and the defaults live in src/stores/settings.ts.

use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::State;

use crate::explorer::{CommandResult, message};

pub struct SettingsState {
    path: PathBuf,
    lock: Mutex<()>,
}

impl SettingsState {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            path: data_dir.join("settings.json"),
            lock: Mutex::new(()),
        }
    }

    pub fn load(&self) -> CommandResult<Option<String>> {
        let _guard = self.lock.lock().map_err(message)?;
        match std::fs::read_to_string(&self.path) {
            // Tolerate a BOM, e.g. if the file was edited with Notepad.
            Ok(text) => Ok(Some(text.trim_start_matches('\u{feff}').to_string())),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(message(error)),
        }
    }

    pub fn save(&self, settings: &str) -> CommandResult<()> {
        let parsed: serde_json::Value =
            serde_json::from_str(settings).map_err(|_| "Settings must be a valid JSON object.")?;
        if !parsed.is_object() {
            return Err("Settings must be a valid JSON object.".into());
        }
        let _guard = self.lock.lock().map_err(message)?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(message)?;
        }
        let temporary = self
            .path
            .with_file_name(format!("settings.json.tmp.{}", uuid::Uuid::new_v4()));
        let written = (|| -> CommandResult<()> {
            let mut file = std::fs::File::create(&temporary).map_err(message)?;
            file.write_all(settings.as_bytes()).map_err(message)?;
            file.sync_all().map_err(message)?;
            drop(file);
            std::fs::rename(&temporary, &self.path).map_err(message)
        })();
        if written.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        written
    }
}

/// The saved settings, if any.
#[tauri::command]
pub fn settings_load(state: State<'_, SettingsState>) -> CommandResult<Option<String>> {
    state.load()
}

/// Saves the settings through a temporary file, so a crash never leaves
/// half of it.
#[tauri::command]
pub fn settings_save(state: State<'_, SettingsState>, settings: String) -> CommandResult<()> {
    state.save(&settings)
}

/// Where Quervio keeps its files, for the About page.
#[tauri::command]
pub fn settings_data_dir(state: State<'_, SettingsState>) -> String {
    state
        .path
        .parent()
        .map(|dir| dir.display().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn settings_save_rejects_invalid_json_and_serializes_concurrent_writes() {
        let dir = std::env::temp_dir().join(format!("quervio-settings-{}", uuid::Uuid::new_v4()));
        let state = Arc::new(SettingsState::new(&dir));

        state.save("{\"theme\":\"dark\"}").unwrap();
        for bad in ["", "{corrupt", "[]", "null", "123"] {
            assert!(state.save(bad).is_err(), "expected rejection for {bad:?}");
        }
        assert_eq!(state.load().unwrap().as_deref(), Some("{\"theme\":\"dark\"}"));

        let mut handles = Vec::new();
        for t in 0..8 {
            let st = Arc::clone(&state);
            handles.push(std::thread::spawn(move || {
                for i in 0..50 {
                    let body = format!("{{\"thread\":{t},\"iter\":{i}}}");
                    st.save(&body).unwrap();
                }
            }));
        }
        for handle in handles {
            handle.join().unwrap();
        }
        let final_text = state.load().unwrap().unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&final_text).unwrap().is_object());
        // No leftover temp files.
        let leftover: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp."))
            .collect();
        assert!(leftover.is_empty(), "unexpected leftover temp files: {leftover:?}");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
