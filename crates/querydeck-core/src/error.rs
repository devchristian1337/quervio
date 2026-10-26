use thiserror::Error;

/// Everything that can go wrong inside querydeck-core.
#[derive(Debug, Error)]
pub enum Error {
    #[error("{0}")]
    Server(#[from] mssql_tds::error::Error),

    #[error("could not read or write saved connections: {0}")]
    Io(#[from] std::io::Error),

    #[error("saved connections file is corrupt: {0}")]
    Json(#[from] serde_json::Error),

    #[error("saved passwords: {0}")]
    Secrets(String),

    #[error(
        "no SQL Server answered at {0} over shared memory or named pipes; if it listens on a TCP port, write it as host,port"
    )]
    NoLocalInstance(String),

    #[error("object {0} no longer exists; refresh the Object Explorer")]
    ObjectNotFound(i64),

    #[error("this module is encrypted (WITH ENCRYPTION), so its definition cannot be scripted")]
    EncryptedModule,

    #[error("no saved connection with id {0}")]
    UnknownConnection(String),

    #[error("no password stored for {0}; edit the connection and enter it again")]
    MissingPassword(String),

    #[error("unexpected value in column {column}: {found}")]
    UnexpectedValue { column: usize, found: String },
}

pub type Result<T> = std::result::Result<T, Error>;
