//! SQL Tools Service broker. The webview never receives credentials or raw process access.
//!
//! One reader task owns the service's output: it hands each reply to the
//! request waiting for it, answers the service's own requests, keeps the
//! connection events, and sends each tab's diagnostics to the webview as
//! the service publishes them ("language-diagnostics"). Waiting is therefore
//! safe to cut short with a timeout: no read is ever left half done.
use crate::{
    explorer::{CommandResult, ExplorerState, message},
    management::selected_component,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Emitter, Manager, State};

/// Receives each document's diagnostics as the service publishes them.
type OnDiagnostics = Arc<dyn Fn(&str, &Value) + Send + Sync>;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
    sync::{Notify, oneshot},
    task::JoinHandle,
};

#[derive(Default)]
pub struct LanguageState {
    client: tokio::sync::Mutex<Option<Client>>,
}

#[derive(Default)]
struct Shared {
    pending: HashMap<u64, oneshot::Sender<Value>>,
    /// connection/complete and textDocument/intelliSenseReady, until taken.
    events: Vec<Value>,
    stopped: bool,
}

struct Client {
    _registration: crate::processes::Registration,
    _child: Child,
    input: Arc<tokio::sync::Mutex<ChildStdin>>,
    shared: Arc<Mutex<Shared>>,
    changed: Arc<Notify>,
    reader: JoinHandle<()>,
    seq: u64,
    /// The text the service holds for each open document.
    documents: HashMap<String, String>,
    contexts: HashMap<String, String>,
}

impl Drop for Client {
    fn drop(&mut self) {
        self.reader.abort();
    }
}

pub(crate) fn service_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    if let Some(p) = selected_component(app, "language") {
        return Some(p);
    }
    let mut paths = Vec::new();
    if let Some(path) = std::env::var_os("QUERVIO_SQLTOOLS_SERVICE") {
        paths.push(PathBuf::from(path));
    }
    if let Ok(dir) = app.path().app_data_dir() {
        paths.push(dir.join("components/sqltools/MicrosoftSqlToolsServiceLayer.exe"));
        paths.push(dir.join("components/sqltools/Microsoft.SqlTools.ServiceLayer.exe"));
    }
    paths.into_iter().find(|p| p.is_file())
}

/// The LSP position just past the end of `text`: its last line, and that
/// line's length in UTF-16 code units, as the protocol counts characters.
fn end_of(text: &str) -> (usize, usize) {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let line = normalized.matches('\n').count();
    let last = normalized.rsplit('\n').next().unwrap_or("");
    (line, last.encode_utf16().count())
}

/// The tab a document belongs to: file:///quervio/<tab>.sql.
fn tab_of(uri: &str) -> Option<&str> {
    uri.strip_prefix("file:///quervio/")?.strip_suffix(".sql")
}

async fn write(input: &tokio::sync::Mutex<ChildStdin>, value: &Value) -> CommandResult<()> {
    let body = serde_json::to_vec(value).map_err(message)?;
    let mut input = input.lock().await;
    input
        .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
        .await
        .map_err(message)?;
    input.write_all(&body).await.map_err(message)?;
    input.flush().await.map_err(message)
}

async fn read_message(output: &mut BufReader<ChildStdout>) -> Option<Value> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if output.read_line(&mut line).await.ok()? == 0 {
            return None;
        }
        if line.trim().is_empty() {
            break;
        }
        if let Some((key, value)) = line.split_once(':') {
            if key.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse::<usize>().ok();
            }
        }
    }
    let length = length.filter(|l| *l <= 32 * 1024 * 1024)?;
    let mut body = vec![0; length];
    output.read_exact(&mut body).await.ok()?;
    serde_json::from_slice(&body).ok()
}

async fn read_loop(
    on_diagnostics: OnDiagnostics,
    mut output: BufReader<ChildStdout>,
    input: Arc<tokio::sync::Mutex<ChildStdin>>,
    shared: Arc<Mutex<Shared>>,
    changed: Arc<Notify>,
) {
    while let Some(value) = read_message(&mut output).await {
        let method = value["method"].as_str().map(str::to_owned);
        match method.as_deref() {
            // A request from the service: answered, so it never waits on us.
            Some(_) if !value["id"].is_null() => {
                let _ = write(
                    &input,
                    &json!({"jsonrpc":"2.0","id":value["id"],"result":null}),
                )
                .await;
            }
            Some("textDocument/publishDiagnostics") => {
                if let Some(uri) = value["params"]["uri"].as_str() {
                    on_diagnostics(uri, &value["params"]["diagnostics"]);
                }
            }
            Some("connection/complete" | "textDocument/intelliSenseReady") => {
                shared.lock().unwrap().events.push(value);
                changed.notify_waiters();
            }
            Some(_) => {}
            None => {
                let waiter = value["id"]
                    .as_u64()
                    .and_then(|id| shared.lock().unwrap().pending.remove(&id));
                if let Some(waiter) = waiter {
                    let _ = waiter.send(value);
                }
            }
        }
    }
    let mut shared = shared.lock().unwrap();
    shared.stopped = true;
    // Dropping the senders wakes every request still waiting.
    shared.pending.clear();
    changed.notify_waiters();
}

impl Client {
    async fn open(path: PathBuf, on_diagnostics: OnDiagnostics) -> CommandResult<Self> {
        let mut command = Command::new(path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(message)?;
        let registration = crate::processes::Registration::new(
            child
                .id()
                .ok_or("Language service process ID is missing.")?,
        );
        let input = Arc::new(tokio::sync::Mutex::new(
            child
                .stdin
                .take()
                .ok_or("SQL Tools Service stdin unavailable")?,
        ));
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("SQL Tools Service stdout unavailable")?,
        );
        let shared = Arc::new(Mutex::new(Shared::default()));
        let changed = Arc::new(Notify::new());
        let reader = tokio::spawn(read_loop(
            on_diagnostics,
            output,
            input.clone(),
            shared.clone(),
            changed.clone(),
        ));
        let mut client = Self {
            _registration: registration,
            _child: child,
            input,
            shared,
            changed,
            reader,
            seq: 0,
            documents: HashMap::new(),
            contexts: HashMap::new(),
        };
        client
            .request(
                "initialize",
                json!({"processId":std::process::id(),"rootUri":null,"capabilities":{}}),
            )
            .await?;
        client.notify("initialized", json!({})).await?;
        Ok(client)
    }
    async fn notify(&mut self, method: &str, params: Value) -> CommandResult<()> {
        write(
            &self.input,
            &json!({"jsonrpc":"2.0","method":method,"params":params}),
        )
        .await
    }
    async fn request(&mut self, method: &str, params: Value) -> CommandResult<Value> {
        self.seq += 1;
        let id = self.seq;
        let (sender, receiver) = oneshot::channel();
        {
            let mut shared = self.shared.lock().unwrap();
            if shared.stopped {
                return Err("SQL Tools Service stopped.".into());
            }
            shared.pending.insert(id, sender);
        }
        write(
            &self.input,
            &json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        )
        .await?;
        let reply = receiver
            .await
            .map_err(|_| "SQL Tools Service stopped.".to_string())?;
        if !reply["error"].is_null() {
            return Err(reply["error"]["message"]
                .as_str()
                .unwrap_or("Language service error")
                .into());
        }
        Ok(reply["result"].clone())
    }
    /// Takes the first `method` event for `uri`, waiting up to `limit`.
    async fn event(&self, uri: &str, method: &str, limit: Duration) -> Option<Value> {
        let deadline = tokio::time::Instant::now() + limit;
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            {
                let mut shared = self.shared.lock().unwrap();
                if let Some(index) = shared
                    .events
                    .iter()
                    .position(|e| e["method"] == method && e["params"]["ownerUri"] == uri)
                {
                    return Some(shared.events.remove(index));
                }
                if shared.stopped {
                    return None;
                }
            }
            if tokio::time::timeout_at(deadline, notified).await.is_err() {
                return None;
            }
        }
    }
    /// Connects a document to a database; `options` as connection/connect takes them.
    async fn connect(&mut self, uri: &str, options: Value) -> CommandResult<()> {
        if self.contexts.contains_key(uri) {
            self.request("connection/disconnect", json!({"ownerUri":uri}))
                .await?;
        }
        self.forget_events(uri);
        self.request(
            "connection/connect",
            json!({"ownerUri":uri,"connection":{"options":options}}),
        )
        .await?;
        // A successful request only starts connection establishment.
        let complete = self
            .event(uri, "connection/complete", Duration::from_secs(20))
            .await
            .ok_or("SQL Tools Service did not finish connecting.")?;
        match complete["params"]["errorMessage"].as_str() {
            Some(error) if !error.is_empty() => Err(error.to_string()),
            _ => Ok(()),
        }
    }
    /// Gives the service the document's current text.
    async fn sync(&mut self, uri: &str, text: String) -> CommandResult<()> {
        self.seq += 1;
        let version = self.seq;
        match self.documents.get(uri) {
            None => {
                self.notify("textDocument/didOpen", json!({"textDocument":{"uri":uri,"languageId":"sql","version":version,"text":text}})).await?;
                self.documents.insert(uri.into(), text);
                // Before its first binding the service answers every request empty.
                let _ = self
                    .event(uri, "textDocument/intelliSenseReady", Duration::from_secs(10))
                    .await;
            }
            Some(old) if *old == text => {}
            Some(old) => {
                // The service applies only ranged edits: this one replaces all the old text.
                let (line, character) = end_of(old);
                self.notify("textDocument/didChange", json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"range":{"start":{"line":0,"character":0},"end":{"line":line,"character":character}},"text":text}]})).await?;
                self.documents.insert(uri.into(), text);
            }
        }
        Ok(())
    }
    fn forget_events(&self, uri: &str) {
        self.shared
            .lock()
            .unwrap()
            .events
            .retain(|e| e["params"]["ownerUri"] != uri);
    }
}

#[tauri::command]
pub async fn language_request(
    app: tauri::AppHandle,
    explorer: State<'_, ExplorerState>,
    state: State<'_, LanguageState>,
    tab_id: String,
    id: String,
    database: String,
    text: String,
    line: u32,
    character: u32,
    method: String,
    metadata_revision: u64,
) -> CommandResult<Value> {
    let rpc = match method.as_str() {
        "completion" => "textDocument/completion",
        "signature" => "textDocument/signatureHelp",
        "hover" => "textDocument/hover",
        "sync" => "textDocument/hover",
        _ => return Err("Unsupported language request.".into()),
    };
    let path=service_path(&app).ok_or("SQL Tools Service is not configured. Open Tools > Components to select the official service executable.")?;
    let mut slot = state.client.lock().await;
    let result=tokio::time::timeout(Duration::from_secs(25),async {
        if slot.is_none() {
            let app=app.clone();
            let emit:OnDiagnostics=Arc::new(move|uri,diagnostics|{if let Some(tab)=tab_of(uri) {let _=app.emit("language-diagnostics",json!({"tabId":tab,"diagnostics":diagnostics}));}});
            *slot=Some(Client::open(path,emit).await?);
        }
        let client=slot.as_mut().unwrap();
        let uri=format!("file:///quervio/{tab_id}.sql");
        let context=format!("{id}\n{database}\n{metadata_revision}");
        if client.contexts.get(&uri)!=Some(&context) {
            let connection=explorer.connection(&id)?;
            let credential=explorer.credential(&connection,None).await?;
            let entra=connection.authentication==quervio_core::connection::Authentication::Entra;
            let (authentication,user)=match connection.authentication {quervio_core::connection::Authentication::Sql{user_name}=>("SqlLogin",user_name),quervio_core::connection::Authentication::Entra=>("AzureMFA",String::new()),_=>("Integrated",String::new())};
            client.connect(&uri,json!({"server":connection.server,"database":database,"authenticationType":authentication,"user":user,"password":if entra{None}else{credential.clone()},"azureAccountToken":if entra{credential}else{None},"encrypt":match connection.encrypt {quervio_core::connection::Encrypt::Strict=>"Strict",quervio_core::connection::Encrypt::Optional=>"Optional",_=>"Mandatory"},"trustServerCertificate":connection.trust_server_certificate,"applicationName":"Quervio - IntelliSense"})).await?;
            client.contexts.insert(uri.clone(),context);
        }
        client.sync(&uri,text).await?;
        if method=="sync" {return Ok(json!({"result":null}));}
        let result=client.request(rpc,json!({"textDocument":{"uri":uri},"position":{"line":line,"character":character}})).await?;
        Ok(json!({"result":result}))
    }).await;
    match result {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            *slot = None;
            Err(error)
        }
        Err(_) => {
            *slot = None;
            Err("SQL Tools Service timed out; it will restart on the next request.".into())
        }
    }
}

#[tauri::command]
pub async fn language_close(state: State<'_, LanguageState>, tab_id: String) -> CommandResult<()> {
    let mut slot = state.client.lock().await;
    if let Some(client) = slot.as_mut() {
        let uri = format!("file:///quervio/{tab_id}.sql");
        let _ = tokio::time::timeout(Duration::from_secs(2), async {
            if client.documents.contains_key(&uri) {
                client
                    .notify("textDocument/didClose", json!({"textDocument":{"uri":uri}}))
                    .await?;
            }
            client
                .request("connection/disconnect", json!({"ownerUri":uri}))
                .await
        })
        .await;
        client.documents.remove(&uri);
        client.contexts.remove(&uri);
        client.forget_events(&uri);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_of_counts_lines_and_utf16_characters() {
        assert_eq!(end_of(""), (0, 0));
        assert_eq!(end_of("SELECT 1"), (0, 8));
        assert_eq!(end_of("SELECT 1\r\nFROM t\n"), (2, 0));
        assert_eq!(end_of("a\nSELECT N'😀'"), (1, 12));
    }

    /// Against the official service (QUERVIO_SQLTOOLS_SERVICE) and the test
    /// server of .env: an edit reaches the service, and the diagnostics of
    /// the edited text come by themselves.
    #[tokio::test]
    #[ignore = "requires SQL Tools Service and the Docker SQL Server"]
    async fn edits_reach_the_service_and_diagnostics_follow() {
        let path = PathBuf::from(std::env::var_os("QUERVIO_SQLTOOLS_SERVICE").expect("QUERVIO_SQLTOOLS_SERVICE"));
        let env = |key: &str| std::env::var(key).unwrap_or_else(|_| panic!("{key} is not set"));
        let (sender, mut published) = tokio::sync::mpsc::unbounded_channel::<Value>();
        let on_diagnostics: OnDiagnostics = Arc::new(move |_, d| {
            let _ = sender.send(d.clone());
        });
        let mut client = Client::open(path, on_diagnostics).await.expect("start the service");
        let uri = "file:///quervio/test.sql";
        client
            .connect(uri, json!({"server":env("QUERVIO_TEST_SERVER"),"database":"master","authenticationType":"SqlLogin","user":env("QUERVIO_TEST_USER"),"password":env("QUERVIO_TEST_PASSWORD"),"encrypt":"Mandatory","trustServerCertificate":true}))
            .await
            .expect("connect");
        client.sync(uri, "SELECT 1;\nSELECT NoSuchColumn FROM sys.objects;".into()).await.unwrap();
        client.sync(uri, "SELECT * FROM sys.".into()).await.unwrap();
        let completion = client
            .request("textDocument/completion", json!({"textDocument":{"uri":uri},"position":{"line":0,"character":18}}))
            .await
            .unwrap();
        let labels: Vec<String> = completion
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["label"].as_str().unwrap_or_default().to_owned())
            .collect();
        assert!(labels.iter().any(|l| l == "objects"), "completion after sys.: {labels:?}");
        let edited = tokio::time::timeout(Duration::from_secs(15), async {
            loop {
                let d = published.recv().await.unwrap();
                let messages: Vec<&str> = d.as_array().unwrap().iter().filter_map(|d| d["message"].as_str()).collect();
                if !messages.is_empty() && messages.iter().all(|m| !m.contains("NoSuchColumn")) {
                    return messages.join(" | ");
                }
            }
        })
        .await
        .expect("diagnostics of the edited text");
        assert!(!edited.is_empty());
    }

    #[test]
    fn tab_of_reads_the_document_uri() {
        assert_eq!(tab_of("file:///quervio/abc-1.sql"), Some("abc-1"));
        assert_eq!(tab_of("file:///other/abc.sql"), None);
    }
}
