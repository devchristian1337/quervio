//! SQL Tools Service broker. The webview never receives credentials or raw process access.
use crate::{
    explorer::{CommandResult, ExplorerState, message},
    management::selected_component,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    process::Stdio,
};
use tauri::{Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

#[derive(Default)]
pub struct LanguageState {
    client: tokio::sync::Mutex<Option<Client>>,
}
struct Client {
    _registration: crate::processes::Registration,
    _child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    seq: u64,
    documents: HashSet<String>,
    contexts: HashMap<String, String>,
    diagnostics: HashMap<String, Value>,
    events: VecDeque<Value>,
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
impl Client {
    async fn open(path: PathBuf) -> CommandResult<Self> {
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
        let input = child
            .stdin
            .take()
            .ok_or("SQL Tools Service stdin unavailable")?;
        let output = BufReader::new(
            child
                .stdout
                .take()
                .ok_or("SQL Tools Service stdout unavailable")?,
        );
        let mut client = Self {
            _registration: registration,
            _child: child,
            input,
            output,
            seq: 0,
            documents: HashSet::new(),
            contexts: HashMap::new(),
            diagnostics: HashMap::new(),
            events: VecDeque::new(),
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
    async fn write(&mut self, value: Value) -> CommandResult<()> {
        let body = serde_json::to_vec(&value).map_err(message)?;
        self.input
            .write_all(format!("Content-Length: {}\r\n\r\n", body.len()).as_bytes())
            .await
            .map_err(message)?;
        self.input.write_all(&body).await.map_err(message)?;
        self.input.flush().await.map_err(message)
    }
    async fn notify(&mut self, method: &str, params: Value) -> CommandResult<()> {
        self.write(json!({"jsonrpc":"2.0","method":method,"params":params}))
            .await
    }
    async fn read(&mut self) -> CommandResult<Value> {
        let mut length = None;
        loop {
            let mut line = String::new();
            if self.output.read_line(&mut line).await.map_err(message)? == 0 {
                return Err("SQL Tools Service stopped.".into());
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
        let length = length
            .filter(|l| *l <= 32 * 1024 * 1024)
            .ok_or("Invalid SQL Tools Service message size.")?;
        let mut body = vec![0; length];
        self.output.read_exact(&mut body).await.map_err(message)?;
        let value: Value = serde_json::from_slice(&body).map_err(message)?;
        if value["method"] == "connection/complete" {
            self.events.push_back(value.clone());
        }
        if value["method"] == "textDocument/publishDiagnostics" {
            if let Some(uri) = value["params"]["uri"].as_str() {
                self.diagnostics
                    .insert(uri.into(), value["params"]["diagnostics"].clone());
            }
        }
        Ok(value)
    }
    async fn request(&mut self, method: &str, params: Value) -> CommandResult<Value> {
        self.seq += 1;
        let id = self.seq;
        self.write(json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
            .await?;
        loop {
            let reply = self.read().await?;
            if reply["id"].as_u64() == Some(id) {
                if !reply["error"].is_null() {
                    return Err(reply["error"]["message"]
                        .as_str()
                        .unwrap_or("Language service error")
                        .into());
                }
                return Ok(reply["result"].clone());
            }
        }
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
    let result=tokio::time::timeout(std::time::Duration::from_secs(25),async {
        if slot.is_none() {*slot=Some(Client::open(path).await?);}
        let client=slot.as_mut().unwrap();
        let uri=format!("file:///quervio/{tab_id}.sql");
        let context=format!("{id}\n{database}\n{metadata_revision}");
        if client.contexts.get(&uri)!=Some(&context) {
            if client.contexts.contains_key(&uri) {client.request("connection/disconnect",json!({"ownerUri":uri})).await?;}
            let connection=explorer.connection(&id)?;
            let credential=explorer.credential(&connection,None).await?;
            let entra=connection.authentication==quervio_core::connection::Authentication::Entra;
            let (authentication,user)=match connection.authentication {quervio_core::connection::Authentication::Sql{user_name}=>("SqlLogin",user_name),quervio_core::connection::Authentication::Entra=>("AzureMFA",String::new()),_=>("Integrated",String::new())};
            client.request("connection/connect",json!({"ownerUri":uri,"connection":{"options":{"server":connection.server,"database":database,"authenticationType":authentication,"user":user,"password":if entra{None}else{credential.clone()},"azureAccountToken":if entra{credential}else{None},"encrypt":match connection.encrypt {quervio_core::connection::Encrypt::Strict=>"Strict",quervio_core::connection::Encrypt::Optional=>"Optional",_=>"Mandatory"},"trustServerCertificate":connection.trust_server_certificate,"applicationName":"Quervio - IntelliSense"}}})).await?;
            // A successful request only starts connection establishment.
            loop {if let Some(index)=client.events.iter().position(|event|event["params"]["ownerUri"]==uri) {let event=client.events.remove(index).unwrap();if let Some(error)=event["params"]["errorMessage"].as_str().filter(|s|!s.is_empty()) {return Err(error.to_string());}break;}client.read().await?;}
            client.contexts.insert(uri.clone(),context);
        }
        client.seq+=1;let version=client.seq;
        if client.documents.insert(uri.clone()) {client.notify("textDocument/didOpen",json!({"textDocument":{"uri":uri,"languageId":"sql","version":version,"text":text}})).await?;}
        else {client.notify("textDocument/didChange",json!({"textDocument":{"uri":uri,"version":version},"contentChanges":[{"text":text}]})).await?;}
        let result=client.request(rpc,json!({"textDocument":{"uri":uri},"position":{"line":line,"character":character}})).await?;
        Ok(json!({"result":result,"diagnostics":client.diagnostics.get(&uri).cloned().unwrap_or(json!([]))}))
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
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            client
                .notify("textDocument/didClose", json!({"textDocument":{"uri":uri}}))
                .await?;
            client
                .request("connection/disconnect", json!({"ownerUri":uri}))
                .await
        })
        .await;
        client.documents.remove(&uri);
        client.contexts.remove(&uri);
        client.diagnostics.remove(&uri);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "requires the installed SQL Tools Service component, no SQL connection needed"]
    async fn official_language_service_initializes_over_stdio() {
        let config = std::path::PathBuf::from(std::env::var_os("APPDATA").expect("APPDATA"))
            .join("com.quervio.app/components/language.json");
        let path: std::path::PathBuf = serde_json::from_slice(
            &std::fs::read(config).expect("install SQL Tools Service first"),
        )
        .unwrap();
        let client = tokio::time::timeout(std::time::Duration::from_secs(25), Client::open(path))
            .await
            .expect("language service startup timeout")
            .expect("initialize official service");
        assert_eq!(client.seq, 1);
    }
}
