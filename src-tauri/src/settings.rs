//! The user's settings, stored as JSON written by the frontend. Rust only
//! keeps the file; the shape and the defaults live in src/stores/settings.ts.

use std::path::PathBuf;

use tauri::State;

use crate::explorer::{CommandResult, message};

pub struct SettingsState {
    path: PathBuf,
}

impl SettingsState {
    pub fn new(data_dir: &std::path::Path) -> Self {
        Self {
            path: data_dir.join("settings.json"),
        }
    }
}

/// The saved settings, if any.
#[tauri::command]
pub fn settings_load(state: State<'_, SettingsState>) -> CommandResult<Option<String>> {
    match std::fs::read_to_string(&state.path) {
        // Tolerate a BOM, e.g. if the file was edited with Notepad.
        Ok(text) => Ok(Some(text.trim_start_matches('\u{feff}').to_string())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(message(error)),
    }
}

/// Saves the settings through a temporary file, so a crash never leaves
/// half of it.
#[tauri::command]
pub fn settings_save(state: State<'_, SettingsState>, settings: String) -> CommandResult<()> {
    if let Some(dir) = state.path.parent() {
        std::fs::create_dir_all(dir).map_err(message)?;
    }
    let temporary = state.path.with_extension("json.tmp");
    std::fs::write(&temporary, settings).map_err(message)?;
    std::fs::rename(&temporary, &state.path).map_err(message)
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
