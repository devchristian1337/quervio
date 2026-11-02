//! Keep browser commands out of Quervio's keyboard handling. WebView2's
//! setting preserves DOM key events, text editing and movement shortcuts.

use tauri::Manager;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
use windows_core::Interface;

pub fn disable(app: &tauri::App) -> tauri::Result<()> {
    for window in app.webview_windows().values() {
        let handle = app.handle().clone();
        window.with_webview(move |webview| {
            // SAFETY: Tauri runs this callback on the WebView's owning UI
            // thread. All COM references stay inside this callback.
            let result = unsafe {
                webview
                    .controller()
                    .CoreWebView2()
                    .and_then(|core| core.Settings())
                    .and_then(|settings| settings.cast::<ICoreWebView2Settings3>())
                    .and_then(|settings| settings.SetAreBrowserAcceleratorKeysEnabled(false))
            };
            if let Err(error) = result {
                eprintln!("Could not disable WebView2 browser shortcuts: {error}");
                handle.exit(1);
            }
        })?;
    }
    Ok(())
}
