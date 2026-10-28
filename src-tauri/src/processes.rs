//! Registers only child processes started by this app for orderly shutdown.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
};
#[cfg(windows)]
type ProcessHandle = std::os::windows::io::OwnedHandle;
#[cfg(not(windows))]
type ProcessHandle = ();
static CHILDREN: OnceLock<Mutex<HashMap<u32, Arc<ProcessHandle>>>> = OnceLock::new();
fn children() -> &'static Mutex<HashMap<u32, Arc<ProcessHandle>>> {
    CHILDREN.get_or_init(|| Mutex::new(HashMap::new()))
}
pub struct Registration(u32);
impl Registration {
    pub fn new(pid: u32) -> Self {
        #[cfg(windows)]
        {
            use std::os::windows::io::FromRawHandle;
            // Retaining a process handle prevents Windows from recycling its PID
            // between taking the shutdown snapshot and terminating the process.
            let raw = unsafe {
                windows_sys::Win32::System::Threading::OpenProcess(
                    windows_sys::Win32::System::Threading::PROCESS_QUERY_LIMITED_INFORMATION,
                    0,
                    pid,
                )
            };
            if !raw.is_null() {
                let handle = unsafe { ProcessHandle::from_raw_handle(raw) };
                children().lock().unwrap().insert(pid, Arc::new(handle));
            }
        }
        #[cfg(not(windows))]
        children().lock().unwrap().insert(pid, Arc::new(()));
        Self(pid)
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        children().lock().unwrap().remove(&self.0);
    }
}
pub async fn terminate_tree(pid: u32) {
    let path = std::env::var_os("SystemRoot")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| r"C:\Windows".into())
        .join("System32/taskkill.exe");
    let mut command = tokio::process::Command::new(path);
    command
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let _ = command.status().await;
}
pub async fn shutdown() {
    let processes = children()
        .lock()
        .unwrap()
        .iter()
        .map(|(pid, handle)| (*pid, Arc::clone(handle)))
        .collect::<Vec<_>>();
    for (pid, _handle) in processes {
        terminate_tree(pid).await;
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    #[tokio::test]
    async fn registered_processes_can_be_stopped_and_are_unregistered_on_drop() {
        let root = std::env::var_os("SystemRoot")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| r"C:\Windows".into());
        let sleeper = root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
        let mut command = tokio::process::Command::new(sleeper);
        command
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 30"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .creation_flags(0x08000000);
        let mut child = command.spawn().unwrap();
        let pid = child.id().unwrap();
        let registration = Registration::new(pid);
        assert!(children().lock().unwrap().contains_key(&pid));
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(
            child.try_wait().unwrap().is_none(),
            "The test child must be running before cancellation."
        );
        terminate_tree(pid).await;
        let status = tokio::time::timeout(std::time::Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap();
        assert!(!status.success());
        drop(registration);
        assert!(!children().lock().unwrap().contains_key(&pid));
    }
}
