//! Read-only version/authentication probe; the other integration suites use
//! disposable databases. Run them together with test-sql-compatibility.mjs.
mod common;
use quervio_core::session::Session;

#[tokio::test]
#[ignore = "needs a dedicated SQL Server test instance"]
async fn records_the_actual_server_version_and_authentication() {
    let mut session = Session::open(
        &common::saved_connection(),
        common::password(),
        "Quervio compatibility tests",
    )
    .await
    .unwrap();
    let info = session
        .query_table(
            "SELECT CONVERT(nvarchar(128),SERVERPROPERTY('ProductVersion')) AS product_version,
         CONVERT(nvarchar(128),SERVERPROPERTY('ProductLevel')) AS product_level,
         CONVERT(nvarchar(128),SERVERPROPERTY('Edition')) AS edition,
         CONVERT(nvarchar(128),SERVERPROPERTY('EngineEdition')) AS engine_edition,
         CONVERT(nvarchar(128),CONNECTIONPROPERTY('auth_scheme')) AS auth_scheme;",
            1,
        )
        .await
        .unwrap();
    let row = info.rows.first().expect("server properties");
    if let Ok(expected) = std::env::var("QUERVIO_TEST_EXPECTED_MAJOR") {
        assert_eq!(
            row[0].as_deref().unwrap().split('.').next(),
            Some(expected.as_str())
        );
    }
    assert_eq!(row[4].as_deref(), Some("SQL"));
    if let Ok(path) = std::env::var("QUERVIO_TEST_REPORT") {
        let server: serde_json::Map<String, serde_json::Value> = info
            .columns
            .into_iter()
            .zip(row.iter().map(|value| serde_json::json!(value)))
            .collect();
        let report = serde_json::json!({ "server": server, "client_os": std::env::consts::OS,
            "client_arch": std::env::consts::ARCH, "probe": "passed" });
        std::fs::write(path, serde_json::to_vec_pretty(&report).unwrap()).unwrap();
    }
    session.close().await.unwrap();
}
