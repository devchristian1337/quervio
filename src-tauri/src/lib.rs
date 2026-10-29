mod explorer;
mod language;
mod management;
mod microsoft;
mod processes;
mod query;
mod settings;
mod updates;

use std::path::Path;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            copy_querydeck_data(&data_dir);
            app.manage(explorer::ExplorerState::open(&data_dir)?);
            app.manage(query::QueryState::default());
            app.manage(management::ManagementState::default());
            app.manage(language::LanguageState::default());
            app.manage(settings::SettingsState::new(&data_dir));
            app.manage(updates::UpdateState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            management::management_capabilities,
            management::management_read,
            management::management_prepare,
            management::management_apply,
            management::management_cancel,
            management::management_shutdown,
            management::management_discard,
            management::management_dependencies,
            management::management_bridge,
            management::management_bridge_prepare,
            management::management_component_select,
            management::management_install_language,
            language::language_request,
            language::language_close,
            explorer::list_connections,
            explorer::ssms_connections,
            explorer::ssms_import,
            explorer::save_connection,
            explorer::delete_connection,
            explorer::test_connection,
            explorer::connection_databases,
            explorer::explorer_connect,
            explorer::explorer_disconnect,
            explorer::explorer_databases,
            explorer::explorer_objects,
            explorer::explorer_table_children,
            explorer::explorer_script,
            explorer::file_read,
            explorer::file_write,
            explorer::tabs_load,
            explorer::tabs_save,
            query::query_open,
            query::query_sqlcmd_prepare,
            query::query_sqlcmd_execute,
            query::query_close,
            query::query_execute,
            query::query_cancel,
            query::query_check,
            query::query_use_database,
            query::query_end_transactions,
            query::result_rows,
            query::result_sort,
            query::result_cell,
            query::result_copy,
            query::result_export_markdown,
            query::result_export_file,
            settings::settings_load,
            settings::settings_save,
            settings::settings_data_dir,
            updates::update_check,
            updates::update_download,
            updates::update_apply,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// The app was called Querydeck and kept its data in `com.querydeck.app`.
/// On the first start as Quervio, copy the Saved Connections, their
/// passwords (DPAPI is tied to the Windows user, not the folder) and the
/// open Query Tabs. The old folder is left as it was.
fn copy_querydeck_data(data_dir: &Path) {
    let Some(old_dir) = data_dir
        .parent()
        .map(|parent| parent.join("com.querydeck.app"))
    else {
        return;
    };
    if data_dir.join("connections.json").exists() || !old_dir.join("connections.json").exists() {
        return;
    }
    let copied = std::fs::create_dir_all(data_dir).and_then(|()| {
        for name in ["connections.json", "secrets.json", "tabs.json"] {
            let from = old_dir.join(name);
            if from.exists() {
                std::fs::copy(&from, data_dir.join(name))?;
            }
        }
        Ok(())
    });
    // Not fatal: the app starts empty, and the old files are still there.
    if let Err(error) = copied {
        eprintln!(
            "Could not copy the Querydeck data from {}: {error}",
            old_dir.display()
        );
    }
}
