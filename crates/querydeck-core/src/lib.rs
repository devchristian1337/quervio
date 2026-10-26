//! Querydeck domain logic: talking to the Server, splitting scripts into
//! Batches, spotting Destructive Statements, scripting Objects and holding
//! Result Sets. Nothing in here depends on Tauri, so it can be tested
//! against a real SQL Server without starting the app.
//!
//! Terms follow `GLOSSARY.md` at the repository root.

pub mod batch;
pub mod catalog;
pub mod connection;
pub mod error;
pub mod execution;
pub mod secrets;
pub mod session;

pub use error::{Error, Result};
