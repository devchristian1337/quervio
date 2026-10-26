mod explorer;

use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            app.manage(explorer::ExplorerState::open(&data_dir)?);
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
