#[cfg(windows)]
mod browser_shortcuts;
mod explorer;
mod formatting;
mod language;
mod management;
mod microsoft;
mod platform;
mod processes;
mod query;
mod settings;
mod tabs;
mod updates;

use std::path::Path;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            #[cfg(windows)]
            browser_shortcuts::disable(app)?;
            let data_dir = app.path().app_data_dir()?;
            copy_querydeck_data(&data_dir);
            app.manage(explorer::ExplorerState::open(&data_dir, &app.path().resource_dir()?)?);
            app.manage(query::QueryState::default());
            app.manage(management::ManagementState::default());
            app.manage(language::LanguageState::default());
            app.manage(settings::SettingsState::new(&data_dir));
            app.manage(updates::UpdateState::default());
            // The page shows the window once it has drawn. If it never gets
            // there (a script error), show it anyway rather than run unseen.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_secs(5));
                if let Some(window) = handle.get_webview_window("main") {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.show();
                    }
                }
            });
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
            explorer::list_connection_groups,
            explorer::update_connection_group,
            explorer::ssms_connections,
            explorer::ssms_import,
            explorer::group_connections,
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
            query::query_databases,
            query::query_sqlcmd_prepare,
            query::query_sqlcmd_execute,
            query::query_sqlcmd_discard,
            query::query_close,
            query::query_execute,
            query::query_cancel,
            query::query_check,
            query::query_use_database,
            query::query_end_transactions,
            query::result_rows,
            query::result_sort,
            query::result_find,
            query::result_cell,
            query::result_copy,
            query::result_export_markdown,
            query::result_export_file,
            settings::settings_load,
            settings::settings_save,
            settings::settings_data_dir,
            formatting::format_sql,
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
        // Copy connections.json last: it acts as the migration completion marker,
        // so a transient failure on secrets.json or tabs.json retries cleanly on
        // the next start. Never overwrite files Quervio already created.
        for name in ["secrets.json", "tabs.json", "connections.json"] {
            let from = old_dir.join(name);
            let to = data_dir.join(name);
            if from.exists() && !to.exists() {
                let tmp = data_dir.join(format!("{name}.migrate.tmp"));
                std::fs::copy(&from, &tmp)?;
                if let Err(error) = std::fs::rename(&tmp, &to) {
                    let _ = std::fs::remove_file(&tmp);
                    return Err(error);
                }
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

#[cfg(test)]
mod tests {
    use super::copy_querydeck_data;

    #[test]
    fn querydeck_migration_preserves_existing_tabs_and_retries_after_partial_failure() {
        let root = std::env::temp_dir().join(format!("quervio-mig-test-{}", uuid::Uuid::new_v4()));
        let old_dir = root.join("com.querydeck.app");
        let new_dir = root.join("com.quervio.app");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();

        std::fs::write(old_dir.join("connections.json"), "[]").unwrap();
        std::fs::write(old_dir.join("secrets.json"), "{\"a\":\"b\"}").unwrap();
        std::fs::write(old_dir.join("tabs.json"), "{\"old\":true}").unwrap();
        std::fs::write(new_dir.join("tabs.json"), "{\"current\":true}").unwrap();

        copy_querydeck_data(&new_dir);
        assert_eq!(std::fs::read_to_string(new_dir.join("tabs.json")).unwrap(), "{\"current\":true}");
        assert_eq!(std::fs::read_to_string(new_dir.join("secrets.json")).unwrap(), "{\"a\":\"b\"}");
        assert_eq!(std::fs::read_to_string(new_dir.join("connections.json")).unwrap(), "[]");
        std::fs::remove_dir_all(&root).unwrap();

        // Partial failure while migrating secrets.json must not copy connections.json,
        // so the next start retries and completes migration of all files.
        let root2 = std::env::temp_dir().join(format!("quervio-mig-retry-{}", uuid::Uuid::new_v4()));
        let old_dir2 = root2.join("com.querydeck.app");
        let new_dir2 = root2.join("com.quervio.app");
        std::fs::create_dir_all(&old_dir2).unwrap();
        std::fs::create_dir_all(&new_dir2).unwrap();
        std::fs::write(old_dir2.join("connections.json"), "[]").unwrap();
        std::fs::write(old_dir2.join("secrets.json"), "{\"a\":\"b\"}").unwrap();
        std::fs::write(old_dir2.join("tabs.json"), "{\"migrated\":true}").unwrap();
        // Force copy to temp file to fail deterministically.
        std::fs::create_dir(new_dir2.join("secrets.json.migrate.tmp")).unwrap();

        copy_querydeck_data(&new_dir2);
        assert!(!new_dir2.join("connections.json").exists());
        assert!(!new_dir2.join("secrets.json").exists());
        assert!(!new_dir2.join("tabs.json").exists());

        std::fs::remove_dir(new_dir2.join("secrets.json.migrate.tmp")).unwrap();
        copy_querydeck_data(&new_dir2);
        assert_eq!(std::fs::read_to_string(new_dir2.join("secrets.json")).unwrap(), "{\"a\":\"b\"}");
        assert_eq!(std::fs::read_to_string(new_dir2.join("tabs.json")).unwrap(), "{\"migrated\":true}");
        assert_eq!(std::fs::read_to_string(new_dir2.join("connections.json")).unwrap(), "[]");
        std::fs::remove_dir_all(&root2).unwrap();
    }
}
