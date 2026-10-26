//! Executing Query Tab scripts against the SQL Server from `docker-compose.yml`:
//!
//! ```text
//! docker compose up -d --wait
//! cargo test -p querydeck-core --test execution -- --ignored
//! ```

use std::time::{Duration, Instant};

use querydeck_core::execution::{CancelToken, ExecutionEvent, Outcome};
use querydeck_core::session::Session;

mod common;
use common::{password, saved_connection};

async fn open() -> Session {
    Session::open(&saved_connection(), password(), "Querydeck tests")
        .await
        .expect("open session")
}

/// Runs a script and renders its events compactly.
async fn run(session: &mut Session, script: &str, base_line: u32) -> (Outcome, Vec<String>) {
    let mut log = Vec::new();
    let outcome = session
        .execute(script, base_line, &CancelToken::new(), |event| {
            log.push(match event {
                ExecutionEvent::BatchStarted { batch, first_line } => {
                    format!("batch {batch}@{first_line}")
                }
                ExecutionEvent::Message {
                    text,
                    is_error: false,
                    ..
                } => format!("msg {text}"),
                ExecutionEvent::Message { header, line, .. } => {
                    format!("err {} -> {line:?}", header.unwrap_or_default())
                }
                ExecutionEvent::RowsAffected { count } => format!("affected {count}"),
                ExecutionEvent::ResultSetStarted { index, columns } => format!(
                    "set {index} [{}]",
                    columns
                        .iter()
                        .map(|c| c.name.as_str())
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                ExecutionEvent::ResultSetFinished { index, rows } => format!("end {index}: {rows}"),
                ExecutionEvent::Finished {
                    outcome,
                    database,
                    open_transactions,
                    ..
                } => {
                    format!("done {outcome:?} in {database}, tran {open_transactions}")
                }
            })
        })
        .await;
    (outcome, log)
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn runs_batches_in_order_and_continues_after_an_error() {
    let mut session = open().await;
    let script = "\
CREATE TABLE #t (x int);
INSERT #t VALUES (1), (2);
PRINT 'inserted';
GO
SELECT x AS value FROM #t;
SELECT * FROM missing_table;
GO 2
SELECT 'last' AS word;";
    let (outcome, log) = run(&mut session, script, 0).await;
    assert_eq!(outcome, Outcome::Failed);
    assert_eq!(
        log,
        [
            "batch 0@0",
            "affected 2",
            "msg inserted",
            "batch 1@4",
            "set 0 [value]",
            "end 0: 2",
            "affected 2",
            "err Msg 208, Level 16, State 1, Line 6 -> Some(6)",
            "batch 1@4",
            "set 1 [value]",
            "end 1: 2",
            "affected 2",
            "err Msg 208, Level 16, State 1, Line 6 -> Some(6)",
            "batch 2@7",
            "set 2 [word]",
            "end 2: 1",
            "affected 1",
            "done Failed in master, tran 0",
        ]
    );
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn a_selection_reports_lines_of_the_whole_editor() {
    let mut session = open().await;
    // The selection starts on editor line 10 (zero-based 9).
    let (_, log) = run(&mut session, "SELECT 1;\nRAISERROR('boom', 16, 1);", 9).await;
    assert!(
        log.contains(&"err Msg 50000, Level 16, State 1, Line 11 -> Some(11)".to_string()),
        "{log:#?}"
    );
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn reports_open_transactions_and_the_current_database() {
    let mut session = open().await;
    let (_, log) = run(&mut session, "USE tempdb;\nBEGIN TRANSACTION;", 0).await;
    assert_eq!(log.last().unwrap(), "done Succeeded in tempdb, tran 1");
    let (_, log) = run(&mut session, "ROLLBACK;", 0).await;
    assert_eq!(log.last().unwrap(), "done Succeeded in tempdb, tran 0");
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn cancel_stops_all_batches_and_keeps_the_session() {
    let mut session = open().await;
    let cancel = CancelToken::new();
    let canceller = cancel.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        canceller.cancel();
    });

    let started = Instant::now();
    let mut log = Vec::new();
    let outcome = session
        .execute(
            "CREATE TABLE #keep (x int);\nGO\nWAITFOR DELAY '00:00:30';\nGO\nSELECT 1;",
            0,
            &cancel,
            |event| log.push(format!("{event:?}")),
        )
        .await;
    assert_eq!(outcome, Outcome::Cancelled);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert!(
        log.iter().any(|e| e.contains("cancelled by user")),
        "{log:#?}"
    );
    assert!(
        !log.iter().any(|e| e.contains("batch: 2")),
        "third batch must not run: {log:#?}"
    );

    let (outcome, log) = run(&mut session, "SELECT COUNT(*) AS n FROM #keep;", 0).await;
    assert_eq!(outcome, Outcome::Succeeded, "{log:#?}");
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn use_database_switches_the_session() {
    let mut session = open().await;
    session.use_database("tempdb").await.unwrap();
    assert_eq!(session.database(), "tempdb");
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn statement_terminated_follows_its_error() {
    let mut session = open().await;
    let script = "CREATE TABLE #u (x int UNIQUE);\nINSERT #u VALUES (1);\nINSERT #u VALUES (1);";
    let (_, log) = run(&mut session, script, 0).await;
    let error = log
        .iter()
        .position(|l| l.starts_with("err Msg 2627"))
        .expect("duplicate key error");
    assert_eq!(
        log[error + 1],
        "msg The statement has been terminated.",
        "{log:#?}"
    );
}
