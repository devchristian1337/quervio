//! Format Document and Format Selection (docs/adr/0006-formatter-sqruff.md).
//! The editor splits the script on GO and checks the result; Rust lays out
//! each Batch.

use quervio_core::sql_format::{Formatted, Style, format_batch};

use crate::explorer::{CommandResult, message};

/// Each Batch laid out with sqruff, in order. Off the main thread: a long
/// script takes a moment.
#[tauri::command]
pub async fn format_sql(batches: Vec<String>, style: Style) -> CommandResult<Vec<Formatted>> {
    tokio::task::spawn_blocking(move || {
        batches
            .iter()
            .map(|batch| format_batch(batch, style))
            .collect()
    })
    .await
    .map_err(message)?
}
