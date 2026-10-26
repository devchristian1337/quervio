mod explorer;
mod query;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(explorer::ExplorerState::open(&data_dir)?);
            app.manage(query::QueryState::default());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            explorer::list_connections,
            explorer::save_connection,
            explorer::delete_connection,
            explorer::test_connection,
            explorer::explorer_connect,
            explorer::explorer_disconnect,
            explorer::explorer_databases,
            explorer::explorer_objects,
            explorer::explorer_table_children,
            query::query_open,
            query::query_close,
            query::query_execute,
            query::query_cancel,
            query::query_check,
            query::query_use_database,
            query::query_end_transactions,
            query::result_rows,
            query::result_cell,
            query::result_copy,
            query::result_export_markdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
