//! Opt-in tests against the repository's dedicated SQL Server test instance.
mod common;
use quervio_core::{
    execution::{CancelToken, ExecutionEvent, Outcome},
    management::{self, Resource},
    results::{ResultLimits, SharedResults},
    session::Session,
};

#[tokio::test]
#[ignore = "needs the dedicated SQL Server test instance"]
async fn management_catalog_and_capabilities_use_a_separate_session() {
    let _database = common::TestDatabase::create(
        "Quervio_Management_Catalog",
        "CREATE TABLE dbo.Items(Id int NOT NULL PRIMARY KEY,Name nvarchar(30));",
    )
    .await;
    let mut connection = common::saved_connection();
    connection.default_database = Some("Quervio_Management_Catalog".into());
    let mut session = Session::open(&connection, common::password(), "Quervio management tests")
        .await
        .unwrap();
    let caps = management::capabilities(&mut session).await.unwrap();
    assert!(caps.major_version >= 11);
    assert_eq!(caps.database, "Quervio_Management_Catalog");
    let objects = management::read(&mut session, Resource::Objects)
        .await
        .unwrap();
    assert!(
        objects
            .rows
            .iter()
            .any(|r| r[1].as_deref() == Some("Items"))
    );
    // The Activity Monitor's cards: one row, every figure filled on a box SQL Server.
    let health = management::read(&mut session, Resource::Health)
        .await
        .unwrap();
    assert_eq!(health.rows.len(), 1);
    let value = |name: &str| {
        let index = health.columns.iter().position(|c| c == name).unwrap();
        health.rows[0][index].clone()
    };
    assert_eq!(value("database_name").as_deref(), Some("Quervio_Management_Catalog"));
    assert_eq!(value("state_desc").as_deref(), Some("ONLINE"));
    for name in ["cpu_count", "active_workers", "cpu_percent", "batch_requests", "total_physical_memory_kb", "volume_used_percent", "data_bytes", "log_used_percent", "user_sessions"] {
        assert!(value(name).is_some(), "{name} is NULL");
    }
    let properties=session.query_table("SELECT N'It''s exact', CAST(NULL AS nvarchar(1)),CAST(99999999999999999999999999999999999999 AS decimal(38,0))",10).await.unwrap();
    assert_eq!(properties.rows[0][0].as_deref(), Some("It's exact"));
    assert_eq!(properties.rows[0][1], None);
    assert_eq!(
        properties.rows[0][2].as_deref(),
        Some("99999999999999999999999999999999999999")
    );
    session.close().await.unwrap();
}

#[tokio::test]
#[ignore = "needs the dedicated SQL Server test instance"]
async fn estimated_plans_do_not_execute_writes_and_do_not_enter_result_limits() {
    let _database = common::TestDatabase::create(
        "Quervio_Management_Plans",
        "CREATE TABLE dbo.Items(Id int NOT NULL);",
    )
    .await;
    let mut connection = common::saved_connection();
    connection.default_database = Some("Quervio_Management_Plans".into());
    let mut session = Session::open(&connection, common::password(), "Quervio plan tests")
        .await
        .unwrap();
    session.command("SET SHOWPLAN_XML ON").await.unwrap();
    let results = SharedResults::default();
    let mut plans = Vec::new();
    let outcome = session
        .execute(
            "INSERT dbo.Items VALUES(1);",
            0,
            &CancelToken::new(),
            &results,
            ResultLimits {
                max_rows: 1,
                max_cell_bytes: 1,
            },
            |event| {
                if let ExecutionEvent::Plan { xml } = event {
                    plans.push(xml);
                }
            },
        )
        .await;
    session.command("SET SHOWPLAN_XML OFF").await.unwrap();
    assert_eq!(outcome, Outcome::Succeeded);
    assert!(!plans.is_empty());
    assert!(plans[0].contains("ShowPlanXML"));
    assert!(results.read().unwrap().is_empty());
    let rows = session
        .query_table("SELECT COUNT(*) FROM dbo.Items", 1)
        .await
        .unwrap();
    assert_eq!(rows.rows[0][0].as_deref(), Some("0"));
    session.close().await.unwrap();
}

#[tokio::test]
#[ignore = "needs the dedicated SQL Server test instance"]
async fn administration_stops_before_subsequent_batches_after_an_error() {
    let mut session = Session::open(
        &common::saved_connection(),
        common::password(),
        "Quervio administration tests",
    )
    .await
    .unwrap();
    session
        .command("CREATE TABLE #State(Id int);")
        .await
        .unwrap();
    assert!(
        session
            .command("SELECT * FROM #Missing;\nGO\nINSERT #State VALUES(1);")
            .await
            .is_err()
    );
    let data = session
        .query_table("SELECT COUNT(*) FROM #State", 1)
        .await
        .unwrap();
    assert_eq!(data.rows[0][0].as_deref(), Some("0"));
    session.close().await.unwrap();
}
