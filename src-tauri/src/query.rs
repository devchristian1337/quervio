//! Commands behind Query Tabs. Each Query Tab owns one Session for its whole
//! life, so temp tables, SET options and transactions survive between
//! Executions, as in SSMS.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use quervio_core::connection::Environment;
use quervio_core::execution::{CancelToken, ExecutionEvent, Outcome};
use quervio_core::results::{CellValue, ResultLimits, SharedResults, SortDirection};
use quervio_core::session::{ServerInfo, Session};
use tauri::State;
use tauri::ipc::{Channel, Response};

use crate::explorer::{CommandResult, ExplorerState, message};

const APPLICATION_NAME: &str = "Quervio - Query";

#[derive(Default)]
pub struct QueryState {
    connections: Mutex<HashMap<String, quervio_core::connection::SavedConnection>>,
    sqlcmd: Mutex<HashMap<String, (String, std::time::Instant, quervio_core::sqlcmd::Script)>>,
    sessions: tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<Session>>>>,
    // The Environment each Session was opened with: the Production guard
    // follows the Server a tab is on, not what its Saved Connection says now.
    environments: Mutex<HashMap<String, Environment>>,
    // Kept apart from the sessions: cancelling must not wait for the
    // Session lock that the running Execution holds.
    running: Mutex<HashMap<String, CancelToken>>,
    // Also apart: the grid reads rows while the Execution is still writing them.
    results: Mutex<HashMap<String, SharedResults>>,
}

/// Characters of each cell sent to the grid; the value viewer fetches the rest.
const PREVIEW_CHARS: usize = 500;

/// Result data stays in Rust; only the local output path crosses the webview.
#[tauri::command]
pub async fn result_export_file(
    app: tauri::AppHandle,
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    path: std::path::PathBuf,
    format: String,
) -> CommandResult<()> {
    let results = state.results(&tab_id);
    let bridge = if format == "xlsx" {
        Some(
            crate::management::bridge_path(&app)
                .ok_or("Excel export requires the Microsoft bridge. Open Tools > Components.")?,
        )
    } else {
        None
    };
    if format != "csv" && format != "xlsx" {
        return Err("Choose CSV or XLSX.".into());
    }
    tokio::task::spawn_blocking(move || ->CommandResult<()> {
        use std::io::{Read,Write};
        let sets=results.read().unwrap();let data=sets.get(set).ok_or("This result no longer exists.")?;
        if data.has_clipped_cells(){return Err("This result contains truncated values. Increase the cell limit and rerun before exporting.".into());}
        if let Some(bridge)=bridge {
            let mut command=std::process::Command::new(bridge);command.arg("--result-export").stdin(std::process::Stdio::piped()).stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
            #[cfg(windows)] {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
            let mut child=command.spawn().map_err(message)?;
            let mut stdout=child.stdout.take().ok_or("Excel writer stdout missing.")?;
            let output=std::thread::spawn(move||{let mut result=String::new();stdout.read_to_string(&mut result).map(|_|result)});
            let write_result=(||->CommandResult<()> {
                let mut input=std::io::BufWriter::new(child.stdin.take().ok_or("Excel writer stdin missing.")?);
                serde_json::to_writer(&mut input,&serde_json::json!({"path":path,"columns":data.columns().iter().map(|c|c.name.clone()).collect::<Vec<_>>()})).map_err(message)?;writeln!(input).map_err(message)?;
                for row in 0..data.row_count(){let values=(0..data.columns().len()).map(|column|data.cell(row,column).and_then(|c|c.text)).collect::<Vec<_>>();serde_json::to_writer(&mut input,&values).map_err(message)?;writeln!(input).map_err(message)?;}
                writeln!(input,"{{\"end\":true}}").map_err(message)?;input.flush().map_err(message)?;Ok(())
            })();
            if write_result.is_err(){let _=child.kill();}
            let status=child.wait().map_err(message)?;
            let response=output.join().map_err(|_|"Excel writer output failed.")?.map_err(message)?;
            let last:Option<serde_json::Value>=response.lines().last().and_then(|line|serde_json::from_str(line).ok());
            // When the writer stops on a value, the broken pipe is only the symptom: report its reason.
            if let Some(error)=last.as_ref().filter(|l|l["type"]=="error"){return Err(error["message"].as_str().unwrap_or("Excel export failed.").into());}
            write_result?;
            let last=last.ok_or("Excel writer did not return a result.")?;
            if !status.success() || last["type"]!="result"{return Err(last["message"].as_str().unwrap_or("Excel export failed.").into());}
            Ok(())
        } else {
            let temporary=path.with_extension(format!("csv.partial.{}",uuid::Uuid::new_v4()));
            let result=(||->CommandResult<()> {let mut writer=std::io::BufWriter::new(std::fs::File::create(&temporary).map_err(message)?);data.write_csv(&mut writer).map_err(message)?;writer.flush().map_err(message)?;drop(writer);std::fs::rename(&temporary,&path).map_err(message)})();
            if result.is_err(){let _=std::fs::remove_file(&temporary);}result
        }
    }).await.map_err(message)?
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SqlcmdPreview {
    token: String,
    script: String,
    has_local_commands: bool,
}

#[tauri::command]
pub async fn query_sqlcmd_prepare(
    state: State<'_, QueryState>,
    tab_id: String,
    script: String,
    file_path: Option<String>,
    base_line: u32,
) -> CommandResult<SqlcmdPreview> {
    state.session(&tab_id).await?;
    let script = quervio_core::sqlcmd::prepare(
        &script,
        file_path.as_deref().map(std::path::Path::new),
        base_line,
    )?;
    let preview = script.preview();
    let has_local_commands = script.steps.iter().any(|s| {
        matches!(
            s,
            quervio_core::sqlcmd::Step::Shell(_) | quervio_core::sqlcmd::Step::Output { .. }
        )
    });
    let token = uuid::Uuid::new_v4().to_string();
    let mut pending = state.sqlcmd.lock().unwrap();
    pending.retain(|_, (_, created, _)| created.elapsed() < std::time::Duration::from_secs(300));
    if pending.len() >= 16 {
        return Err("Too many SQLCMD previews. Wait for earlier previews to expire.".into());
    }
    pending.insert(token.clone(), (tab_id, std::time::Instant::now(), script));
    Ok(SqlcmdPreview {
        token,
        script: preview,
        has_local_commands,
    })
}

fn sqlcmd_message(text: String, is_error: bool) -> ExecutionEvent {
    ExecutionEvent::Message {
        text,
        is_error,
        header: None,
        line: None,
    }
}

#[tauri::command]
pub async fn query_sqlcmd_execute(
    explorer: State<'_, ExplorerState>,
    state: State<'_, QueryState>,
    tab_id: String,
    token: String,
    confirmed: bool,
    options: ExecuteOptions,
    on_event: Channel<ExecutionEvent>,
) -> CommandResult<Outcome> {
    use quervio_core::sqlcmd::Step;
    use std::io::Write;
    if !confirmed {
        return Err("The expanded SQLCMD script was not confirmed.".into());
    }
    let (owner, created, script) = state
        .sqlcmd
        .lock()
        .unwrap()
        .remove(&token)
        .ok_or("SQLCMD preview expired or already used.")?;
    if owner != tab_id || created.elapsed() >= std::time::Duration::from_secs(300) {
        return Err("SQLCMD preview does not match this Query Tab or has expired.".into());
    }
    let session = state.session(&tab_id).await?;
    let cancel = CancelToken::new();
    {
        let mut running = state.running.lock().unwrap();
        if running.contains_key(&tab_id) {
            return Err("This Query Tab is already executing.".into());
        }
        running.insert(tab_id.clone(), cancel.clone());
    }
    let timer = (options.timeout_seconds > 0).then(|| {
        let cancel = cancel.clone();
        let timeout = options.timeout_seconds;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(timeout)).await;
            cancel.time_out();
        })
    });
    let started = std::time::Instant::now();
    let results = state.results(&tab_id);
    results.write().unwrap().clear();
    let mut active = session.lock().await;
    let mut outcome = Outcome::Succeeded;
    let mut exit_on_error = false;
    let mut output: Option<std::io::BufWriter<std::fs::File>> = None;
    let mut errors: Option<std::io::BufWriter<std::fs::File>> = None;
    // On any Rust/OS error, still settle the timer/running state and report actual transactions.
    let result: CommandResult<()> = async {
        'steps: for step in script.steps {
            if cancel.is_cancelled() {
                outcome = Outcome::Cancelled;
                break;
            }
            match step {
                Step::Sql { sql, lines, repeat } => {
                    for _ in 0..repeat {
                        let mut write_error = None;
                        let current = active
                            .execute_append(
                                &sql,
                                0,
                                &cancel,
                                &results,
                                options.limits(),
                                true,
                                |mut event| {
                                    if let ExecutionEvent::Message {
                                        line: Some(line),
                                        header,
                                        ..
                                    } = &mut event
                                    {
                                        if let Some(source) = line
                                            .checked_sub(1)
                                            .and_then(|line| lines.get(line as usize))
                                        {
                                            if let Some(file) = &source.file {
                                                *header = Some(format!("{file}:{}", source.line));
                                                *line = 0;
                                            } else {
                                                *line = source.line;
                                            }
                                        }
                                    }
                                    match &event {
                                        ExecutionEvent::Finished { .. } => return,
                                        ExecutionEvent::Message { text, is_error, .. } => {
                                            let writer = if *is_error {
                                                errors.as_mut().or(output.as_mut())
                                            } else {
                                                output.as_mut()
                                            };
                                            if let Some(writer) = writer {
                                                if let Err(error) = writeln!(writer, "{text}") {
                                                    write_error = Some(error.to_string());
                                                }
                                            }
                                        }
                                        ExecutionEvent::ResultSetFinished { index, .. } => {
                                            if let Some(writer) = output.as_mut() {
                                                let sets = results.read().unwrap();
                                                let text = sets[*index].copy_text(
                                                    0..sets[*index].row_count(),
                                                    0..sets[*index].columns().len(),
                                                    true,
                                                );
                                                if let Err(error) = writeln!(writer, "{text}") {
                                                    write_error = Some(error.to_string());
                                                }
                                            }
                                        }
                                        _ => {}
                                    }
                                    let _ = on_event.send(event);
                                },
                            )
                            .await;
                        if let Some(error) = write_error {
                            return Err(error);
                        }
                        if current == Outcome::Cancelled {
                            outcome = current;
                            break 'steps;
                        }
                        if current == Outcome::Failed {
                            outcome = current;
                            if exit_on_error {
                                break 'steps;
                            }
                        }
                    }
                }
                Step::OnError { exit } => exit_on_error = exit,
                Step::Quit => break,
                Step::Exit(sql) => {
                    if !sql.is_empty() {
                        active.command(&sql).await.map_err(message)?;
                    }
                    break;
                }
                Step::Output { path, error } => {
                    let writer = if path.eq_ignore_ascii_case("stdout")
                        || path.eq_ignore_ascii_case("stderr")
                    {
                        None
                    } else {
                        Some(std::io::BufWriter::new(
                            std::fs::File::create(path).map_err(message)?,
                        ))
                    };
                    if error {
                        if let Some(writer) = errors.as_mut() {
                            writer.flush().map_err(message)?;
                        }
                        errors = writer;
                    } else {
                        if let Some(writer) = output.as_mut() {
                            writer.flush().map_err(message)?;
                        }
                        output = writer;
                    }
                }
                Step::Shell(command) => {
                    let executable = std::env::var_os("SystemRoot")
                        .map(std::path::PathBuf::from)
                        .unwrap_or_else(|| "C:\\Windows".into())
                        .join("System32/cmd.exe");
                    let mut process = tokio::process::Command::new(executable);
                    process
                        .args(["/D", "/S", "/C", &command])
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::piped())
                        .stderr(std::process::Stdio::piped())
                        .kill_on_drop(true);
                    #[cfg(windows)]
                    process.creation_flags(0x08000000);
                    let child=process.spawn().map_err(message)?;
                    let pid=child.id();
                    let _registration=pid.map(crate::processes::Registration::new);
                    let process_output=child.wait_with_output();tokio::pin!(process_output);
                    let cancelled=async {loop{if cancel.is_cancelled(){break;}tokio::time::sleep(std::time::Duration::from_millis(100)).await;}};
                    let result=tokio::select!{result=&mut process_output=>Some(result.map_err(message)?),_=cancelled=>None};
                    let Some(result)=result else {
                        if let Some(pid)=pid {
                            let mut kill=tokio::process::Command::new(std::env::var_os("SystemRoot").map(std::path::PathBuf::from).unwrap_or_else(||"C:\\Windows".into()).join("System32/taskkill.exe"));
                            kill.args(["/PID",&pid.to_string(),"/T","/F"]).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
                            #[cfg(windows)] kill.creation_flags(0x08000000);
                            let _=kill.status().await;
                        }
                        outcome=Outcome::Cancelled;let _=on_event.send(sqlcmd_message(cancel.cancellation_message().into(),cancel.is_timed_out()));break 'steps;
                    };
                    for (bytes, error) in [(&result.stdout, false), (&result.stderr, true)] {
                        if !bytes.is_empty() {
                            let text = String::from_utf8_lossy(bytes).into_owned();
                            let writer = if error {
                                errors.as_mut().or(output.as_mut())
                            } else {
                                output.as_mut()
                            };
                            if let Some(writer) = writer {
                                writeln!(writer, "{text}").map_err(message)?;
                            }
                            let _ = on_event.send(sqlcmd_message(text, error));
                        }
                    }
                    if !result.status.success() {
                        outcome = Outcome::Failed;
                        if exit_on_error {
                            break;
                        }
                    }
                }
                Step::Connect {
                    server,
                    user,
                    password,
                    timeout,
                } => {
                    // A target switch closes the old connection, exactly as :connect specifies.
                    let rows = active
                        .query_table("SELECT @@TRANCOUNT", 1)
                        .await
                        .map_err(message)?;
                    if rows.rows.first().and_then(|r| r[0].as_deref()) != Some("0") {
                        return Err(
                            "End the open transaction before SQLCMD :connect changes servers."
                                .into(),
                        );
                    }
                    let mut connection = explorer.connection_from_server(&server)?;
                    let known_target=connection.server.eq_ignore_ascii_case(&server);
                    connection.server = server;
                    let password = if let Some(user_name) = user {
                        connection.authentication =
                            quervio_core::connection::Authentication::Sql { user_name };
                        password
                    } else {
                        connection.authentication =
                            quervio_core::connection::Authentication::Windows;
                        None
                    };
                    let opening=Session::open_with_timeout(&connection,password,"Quervio - SQLCMD",timeout);
                    let cancelled=async{loop{if cancel.is_cancelled(){break;}tokio::time::sleep(std::time::Duration::from_millis(100)).await;}};
                    let next=tokio::select!{next=opening=>next.map_err(message)?,_=cancelled=>{outcome=Outcome::Cancelled;let _=on_event.send(sqlcmd_message(cancel.cancellation_message().into(),cancel.is_timed_out()));break 'steps;}};
                    *active = next;
                    state
                        .connections
                        .lock()
                        .unwrap()
                        .insert(tab_id.clone(), connection.clone());
                    let info=active.server_info().await.map_err(message)?;
                    let _=on_event.send(ExecutionEvent::SessionChanged{server:info,connection_id:known_target.then_some(connection.id.clone())});
                    state
                        .environments
                        .lock()
                        .unwrap()
                        .insert(tab_id.clone(), connection.environment);
                    let _ = on_event.send(sqlcmd_message(
                        "SQLCMD changed the server for this Query Tab.".into(),
                        false,
                    ));
                }
            }
        }
        if let Some(writer) = output.as_mut() {
            writer.flush().map_err(message)?;
        }
        if let Some(writer) = errors.as_mut() {
            writer.flush().map_err(message)?;
        }
        Ok(())
    }
    .await;
    if let Err(error) = result {
        outcome = Outcome::Failed;
        let _ = on_event.send(sqlcmd_message(error, true));
    }
    let transactions = active
        .query_table("SELECT @@TRANCOUNT", 1)
        .await
        .ok()
        .and_then(|t| {
            t.rows
                .first()
                .and_then(|r| r[0].as_deref())
                .and_then(|n| n.parse().ok())
        })
        .unwrap_or(0);
    let _ = on_event.send(ExecutionEvent::Finished {
        outcome,
        elapsed_ms: started.elapsed().as_millis() as u64,
        database: active.database().to_string(),
        open_transactions: transactions,
    });
    if let Some(timer) = timer {
        timer.abort();
    }
    state.running.lock().unwrap().remove(&tab_id);
    Ok(outcome)
}

impl QueryState {
    async fn session(&self, tab_id: &str) -> CommandResult<Arc<tokio::sync::Mutex<Session>>> {
        self.sessions
            .lock()
            .await
            .get(tab_id)
            .cloned()
            .ok_or_else(|| "this Query Tab is not connected".to_string())
    }

    fn results(&self, tab_id: &str) -> SharedResults {
        self.results
            .lock()
            .unwrap()
            .entry(tab_id.to_string())
            .or_default()
            .clone()
    }

    /// Runs `read` on Result Set `set` of a tab, if it exists.
    fn with_set<T>(
        &self,
        tab_id: &str,
        set: usize,
        read: impl FnOnce(&quervio_core::results::ResultSet) -> T,
    ) -> CommandResult<T> {
        let results = self.results(tab_id);
        let sets = results.read().unwrap();
        let set = sets.get(set).ok_or("that result set no longer exists")?;
        Ok(read(set))
    }
}

/// Opens the Session of a Query Tab, optionally switching to `database`.
#[tauri::command]
pub async fn query_open(
    explorer: State<'_, ExplorerState>,
    state: State<'_, QueryState>,
    tab_id: String,
    connection_id: String,
    database: Option<String>,
) -> CommandResult<ServerInfo> {
    let mut connection = explorer.connection(&connection_id)?;
    if let Some(database) = &database {
        connection.default_database = Some(database.clone());
    }
    let password = explorer.credential(&connection, None).await?;
    let mut session = Session::open(&connection, password, APPLICATION_NAME)
        .await
        .map_err(message)?;
    if let Some(database) = database {
        session.use_database(&database).await.map_err(message)?;
    }
    let info = session.server_info().await.map_err(message)?;
    state
        .connections
        .lock()
        .unwrap()
        .insert(tab_id.clone(), connection.clone());
    state
        .environments
        .lock()
        .unwrap()
        .insert(tab_id.clone(), connection.environment);
    let previous = state
        .sessions
        .lock()
        .await
        .insert(tab_id, Arc::new(tokio::sync::Mutex::new(session)));
    drop(previous);
    Ok(info)
}

#[tauri::command]
pub async fn query_close(state: State<'_, QueryState>, tab_id: String) -> CommandResult<()> {
    state.connections.lock().unwrap().remove(&tab_id);
    state
        .sqlcmd
        .lock()
        .unwrap()
        .retain(|_, (id, _, _)| id != &tab_id);
    if let Some(cancel) = state.running.lock().unwrap().remove(&tab_id) {
        cancel.cancel();
    }
    state.results.lock().unwrap().remove(&tab_id);
    state.environments.lock().unwrap().remove(&tab_id);
    let session = state.sessions.lock().await.remove(&tab_id);
    if let Some(session) = session.and_then(|shared| Arc::try_unwrap(shared).ok()) {
        let _ = session.into_inner().close().await;
    }
    Ok(())
}

/// Runs `script` and streams its events; resolves when the Execution ends.
/// `allow_destructive` says the user confirmed Destructive Statements, or
/// turned the confirmation off; without it a Production Session refuses them.
#[tauri::command]
pub async fn query_execute(
    state: State<'_, QueryState>,
    tab_id: String,
    script: String,
    base_line: u32,
    options: ExecuteOptions,
    allow_destructive: bool,
    on_event: Channel<ExecutionEvent>,
) -> CommandResult<Outcome> {
    let environment = state.environments.lock().unwrap().get(&tab_id).copied();
    if options.plan_mode != "estimated"
        && !allow_destructive
        && needs_confirmation(environment, &script, base_line)
    {
        return Err(UNCONFIRMED.into());
    }
    let session = state.session(&tab_id).await?;
    let results = state.results(&tab_id);
    let cancel = CancelToken::new();
    {
        let mut running = state.running.lock().unwrap();
        if running.contains_key(&tab_id) {
            return Err("this Query Tab is already executing".into());
        }
        running.insert(tab_id.clone(), cancel.clone());
    }
    // The execution timeout cancels the query, as SSMS does.
    let timer = (options.timeout_seconds > 0).then(|| {
        let cancel = cancel.clone();
        let seconds = options.timeout_seconds;
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(seconds)).await;
            cancel.time_out();
        })
    });
    let mut active = session.lock().await;
    let plan_setup = match options.plan_mode.as_str() {
        "estimated" => Some(("SET SHOWPLAN_XML ON", "SET SHOWPLAN_XML OFF")),
        "actual" => Some(("SET STATISTICS XML ON", "SET STATISTICS XML OFF")),
        _ => None,
    };
    if let Some((setup, _)) = plan_setup {
        if options.plan_mode == "estimated" && script.to_ascii_uppercase().contains("SHOWPLAN_") {
            state.running.lock().unwrap().remove(&tab_id);
            if let Some(timer) = timer {
                timer.abort();
            }
            return Err(
                "Remove explicit SHOWPLAN settings before requesting an estimated plan.".into(),
            );
        }
        if let Err(error) = active.command(setup).await {
            state.running.lock().unwrap().remove(&tab_id);
            if let Some(timer) = timer {
                timer.abort();
            }
            return Err(message(error));
        }
    }
    let mut finished = None;
    let outcome = active
        .execute(
            &script,
            base_line,
            &cancel,
            &results,
            options.limits(),
            |event| {
                // The tab may have been closed meanwhile; nothing to deliver to.
                if plan_setup.is_some() && matches!(&event, ExecutionEvent::Finished { .. }) {
                    finished = Some(event);
                    return;
                }
                let _ = on_event.send(event);
            },
        )
        .await;
    let restored = if let Some((_, restore)) = plan_setup {
        active.command(restore).await.map_err(message)
    } else {
        Ok(Vec::new())
    };
    if restored.is_ok() {
        if let Some(mut event) = finished {
            let transactions = active
                .query_table("SELECT @@TRANCOUNT", 1)
                .await
                .map_err(message);
            if let (
                Ok(table),
                ExecutionEvent::Finished {
                    open_transactions, ..
                },
            ) = (transactions, &mut event)
            {
                *open_transactions = table
                    .rows
                    .first()
                    .and_then(|row| row[0].as_deref())
                    .and_then(|n| n.parse().ok())
                    .unwrap_or(0);
            }
            let _ = on_event.send(event);
        }
    }
    drop(active);
    if let Some(timer) = timer {
        timer.abort();
    }
    state.running.lock().unwrap().remove(&tab_id);
    if let Err(error) = restored {
        state.sessions.lock().await.remove(&tab_id);
        let reason =
            format!("Plan settings could not be restored; the Session was closed. {error}");
        let _ = on_event.send(ExecutionEvent::SessionClosed {
            reason: reason.clone(),
        });
        return Err(reason);
    }
    Ok(outcome)
}

const UNCONFIRMED: &str = "Destructive Statements on a Production server need confirmation, and none was given; nothing was run.";

/// Whether a script must be confirmed before it runs on a Session opened
/// with `environment`. A tab with no known Environment counts as Production.
fn needs_confirmation(environment: Option<Environment>, script: &str, base_line: u32) -> bool {
    !matches!(
        environment,
        Some(Environment::Test | Environment::Development)
    ) && quervio_core::guard::check(script, base_line).needs_confirmation()
}

/// Per-Execution options from the user's settings.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteOptions {
    #[serde(default)]
    plan_mode: String,
    /// Seconds before the query is cancelled; 0 waits forever.
    timeout_seconds: u64,
    max_rows: usize,
    max_cell_bytes: usize,
}

impl ExecuteOptions {
    fn limits(&self) -> ResultLimits {
        let defaults = ResultLimits::default();
        ResultLimits {
            max_rows: if self.max_rows == 0 {
                defaults.max_rows
            } else {
                self.max_rows
            },
            max_cell_bytes: if self.max_cell_bytes == 0 {
                defaults.max_cell_bytes
            } else {
                self.max_cell_bytes
            },
        }
    }
}

#[tauri::command]
pub fn query_cancel(state: State<'_, QueryState>, tab_id: String) {
    if let Some(cancel) = state.running.lock().unwrap().get(&tab_id) {
        cancel.cancel();
    }
}

/// A window of rows in the binary layout of `ResultSet::window`.
#[tauri::command]
pub fn result_rows(
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    start: usize,
    count: usize,
) -> CommandResult<Response> {
    state
        .with_set(&tab_id, set, |set| set.window(start, count, PREVIEW_CHARS))
        .map(Response::new)
}

/// Sorts a Result Set by one column, or restores the Server's order with
/// `None`. The grid then reads its rows again.
#[tauri::command]
pub fn result_sort(
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    column: Option<usize>,
    direction: SortDirection,
) -> CommandResult<()> {
    let results = state.results(&tab_id);
    let mut sets = results.write().unwrap();
    let set = sets
        .get_mut(set)
        .ok_or("that result set no longer exists")?;
    set.sort(column.map(|column| (column, direction)));
    Ok(())
}

/// The full text of one cell, for the value viewer.
#[tauri::command]
pub fn result_cell(
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    row: usize,
    column: usize,
) -> CommandResult<Option<CellValue>> {
    state.with_set(&tab_id, set, |set| set.cell(row, column))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CopyFormat {
    /// Tab-separated, as SSMS copies.
    Text,
    TextWithHeaders,
    /// Markdown table, for pasting into an LLM.
    Markdown,
}

/// What a copy put on the clipboard, for the confirmation shown to the user.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CopySummary {
    rows: usize,
    columns: usize,
}

/// Puts a block of cells on the Windows clipboard. Written from Rust so large
/// copies never cross into the webview and do not depend on its focus.
#[tauri::command]
pub fn result_copy(
    app: tauri::AppHandle,
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    rows: (usize, usize),
    columns: (usize, usize),
    format: CopyFormat,
) -> CommandResult<CopySummary> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    let (text, summary) = state.with_set(&tab_id, set, |set| {
        let rows = rows.0.min(set.row_count())..rows.1.min(set.row_count());
        let columns = columns.0.min(set.columns().len())..columns.1.min(set.columns().len());
        let summary = CopySummary {
            rows: rows.len(),
            columns: columns.len(),
        };
        let text = match format {
            CopyFormat::Text => set.copy_text(rows, columns, false),
            CopyFormat::TextWithHeaders => set.copy_text(rows, columns, true),
            CopyFormat::Markdown => set.markdown(rows, columns),
        };
        (text, summary)
    })?;
    app.clipboard().write_text(text).map_err(message)?;
    Ok(summary)
}

/// Writes a whole Result Set to `path` as a Markdown table.
#[tauri::command]
pub fn result_export_markdown(
    state: State<'_, QueryState>,
    tab_id: String,
    set: usize,
    path: std::path::PathBuf,
) -> CommandResult<()> {
    use std::io::Write;
    let file = std::fs::File::create(&path).map_err(message)?;
    let mut writer = std::io::BufWriter::new(file);
    state
        .with_set(&tab_id, set, |set| {
            set.write_markdown(&mut writer, 0..usize::MAX, 0..usize::MAX)
        })?
        .and_then(|()| writer.flush())
        .map_err(message)
}

/// Destructive Statements in a script, checked before running it on Production.
#[tauri::command]
pub fn query_check(script: String, base_line: u32) -> quervio_core::guard::Check {
    quervio_core::guard::check(&script, base_line)
}

/// Switches the Query Tab's Session to `database` and returns the database
/// it is now in.
#[tauri::command]
pub async fn query_use_database(
    explorer: State<'_, ExplorerState>,
    state: State<'_, QueryState>,
    tab_id: String,
    database: String,
) -> CommandResult<String> {
    if state.running.lock().unwrap().contains_key(&tab_id) {
        return Err("wait for the running query to finish".into());
    }
    let session = state.session(&tab_id).await?;
    let mut session = session.lock().await;
    let engine = session
        .query_table(
            "SELECT CAST(SERVERPROPERTY('EngineEdition') AS int),@@TRANCOUNT",
            1,
        )
        .await
        .map_err(message)?;
    if engine.rows.first().and_then(|row| row[0].as_deref()) == Some("5")
        && session.database() != database
    {
        if engine.rows.first().and_then(|row| row[1].as_deref()) != Some("0") {
            return Err("End the transaction before switching Azure SQL databases.".into());
        }
        let mut connection = state
            .connections
            .lock()
            .unwrap()
            .get(&tab_id)
            .cloned()
            .ok_or("Query connection is unavailable.")?;
        connection.default_database = Some(database.clone());
        let credential = explorer.credential(&connection, None).await?;
        *session = Session::open(&connection, credential, APPLICATION_NAME)
            .await
            .map_err(message)?;
        state
            .connections
            .lock()
            .unwrap()
            .insert(tab_id.clone(), connection);
        return Ok(database);
    }
    session.use_database(&database).await.map_err(message)?;
    Ok(session.database().to_string())
}

/// Commits or rolls back every open transaction of the Query Tab's Session;
/// returns how many remain.
#[tauri::command]
pub async fn query_end_transactions(
    state: State<'_, QueryState>,
    tab_id: String,
    commit: bool,
) -> CommandResult<i64> {
    let session = state.session(&tab_id).await?;
    let mut session = session.lock().await;
    session.end_transactions(commit).await.map_err(message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn production_sessions_refuse_unconfirmed_destructive_statements() {
        let drop = "DROP TABLE dbo.Customers";
        assert!(needs_confirmation(Some(Environment::Production), drop, 0));
        // A tab whose Environment is not known is treated as Production.
        assert!(needs_confirmation(None, drop, 0));
        assert!(!needs_confirmation(Some(Environment::Development), drop, 0));
        assert!(!needs_confirmation(Some(Environment::Test), drop, 0));
        assert!(!needs_confirmation(
            Some(Environment::Production),
            "SELECT 1",
            0
        ));
    }
}
