//! Shared setup for the integration tests that need the SQL Server from
//! `docker-compose.yml`.
#![allow(dead_code)]

use mssql_tds::connection::client_context::ClientContext;
use mssql_tds::connection::tds_client::TdsClient;
use mssql_tds::connection_provider::tds_connection_provider::TdsConnectionProvider;
use mssql_tds::core::EncryptionSetting;
use quervio_core::connection::{Authentication, Encrypt, Environment, SavedConnection};

/// Reads a test setting from the environment, falling back to the
/// workspace `.env` file.
pub fn setting(key: &str) -> String {
    if let Ok(value) = std::env::var(key) {
        return value;
    }
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../.env");
    let contents = std::fs::read_to_string(path)
        .unwrap_or_else(|_| panic!("{key} not set and no .env (copy .env.example)"));
    contents
        .lines()
        .filter_map(|line| line.split_once('='))
        .find(|(name, _)| name.trim() == key)
        .map(|(_, value)| value.trim().to_string())
        .unwrap_or_else(|| panic!("{key} missing from .env"))
}

/// A raw driver client, for setup and for checking the driver itself.
pub async fn connect() -> TdsClient {
    let mut context = ClientContext::default();
    context.user_name = setting("QUERVIO_TEST_USER");
    context.password = setting("QUERVIO_TEST_PASSWORD");
    context.database = "master".into();
    // Quervio's default for a Saved Connection: Mandatory + Trust server certificate.
    context.encryption_options.mode = EncryptionSetting::Required;
    context.encryption_options.trust_server_certificate = true;

    TdsConnectionProvider {}
        .create_client(context, &setting("QUERVIO_TEST_SERVER"), None)
        .await
        .expect("connect to the test SQL Server")
}

/// The test server as a Saved Connection.
pub fn saved_connection() -> SavedConnection {
    SavedConnection {
        id: "test".into(),
        name: "Docker".into(),
        server: setting("QUERVIO_TEST_SERVER"),
        authentication: Authentication::Sql {
            user_name: setting("QUERVIO_TEST_USER"),
        },
        default_database: None,
        environment: Environment::Development,
        encrypt: Encrypt::Mandatory,
        trust_server_certificate: true,
    }
}

pub fn password() -> Option<String> {
    Some(setting("QUERVIO_TEST_PASSWORD"))
}

/// Runs each script in order on a fresh connection, failing on any error.
pub async fn run_scripts(scripts: &[&str]) {
    let mut client = connect().await;
    for script in scripts {
        client.execute((*script).into(), ()).await.expect(script);
        client.close_query().await.expect(script);
    }
}
