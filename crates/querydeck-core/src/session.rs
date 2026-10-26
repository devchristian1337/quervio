//! A Session: one live connection to a Server, opened from a Saved Connection.
//! This is the only place that knows about the `mssql-tds` client type
//! (docs/adr/0002-driver-mssql-tds.md).

use mssql_tds::connection::client_context::{ClientContext, TdsAuthenticationMethod};
use mssql_tds::connection::tds_client::{ResultSet, StatementResult, TdsClient};
use mssql_tds::connection_provider::tds_connection_provider::TdsConnectionProvider;
use mssql_tds::core::EncryptionSetting;
use mssql_tds::datatypes::column_values::ColumnValues;
use serde::Serialize;

use crate::connection::{Authentication, Encrypt, SavedConnection};
use crate::error::{Error, Result};

/// Seconds to wait for the Server to accept a login.
const LOGIN_TIMEOUT_SECS: u32 = 15;

pub struct Session {
    client: TdsClient,
}

/// What the Server says about itself right after login.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub server_name: String,
    pub version: String,
    pub database: String,
}

impl Session {
    /// Logs in to the Server of `connection`. `password` is required for SQL
    /// logins and ignored for Windows authentication.
    pub async fn open(
        connection: &SavedConnection,
        password: Option<String>,
        application_name: &str,
    ) -> Result<Self> {
        let mut context = ClientContext::default();
        context.application_name = application_name.to_string();
        context.login_timeout = Some(LOGIN_TIMEOUT_SECS);
        context.database = connection
            .default_database
            .clone()
            .filter(|database| !database.trim().is_empty())
            .unwrap_or_else(|| "master".into());
        match &connection.authentication {
            Authentication::Sql { user_name } => {
                context.tds_authentication_method = TdsAuthenticationMethod::Password;
                context.user_name = user_name.clone();
                context.password = password
                    .ok_or_else(|| Error::MissingPassword(connection.display_name().into()))?;
            }
            Authentication::Windows => {
                context.tds_authentication_method = TdsAuthenticationMethod::SSPI;
            }
        }
        context.encryption_options.mode = match connection.encrypt {
            Encrypt::Mandatory => EncryptionSetting::Required,
            Encrypt::Optional => EncryptionSetting::PreferOff,
            Encrypt::Strict => EncryptionSetting::Strict,
        };
        context.encryption_options.trust_server_certificate = connection.trust_server_certificate;

        let result = TdsConnectionProvider {}
            .create_client(context, &connection.server, None)
            .await;
        match result {
            Ok(client) => Ok(Self { client }),
            // A bare local name goes through shared memory / named pipes first;
            // "file not found" there means no local instance, not a missing file.
            Err(mssql_tds::error::Error::Io(error))
                if error.kind() == std::io::ErrorKind::NotFound =>
            {
                Err(Error::NoLocalInstance(connection.server.clone()))
            }
            Err(error) => Err(error.into()),
        }
    }

    pub async fn server_info(&mut self) -> Result<ServerInfo> {
        let rows = self
            .query("SELECT CAST(SERVERPROPERTY('ServerName') AS nvarchar(256)), CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)), DB_NAME()")
            .await?;
        let row = rows.first().ok_or(Error::UnexpectedValue {
            column: 0,
            found: "no rows".into(),
        })?;
        Ok(ServerInfo {
            server_name: text(row, 0)?,
            version: text(row, 1)?,
            database: text(row, 2)?,
        })
    }

    /// Runs one statement and buffers its first Result Set. For small
    /// metadata queries only; Query Tabs stream instead.
    pub(crate) async fn query(&mut self, sql: &str) -> Result<Vec<Vec<ColumnValues>>> {
        let first = self.client.execute(sql.to_string(), ()).await;
        let mut rows = Vec::new();
        let outcome = match first {
            Ok(StatementResult::Rows) => loop {
                match self.client.next_row().await {
                    Ok(Some(row)) => rows.push(row),
                    Ok(None) => break Ok(()),
                    Err(error) => break Err(error),
                }
            },
            Ok(_) => Ok(()),
            Err(error) => Err(error),
        };
        let closed = self.client.close_query().await;
        outcome?;
        closed?;
        Ok(rows)
    }

    pub async fn close(mut self) -> Result<()> {
        Ok(self.client.close_connection().await?)
    }
}

pub(crate) fn text(row: &[ColumnValues], column: usize) -> Result<String> {
    match row.get(column) {
        Some(ColumnValues::String(value)) => Ok(value.to_utf8_string()),
        other => Err(unexpected(column, other)),
    }
}

pub(crate) fn optional_text(row: &[ColumnValues], column: usize) -> Result<Option<String>> {
    match row.get(column) {
        Some(ColumnValues::Null) => Ok(None),
        _ => text(row, column).map(Some),
    }
}

pub(crate) fn int(row: &[ColumnValues], column: usize) -> Result<i64> {
    match row.get(column) {
        Some(ColumnValues::TinyInt(value)) => Ok(i64::from(*value)),
        Some(ColumnValues::SmallInt(value)) => Ok(i64::from(*value)),
        Some(ColumnValues::Int(value)) => Ok(i64::from(*value)),
        Some(ColumnValues::BigInt(value)) => Ok(*value),
        other => Err(unexpected(column, other)),
    }
}

pub(crate) fn flag(row: &[ColumnValues], column: usize) -> Result<bool> {
    match row.get(column) {
        Some(ColumnValues::Bit(value)) => Ok(*value),
        other => Err(unexpected(column, other)),
    }
}

fn unexpected(column: usize, found: Option<&ColumnValues>) -> Error {
    Error::UnexpectedValue {
        column,
        found: format!("{found:?}"),
    }
}
