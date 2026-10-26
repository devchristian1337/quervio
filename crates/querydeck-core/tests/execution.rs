//! Executing Query Tab scripts against the SQL Server from `docker-compose.yml`:
//!
//! ```text
//! docker compose up -d --wait
//! cargo test -p querydeck-core --test execution -- --ignored
//! ```

use std::time::{Duration, Instant};

use querydeck_core::execution::{CancelToken, ExecutionEvent, Outcome};
use querydeck_core::results::{ResultLimits, SharedResults};
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
        .execute(
            script,
            base_line,
            &CancelToken::new(),
            &SharedResults::default(),
            ResultLimits::default(),
            |event| {
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
                    ExecutionEvent::ResultSetFinished { index, rows } => {
                        format!("end {index}: {rows}")
                    }
                    ExecutionEvent::ResultSetRows { index, rows } => {
                        format!("progress {index}: {rows}")
                    }
                    ExecutionEvent::Finished {
                        outcome,
                        database,
                        open_transactions,
                        ..
                    } => {
                        format!("done {outcome:?} in {database}, tran {open_transactions}")
                    }
                })
            },
        )
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
            &SharedResults::default(),
            ResultLimits::default(),
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

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn stores_values_formatted_like_ssms() {
    let mut session = open().await;
    let results = SharedResults::default();
    let script = "SELECT
        CAST(1 AS bit) AS b, CAST(255 AS tinyint) AS ti, CAST(-12 AS smallint) AS si,
        CAST(2147483647 AS int) AS i, CAST(9223372036854775807 AS bigint) AS bi,
        CAST(123.45 AS decimal(10, 2)) AS d, CAST(1500 AS money) AS m, CAST(-0.5 AS smallmoney) AS sm,
        CAST(1.5 AS float) AS f, CAST(0.25 AS real) AS r,
        N'àèìòù €' AS s, CAST(NULL AS int) AS n,
        CAST('2026-10-26' AS date) AS dt,
        CAST('2026-10-26 21:05:09.123' AS datetime) AS dtm,
        CAST('2026-10-26 21:05:00' AS smalldatetime) AS sdt,
        CAST('2026-10-26 21:05:09.1234567' AS datetime2(7)) AS dt2,
        CAST('21:05:09.12' AS time(2)) AS tm,
        CAST('2026-10-26 21:05:09.123 +02:00' AS datetimeoffset(3)) AS dto,
        CAST('6F9619FF-8B86-D011-B42D-00C04FC964FF' AS uniqueidentifier) AS u,
        CAST(0x00ABFF AS varbinary(3)) AS vb,
        CAST('<a>1</a>' AS xml) AS x,
        CAST('1753-01-01' AS datetime) AS old;";
    let outcome = session
        .execute(
            script,
            0,
            &CancelToken::new(),
            &results,
            ResultLimits::default(),
            |_| {},
        )
        .await;
    assert_eq!(outcome, Outcome::Succeeded);
    let sets = results.read().unwrap();
    let set = &sets[0];
    let row: Vec<_> = (0..set.columns().len())
        .map(|c| {
            set.cell(0, c)
                .unwrap()
                .text
                .unwrap_or_else(|| "NULL".into())
        })
        .collect();
    assert_eq!(
        row,
        [
            "1",
            "255",
            "-12",
            "2147483647",
            "9223372036854775807",
            "123.45",
            "1500.0000",
            "-0.5000",
            "1.5",
            "0.25",
            "àèìòù €",
            "NULL",
            "2026-10-26",
            "2026-10-26 21:05:09.123",
            "2026-10-26 21:05:00",
            "2026-10-26 21:05:09.1234567",
            "21:05:09.12",
            "2026-10-26 21:05:09.123 +02:00",
            "6F9619FF-8B86-D011-B42D-00C04FC964FF",
            "0x00ABFF",
            "<a>1</a>",
            "1753-01-01 00:00:00.000",
        ]
    );
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn the_row_limit_stops_the_execution_and_keeps_the_session() {
    let mut session = open().await;
    let results = SharedResults::default();
    let limits = ResultLimits {
        max_rows: 10,
        ..ResultLimits::default()
    };
    let mut log = Vec::new();
    let outcome = session
        .execute(
            "SELECT TOP (100000) a.object_id FROM sys.all_objects a CROSS JOIN sys.all_objects b;\nSELECT 2;",
            0,
            &CancelToken::new(),
            &results,
            limits,
            |event| log.push(format!("{event:?}")),
        )
        .await;
    assert_eq!(outcome, Outcome::Cancelled);
    assert_eq!(
        results.read().unwrap().len(),
        1,
        "second statement must not run"
    );
    assert_eq!(results.read().unwrap()[0].row_count(), 10);
    assert!(
        log.iter().any(|e| e.contains("limit of 10 rows")),
        "{log:#?}"
    );

    let (outcome, _) = run(&mut session, "SELECT 1;", 0).await;
    assert_eq!(outcome, Outcome::Succeeded);
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn large_result_sets_report_progress() {
    let mut session = open().await;
    let results = SharedResults::default();
    let mut progress = 0;
    session
        .execute(
            "SELECT TOP (300000) a.object_id, b.name FROM sys.all_objects a CROSS JOIN sys.all_objects b;",
            0,
            &CancelToken::new(),
            &results,
            ResultLimits::default(),
            |event| {
                if matches!(event, ExecutionEvent::ResultSetRows { .. }) {
                    progress += 1;
                }
            },
        )
        .await;
    assert_eq!(results.read().unwrap()[0].row_count(), 300_000);
    assert!(progress > 0, "no progress events while streaming");
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn ending_transactions_commits_or_rolls_back_all_levels() {
    let mut session = open().await;
    run(
        &mut session,
        "CREATE TABLE #t (x int);\nBEGIN TRAN; INSERT #t VALUES (1); BEGIN TRAN; INSERT #t VALUES (2);",
        0,
    )
    .await;
    assert_eq!(session.end_transactions(true).await.unwrap(), 0);
    let (_, log) = run(&mut session, "BEGIN TRAN; INSERT #t VALUES (3);", 0).await;
    assert_eq!(log.last().unwrap(), "done Succeeded in master, tran 1");
    assert_eq!(session.end_transactions(false).await.unwrap(), 0);

    let results = SharedResults::default();
    session
        .execute(
            "SELECT x FROM #t ORDER BY x",
            0,
            &CancelToken::new(),
            &results,
            ResultLimits::default(),
            |_| {},
        )
        .await;
    let sets = results.read().unwrap();
    let values: Vec<_> = (0..sets[0].row_count())
        .map(|row| sets[0].cell(row, 0).unwrap().text.unwrap())
        .collect();
    assert_eq!(
        values,
        ["1", "2"],
        "committed rows stay, the rolled back one is gone"
    );
}
