//! Milestone 0: checks that `mssql-tds` covers what an SSMS clone needs
//! (docs/adr/0002-driver-mssql-tds.md) against a real SQL Server.
//!
//! Needs the container from `docker-compose.yml` and a `.env` copied from
//! `.env.example`, then:
//!
//! ```text
//! docker compose up -d --wait
//! cargo test -p quervio-core --test driver -- --ignored
//! ```

use std::sync::Arc;
use std::time::{Duration, Instant};

use mssql_tds::connection::tds_client::{
    BatchErrorMode, ExecuteOptions, ResultSet, StatementResult, TdsClient,
};
use mssql_tds::core::CancelHandle;
use mssql_tds::datatypes::column_values::ColumnValues;
use mssql_tds::error::Error;

mod common;
use common::connect;

async fn count_rows(client: &mut TdsClient) -> Result<u64, Error> {
    let mut rows = 0;
    while client.next_row().await?.is_some() {
        rows += 1;
    }
    Ok(rows)
}

async fn single_value(client: &mut TdsClient, sql: &str) -> ColumnValues {
    client.execute(sql.into(), ()).await.expect(sql);
    let row = client.next_row().await.expect(sql).expect("one row");
    client.close_query().await.expect("close");
    row.into_iter().next().expect("one column")
}

/// Walks a whole batch the way the Messages tab will, recording Messages,
/// row counts and errors in the order the driver surfaces them.
async fn walk_batch(client: &mut TdsClient, sql: &str, on_error: BatchErrorMode) -> Vec<String> {
    let mut log = Vec::new();
    let options = ExecuteOptions {
        on_error,
        ..Default::default()
    };
    let mut step = client.execute(sql.into(), options).await;
    loop {
        for message in client.take_info_messages() {
            log.push(format!("msg:{}", message.message));
        }
        match step {
            Ok(StatementResult::Rows) => {
                let rows = count_rows(client).await.expect("read rows");
                log.push(format!("rows:{rows}"));
                if let Some(count) = client.last_result_row_count() {
                    log.push(format!("count:{count}"));
                }
            }
            Ok(StatementResult::NoRows {
                rows_affected: Some(n),
            }) => log.push(format!("affected:{n}")),
            Ok(StatementResult::NoRows {
                rows_affected: None,
            }) => {}
            Ok(StatementResult::End) => break,
            Err(Error::SqlServerError { diagnostics }) => {
                for error in diagnostics.errors {
                    log.push(format!("err:{}@{:?}", error.message, error.line_number));
                }
                if !client.has_open_batch() {
                    break;
                }
            }
            Err(other) => panic!("unexpected error: {other:?}"),
        }
        step = client.advance().await;
    }
    log
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn connects_with_sql_login() {
    let mut client = connect().await;
    let version = single_value(&mut client, "SELECT @@VERSION").await;
    let ColumnValues::String(text) = version else {
        panic!("@@VERSION is not a string: {version:?}")
    };
    assert!(text.to_utf8_string().contains("SQL Server 2022"));
    assert!(client.is_encrypted());
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn messages_and_result_sets_arrive_in_order() {
    let mut client = connect().await;
    let log = walk_batch(
        &mut client,
        "PRINT 'before';
         SELECT 1 AS a UNION ALL SELECT 2;
         CREATE TABLE #t (x int);
         INSERT #t VALUES (1), (2), (3);
         RAISERROR('note', 10, 1);
         SELECT 'x' AS b;
         PRINT 'after';",
        BatchErrorMode::Abort,
    )
    .await;
    assert_eq!(
        log,
        [
            "msg:before",
            "rows:2",
            "count:2",
            "affected:3",
            "msg:note",
            "rows:1",
            "count:1",
            "msg:after",
        ]
    );
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn batch_continues_after_an_error_with_its_line() {
    let mut client = connect().await;
    let log = walk_batch(
        &mut client,
        "SELECT 1 AS a;\nRAISERROR('boom', 16, 1);\nSELECT 2 AS b;",
        BatchErrorMode::Continue,
    )
    .await;
    assert_eq!(
        log,
        ["rows:1", "count:1", "err:boom@Some(2)", "rows:1", "count:1"]
    );
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn cancel_while_server_is_busy_keeps_the_session() {
    let mut client = connect().await;
    client
        .execute(
            "CREATE TABLE #keep (x int); INSERT #keep VALUES (42);".into(),
            (),
        )
        .await
        .expect("setup");
    client.close_query().await.expect("close setup");

    let handle = Arc::new(CancelHandle::new());
    let canceller = Arc::clone(&handle);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        canceller.cancel();
    });

    let started = Instant::now();
    let result = client
        .execute(
            "WAITFOR DELAY '00:00:30'; SELECT 1;".into(),
            ExecuteOptions::new().cancel(&handle),
        )
        .await;
    assert!(
        matches!(result, Err(Error::OperationCancelledError(_))),
        "expected cancellation, got {result:?}"
    );
    eprintln!("WAITFOR cancelled after {:?}", started.elapsed());
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "cancel took {:?}",
        started.elapsed()
    );
    client.close_query().await.ok();

    let kept = single_value(&mut client, "SELECT x FROM #keep").await;
    assert!(
        matches!(kept, ColumnValues::Int(42)),
        "session lost: {kept:?}"
    );
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn cancel_while_streaming_rows_keeps_the_session() {
    let mut client = connect().await;
    client
        .execute(
            "CREATE TABLE #keep (x int); INSERT #keep VALUES (42);".into(),
            (),
        )
        .await
        .expect("setup");
    client.close_query().await.expect("close setup");

    let handle = Arc::new(CancelHandle::new());
    let result = client
        .execute(
            "SELECT TOP (50000000) a.object_id, b.name
             FROM sys.all_objects a CROSS JOIN sys.all_objects b CROSS JOIN sys.all_objects c;"
                .into(),
            ExecuteOptions::new().cancel(&handle),
        )
        .await
        .expect("start streaming");
    assert!(matches!(result, StatementResult::Rows));

    // Read a while from this task, cancel from another, as the UI will.
    let canceller = Arc::clone(&handle);
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(500)).await;
        canceller.cancel();
    });

    let started = Instant::now();
    let mut rows = 0u64;
    let outcome = loop {
        match client.next_row().await {
            Ok(Some(_)) => rows += 1,
            other => break other,
        }
    };
    assert!(
        matches!(outcome, Err(Error::OperationCancelledError(_))),
        "expected cancellation after {rows} rows, got {outcome:?}"
    );
    eprintln!(
        "streamed {rows} rows, cancel settled in {:?}",
        started.elapsed()
    );
    assert!(rows > 0 && rows < 50_000_000, "read {rows} rows");
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "cancel took {:?}",
        started.elapsed()
    );
    client.close_query().await.ok();

    let kept = single_value(&mut client, "SELECT x FROM #keep").await;
    assert!(
        matches!(kept, ColumnValues::Int(42)),
        "session lost: {kept:?}"
    );
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn money_and_decimal_38_are_exact() {
    let mut client = connect().await;

    let money = single_value(&mut client, "SELECT CAST(922337203685477.5807 AS money)").await;
    let ColumnValues::Money(money) = money else {
        panic!("not money: {money:?}")
    };
    let scaled = (i64::from(money.msb_part) << 32) | i64::from(money.lsb_part as u32);
    assert_eq!(scaled, i64::MAX, "money lost precision");

    let decimal = single_value(
        &mut client,
        "SELECT CAST('12345678901234567890123456789012345678' AS decimal(38, 0))",
    )
    .await;
    let (ColumnValues::Decimal(parts) | ColumnValues::Numeric(parts)) = decimal else {
        panic!("not decimal: {decimal:?}")
    };
    assert_eq!(parts.to_string(), "12345678901234567890123456789012345678");
}

#[tokio::test]
#[ignore = "needs SQL Server: docker compose up -d --wait"]
async fn use_statement_updates_the_current_database() {
    let mut client = connect().await;
    assert_eq!(client.database(), "master");
    client.execute("USE tempdb;".into(), ()).await.expect("USE");
    client.close_query().await.expect("close");
    assert_eq!(client.database(), "tempdb");
}
