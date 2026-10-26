//! Running the script of a Query Tab: Batch by Batch, streaming Result Sets,
//! Messages and row counts in the order the Server sends them.

use std::sync::Arc;
use std::time::Instant;

use mssql_tds::connection::tds_client::{
    BatchErrorMode, ExecuteOptions, ResultSet, StatementResult,
};
use mssql_tds::core::CancelHandle;
use mssql_tds::error::Error as DriverError;
use serde::Serialize;

use crate::batch;
use crate::results::{ResultColumn, ResultLimits, ResultSet as StoredResultSet, SharedResults};
use crate::session::{Session, int};

/// Cancels a running Execution from another task.
#[derive(Clone, Default)]
pub struct CancelToken(Arc<CancelHandle>);

impl CancelToken {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn cancel(&self) {
        self.0.cancel();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Succeeded,
    Failed,
    Cancelled,
}

/// What an Execution reports, in order.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ExecutionEvent {
    #[serde(rename_all = "camelCase")]
    BatchStarted { batch: usize, first_line: u32 },
    /// A Message: `PRINT` output, a low-severity `RAISERROR`, or an error.
    #[serde(rename_all = "camelCase")]
    Message {
        text: String,
        is_error: bool,
        /// SSMS-style header for errors, e.g. `Msg 208, Level 16, State 1, Line 3`.
        header: Option<String>,
        /// One-based line in the editor the Message points at.
        line: Option<u32>,
    },
    #[serde(rename_all = "camelCase")]
    RowsAffected { count: u64 },
    #[serde(rename_all = "camelCase")]
    ResultSetStarted {
        index: usize,
        columns: Vec<ResultColumn>,
    },
    /// Rows read so far, sent a few times a second while a Result Set streams.
    #[serde(rename_all = "camelCase")]
    ResultSetRows { index: usize, rows: u64 },
    #[serde(rename_all = "camelCase")]
    ResultSetFinished { index: usize, rows: u64 },
    #[serde(rename_all = "camelCase")]
    Finished {
        outcome: Outcome,
        elapsed_ms: u64,
        database: String,
        open_transactions: i64,
    },
}

const CANCELLED: &str = "Query was cancelled by user.";

/// How often streaming Result Sets report their row count.
const PROGRESS_EVERY: std::time::Duration = std::time::Duration::from_millis(250);

impl Session {
    /// Runs `script`, whose first line is line `base_line` (zero-based) of the
    /// editor: the whole text, or the selection. Every Batch runs even when
    /// an earlier one failed, as in SSMS; cancelling stops everything.
    pub async fn execute(
        &mut self,
        script: &str,
        base_line: u32,
        cancel: &CancelToken,
        results: &SharedResults,
        limits: ResultLimits,
        mut emit: impl FnMut(ExecutionEvent),
    ) -> Outcome {
        let started = Instant::now();
        results.write().unwrap().clear();
        let mut outcome = Outcome::Succeeded;
        let mut result_sets = 0;

        'batches: for (index, batch) in batch::split(script).iter().enumerate() {
            let line_offset = base_line + batch.first_line;
            for _ in 0..batch.repeat {
                emit(ExecutionEvent::BatchStarted {
                    batch: index,
                    first_line: line_offset,
                });
                let options = ExecuteOptions {
                    cancel: Some(&cancel.0),
                    on_error: BatchErrorMode::Continue,
                    ..Default::default()
                };
                let mut step = self.client.execute(batch.text.clone(), options).await;
                loop {
                    // The driver buffers INFO apart from errors. For a failed
                    // statement they usually follow the error ("The statement
                    // has been terminated."), so drain them after it.
                    if !matches!(step, Err(DriverError::SqlServerError { .. })) {
                        self.drain_messages(&mut emit);
                    }
                    match step {
                        Ok(StatementResult::End) => break,
                        Ok(StatementResult::NoRows { rows_affected }) => {
                            if let Some(count) = rows_affected {
                                emit(ExecutionEvent::RowsAffected { count });
                            }
                        }
                        Ok(StatementResult::Rows) => {
                            let columns: Vec<_> = self
                                .client
                                .get_metadata()
                                .iter()
                                .map(|column| ResultColumn {
                                    name: column.column_name.clone(),
                                })
                                .collect();
                            results
                                .write()
                                .unwrap()
                                .push(StoredResultSet::new(columns.clone()));
                            emit(ExecutionEvent::ResultSetStarted {
                                index: result_sets,
                                columns,
                            });
                            let mut rows = 0u64;
                            let mut limited = false;
                            let mut last_progress = Instant::now();
                            let read = loop {
                                match self.client.next_row().await {
                                    Ok(Some(row)) => {
                                        results.write().unwrap()[result_sets]
                                            .push_row(&row, limits.max_cell_bytes);
                                        rows += 1;
                                        if rows as usize >= limits.max_rows {
                                            limited = true;
                                            break Ok(());
                                        }
                                        if rows.is_multiple_of(1024)
                                            && last_progress.elapsed() >= PROGRESS_EVERY
                                        {
                                            last_progress = Instant::now();
                                            emit(ExecutionEvent::ResultSetRows {
                                                index: result_sets,
                                                rows,
                                            });
                                        }
                                    }
                                    Ok(None) => break Ok(()),
                                    Err(error) => break Err(error),
                                }
                            };
                            if limited {
                                // Stop the Server too: reading on would only be thrown away.
                                let _ = self.client.cancel_query(0).await;
                                emit(ExecutionEvent::ResultSetFinished {
                                    index: result_sets,
                                    rows,
                                });
                                emit(message(
                                    &format!(
                                        "Stopped at the limit of {} rows per result set; the rest of the query was cancelled.",
                                        limits.max_rows
                                    ),
                                    true,
                                ));
                                outcome = Outcome::Cancelled;
                                break 'batches;
                            }
                            emit(ExecutionEvent::ResultSetFinished {
                                index: result_sets,
                                rows,
                            });
                            emit(ExecutionEvent::RowsAffected { count: rows });
                            result_sets += 1;
                            if let Err(error) = read {
                                // An error inside a row set is handled like any other.
                                step = Err(error);
                                continue;
                            }
                        }
                        Err(DriverError::OperationCancelledError(_)) => {
                            let _ = self.client.close_query().await;
                            self.drain_messages(&mut emit);
                            emit(message(CANCELLED, false));
                            outcome = Outcome::Cancelled;
                            break 'batches;
                        }
                        Err(DriverError::SqlServerError { diagnostics }) => {
                            outcome = Outcome::Failed;
                            for error in diagnostics.errors {
                                let line = error.line_number.and_then(|l| u32::try_from(l).ok());
                                let editor_line = line.map(|l| l + line_offset);
                                emit(ExecutionEvent::Message {
                                    text: error.message,
                                    is_error: true,
                                    header: Some(format!(
                                        "Msg {}, Level {}, State {}, Line {}",
                                        error.number,
                                        error.class,
                                        error.state,
                                        editor_line.unwrap_or(0)
                                    )),
                                    line: editor_line,
                                });
                            }
                            self.drain_messages(&mut emit);
                            if !self.client.has_open_batch() {
                                break;
                            }
                        }
                        Err(other) => {
                            // Transport or protocol failure: nothing after it can run.
                            let _ = self.client.close_query().await;
                            emit(message(&other.to_string(), true));
                            outcome = Outcome::Failed;
                            break 'batches;
                        }
                    }
                    step = self.client.advance().await;
                }
            }
        }

        let open_transactions = match self.query("SELECT @@TRANCOUNT").await {
            Ok(rows) => rows.first().and_then(|row| int(row, 0).ok()).unwrap_or(0),
            Err(_) => 0,
        };
        emit(ExecutionEvent::Finished {
            outcome,
            elapsed_ms: started.elapsed().as_millis() as u64,
            database: self.client.database().to_string(),
            open_transactions,
        });
        outcome
    }

    /// Severity 11+ arrives as an error; these are PRINT and RAISERROR <= 10.
    fn drain_messages(&mut self, emit: &mut impl FnMut(ExecutionEvent)) {
        for info in self.client.take_info_messages() {
            emit(message(&info.message, false));
        }
    }

    /// Makes `database` the current database of this Session.
    pub async fn use_database(&mut self, database: &str) -> crate::Result<()> {
        self.query(&format!("USE {}", crate::catalog::quote_name(database)))
            .await
            .map(|_| ())
    }

    pub fn database(&self) -> &str {
        self.client.database()
    }
}

fn message(text: &str, is_error: bool) -> ExecutionEvent {
    ExecutionEvent::Message {
        text: text.to_string(),
        is_error,
        header: None,
        line: None,
    }
}
