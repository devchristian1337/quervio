// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Velopack's install, update and uninstall hooks: they may run a step
    // and exit before the app starts, so this comes first.
    velopack::VelopackApp::build().run();
    quervio_lib::run()
}
