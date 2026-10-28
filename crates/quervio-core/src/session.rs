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
    pub(crate) client: TdsClient,
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
    /// Executes every result in a management batch and stops at the first error.
    pub async fn command(&mut self, sql: &str) -> Result<Vec<String>> {
        let mut messages = Vec::new();
        self.command_controlled(sql, &crate::execution::CancelToken::new(), |text| {
            messages.push(text)
        })
        .await?;
        Ok(messages)
    }

    pub async fn command_controlled(
        &mut self,
        sql: &str,
        cancel: &crate::execution::CancelToken,
        mut emit: impl FnMut(String),
    ) -> Result<()> {
        for batch in crate::batch::split(sql) {
            for _ in 0..batch.repeat {
                if cancel.is_cancelled() {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::Interrupted,
                        "Operation cancelled; completed statements may already be committed.",
                    )
                    .into());
                }
                let result: Result<()> = async {
                    let options = mssql_tds::connection::tds_client::ExecuteOptions {
                        cancel: Some(&cancel.handle),
                        ..Default::default()
                    };
                    let mut step = self.client.execute(batch.text.clone(), options).await?;
                    loop {
                        match step {
                            StatementResult::End => break,
                            StatementResult::Rows => {
                                while self.client.next_row().await?.is_some() {}
                            }
                            _ => {}
                        }
                        for info in self.client.take_info_messages() {
                            emit(info.message);
                        }
                        step = self.client.advance().await?;
                    }
                    Ok(())
                }
                .await;
                let closed = self.client.close_query().await;
                result?;
                closed?;
            }
        }
        Ok(())
    }
    /// Bounded metadata read, with exact text conversion and untruncated XML.
    pub async fn query_table(
        &mut self,
        sql: &str,
        limit: usize,
    ) -> Result<crate::management::DataTable> {
        let first = self.client.execute(sql.to_string(), ()).await;
        let mut table = crate::management::DataTable {
            columns: Vec::new(),
            rows: Vec::new(),
            truncated: false,
        };
        let outcome: Result<()> = async {
            if matches!(first?, StatementResult::Rows) {
                table.columns = self
                    .client
                    .get_metadata()
                    .iter()
                    .map(|c| c.column_name.clone())
                    .collect();
                while let Some(row) = self.client.next_row().await? {
                    if table.rows.len() >= limit {
                        table.truncated = true;
                        break;
                    }
                    table.rows.push(
                        row.iter()
                            .map(|v| {
                                let mut s = String::new();
                                crate::format::write_value(v, &mut s).map(|()| s)
                            })
                            .collect(),
                    );
                }
            }
            Ok(())
        }
        .await;
        let closed = self.client.close_query().await;
        outcome?;
        closed?;
        Ok(table)
    }
    /// Logs in to the Server of `connection`. `password` is required for SQL
    /// logins and ignored for Windows authentication.
    pub async fn open(
        connection: &SavedConnection,
        password: Option<String>,
        application_name: &str,
    ) -> Result<Self> {
        Self::open_with_timeout(connection, password, application_name, None).await
    }

    pub async fn open_with_timeout(
        connection: &SavedConnection,
        password: Option<String>,
        application_name: &str,
        timeout: Option<u32>,
    ) -> Result<Self> {
        let mut context = ClientContext::default();
        context.application_name = application_name.to_string();
        context.login_timeout = Some(timeout.unwrap_or(LOGIN_TIMEOUT_SECS));
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
            Authentication::Entra => {
                context.tds_authentication_method = TdsAuthenticationMethod::AccessToken;
                context.access_token = Some(password.ok_or_else(|| {
                    Error::MissingPassword("Microsoft Entra access token".into())
                })?);
            }
        }
        context.encryption_options.mode = match connection.encrypt {
            Encrypt::Mandatory => EncryptionSetting::Required,
            Encrypt::Optional => EncryptionSetting::PreferOff,
            Encrypt::Strict => EncryptionSetting::Strict,
        };
        context.encryption_options.trust_server_certificate = connection.trust_server_certificate;

        // A bare local name goes to the local default instance; without
        // one the driver would only give up after the login timeout.
        if is_bare_local(&connection.server) && !local_default_instance_installed() {
            return Err(Error::NoLocalInstance(connection.server.clone()));
        }

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

/// `localhost`, `.`, `(local)`, a loopback address or this machine's
/// name, with no instance, port or protocol prefix.
fn is_bare_local(server: &str) -> bool {
    let name = server.trim();
    if name.is_empty() || name.contains(['\\', ',', ':']) {
        return false;
    }
    let machine = std::env::var("COMPUTERNAME").unwrap_or_default();
    ["localhost", ".", "(local)", "127.0.0.1", "::1"]
        .iter()
        .any(|local| name.eq_ignore_ascii_case(local))
        || (!machine.is_empty() && name.eq_ignore_ascii_case(&machine))
}

/// Whether SQL Server's default instance (MSSQLSERVER) is installed here.
#[cfg(windows)]
fn local_default_instance_installed() -> bool {
    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::System::Registry::{HKEY_LOCAL_MACHINE, RRF_RT_ANY, RegGetValueW};

    let wide = |s: &str| s.encode_utf16().chain([0]).collect::<Vec<u16>>();
    let key = wide(r"SOFTWARE\Microsoft\Microsoft SQL Server\Instance Names\SQL");
    let value = wide("MSSQLSERVER");
    // SAFETY: both strings are NUL-terminated and outlive the call; no
    // output buffers are passed, so only the value's existence is checked.
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            key.as_ptr(),
            value.as_ptr(),
            RRF_RT_ANY,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    status == ERROR_SUCCESS
}

#[cfg(not(windows))]
fn local_default_instance_installed() -> bool {
    true
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_local_names() {
        for name in [
            "localhost",
            "LOCALHOST",
            ".",
            "(local)",
            "127.0.0.1",
            " localhost ",
        ] {
            assert!(is_bare_local(name), "{name}");
        }
        for name in [
            "localhost,14333",
            r"localhost\SQLEXPRESS",
            "tcp:localhost",
            "srv01",
            r"(localdb)\MSSQLLocalDB",
        ] {
            assert!(!is_bare_local(name), "{name}");
        }
    }
}
