//! Updates through Velopack, from the GitHub Releases of the repository
//! (scripts/pack-velopack.ps1 publishes them). Only an installed Quervio can
//! update: `pnpm tauri dev` and a copied exe report `installed: false`.

use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, State, ipc::Channel};
use velopack::{UpdateCheck, UpdateInfo, UpdateManager, sources::GithubSource};

use crate::explorer::{CommandResult, message};

const RELEASES: &str = "https://github.com/devchristian1337/quervio";

/// The update found by the last check, kept for the download and the restart.
#[derive(Default)]
pub struct UpdateState {
    found: Mutex<Option<UpdateInfo>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    installed: bool,
    current: Option<String>,
    available: Option<String>,
    /// The update is downloaded and is applied on the next restart.
    ready: bool,
}

fn manager() -> Option<UpdateManager> {
    UpdateManager::new(GithubSource::new(RELEASES, None, false), None, None).ok()
}

/// Asks GitHub for a newer release.
#[tauri::command]
pub async fn update_check(state: State<'_, UpdateState>) -> CommandResult<UpdateStatus> {
    let Some(manager) = manager() else {
        return Ok(UpdateStatus {
            installed: false,
            current: None,
            available: None,
            ready: false,
        });
    };
    let current = manager.get_current_version_as_string();
    let pending = manager.get_update_pending_restart();
    let check = {
        let manager = manager.clone();
        tokio::task::spawn_blocking(move || manager.check_for_updates())
            .await
            .map_err(message)?
            .map_err(message)?
    };
    let found = match check {
        UpdateCheck::UpdateAvailable(info) => Some(*info),
        UpdateCheck::NoUpdateAvailable | UpdateCheck::RemoteIsEmpty => None,
    };
    let available = found.as_ref().map(|info| info.TargetFullRelease.Version.clone());
    let ready = matches!(
        (&pending, &available),
        (Some(asset), Some(version)) if &asset.Version == version
    );
    *state.found.lock().unwrap() = found;
    Ok(UpdateStatus {
        installed: true,
        current: Some(current),
        available,
        ready,
    })
}

/// Downloads the update found by `update_check`, reporting 0–100.
#[tauri::command]
pub async fn update_download(
    state: State<'_, UpdateState>,
    on_progress: Channel<i16>,
) -> CommandResult<()> {
    let manager = manager().ok_or("Quervio is not installed, so it cannot update itself.")?;
    let info = state
        .found
        .lock()
        .unwrap()
        .clone()
        .ok_or("There is no update to download.")?;
    let (sender, receiver) = std::sync::mpsc::channel::<i16>();
    let forward = std::thread::spawn(move || {
        for percent in receiver {
            let _ = on_progress.send(percent);
        }
    });
    let downloaded = tokio::task::spawn_blocking(move || manager.download_updates(&info, Some(sender)))
        .await
        .map_err(message)?;
    let _ = forward.join();
    downloaded.map_err(message)
}

/// Hands the downloaded update to Velopack's updater and exits; it replaces
/// the files once Quervio is gone and starts it again. The frontend saves the
/// tabs and settles transactions first, as when the window closes.
#[tauri::command]
pub async fn update_apply(app: AppHandle, state: State<'_, UpdateState>) -> CommandResult<()> {
    let manager = manager().ok_or("Quervio is not installed, so it cannot update itself.")?;
    let info = state
        .found
        .lock()
        .unwrap()
        .clone()
        .ok_or("There is no update to install.")?;
    // The bridge and SQL Tools Service run from the install folder: their
    // files must be free before the updater swaps them.
    crate::processes::shutdown().await;
    manager
        .wait_exit_then_apply_updates(&info, false, true, Vec::<String>::new())
        .map_err(message)?;
    app.exit(0);
    Ok(())
}
