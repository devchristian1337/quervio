//! What the Object Explorer shows: databases, Objects in a database, and
//! the parts of a table or view. Each call is one metadata query, so the tree
//! loads lazily, one level at a time.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::session::{Session, flag, int, optional_text, text};

/// One entry under a node of the Object Explorer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogItem {
    pub name: String,
    pub schema: Option<String>,
    /// Set for tables and views, whose children are loaded by id.
    pub object_id: Option<i64>,
    /// Short description shown next to the name, e.g. `PK, int, not null`.
    pub detail: Option<String>,
    /// System databases and other Objects SQL Server owns.
    pub system: bool,
}

impl CatalogItem {
    fn named(name: String) -> Self {
        Self {
            name,
            schema: None,
            object_id: None,
            detail: None,
            system: false,
        }
    }
}

/// Folders directly under a database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ObjectFolder {
    Tables,
    Views,
    StoredProcedures,
    Functions,
    DatabaseTriggers,
}

/// Folders under a table (views only have columns).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TableFolder {
    Columns,
    Keys,
    Indexes,
    Triggers,
}

/// Databases this login can open, user and system alike.
pub async fn databases(session: &mut Session) -> Result<Vec<CatalogItem>> {
    let rows = session
        .query(
            "SELECT name, CAST(CASE WHEN database_id <= 4 THEN 1 ELSE 0 END AS bit)
             FROM sys.databases
             WHERE state = 0 AND HAS_DBACCESS(name) = 1
             ORDER BY name",
        )
        .await?;
    rows.iter()
        .map(|row| {
            Ok(CatalogItem {
                system: flag(row, 1)?,
                ..CatalogItem::named(text(row, 0)?)
            })
        })
        .collect()
}

pub async fn objects(
    session: &mut Session,
    database: &str,
    folder: ObjectFolder,
) -> Result<Vec<CatalogItem>> {
    let db = quote_name(database);
    if folder == ObjectFolder::DatabaseTriggers {
        let rows=session.query(&format!("SELECT name,object_id,is_disabled,is_ms_shipped FROM {db}.sys.triggers WHERE parent_class=0 ORDER BY name")).await?;
        return rows
            .iter()
            .map(|row| {
                Ok(CatalogItem {
                    name: text(row, 0)?,
                    schema: None,
                    object_id: Some(int(row, 1)?),
                    detail: flag(row, 2)?.then(|| "disabled".into()),
                    system: flag(row, 3)?,
                })
            })
            .collect();
    }
    let (source, filter) = match folder {
        ObjectFolder::Tables => ("sys.tables", "o.type = 'U'"),
        ObjectFolder::Views => ("sys.views", "o.type = 'V'"),
        ObjectFolder::StoredProcedures => ("sys.procedures", "o.type IN ('P', 'PC')"),
        ObjectFolder::Functions => ("sys.objects", "o.type IN ('FN', 'FS', 'IF', 'TF', 'FT')"),
        ObjectFolder::DatabaseTriggers => unreachable!(),
    };
    let rows = session
        .query(&format!(
            "SELECT s.name, o.name, o.object_id, CAST(o.type AS nvarchar(2)), o.is_ms_shipped
             FROM {db}.{source} o
             JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id
             WHERE {filter}
             ORDER BY s.name, o.name"
        ))
        .await?;
    rows.iter()
        .map(|row| {
            let kind = text(row, 3)?;
            Ok(CatalogItem {
                schema: Some(text(row, 0)?),
                object_id: Some(int(row, 2)?),
                detail: function_kind(kind.trim()).map(str::to_string),
                system: flag(row, 4)?,
                ..CatalogItem::named(text(row, 1)?)
            })
        })
        .collect()
}

pub async fn table_children(
    session: &mut Session,
    database: &str,
    object_id: i64,
    folder: TableFolder,
) -> Result<Vec<CatalogItem>> {
    let db = quote_name(database);
    match folder {
        TableFolder::Columns => columns(session, &db, object_id).await,
        TableFolder::Keys => {
            let rows = session
                .query(&format!(
                    "SELECT name, CAST(type AS nvarchar(2)) FROM {db}.sys.key_constraints WHERE parent_object_id = {object_id}
                     UNION ALL
                     SELECT name, N'F' FROM {db}.sys.foreign_keys WHERE parent_object_id = {object_id}
                     ORDER BY 1"
                ))
                .await?;
            rows.iter()
                .map(|row| {
                    let detail = match text(row, 1)?.trim() {
                        "PK" => "Primary key",
                        "UQ" => "Unique",
                        _ => "Foreign key",
                    };
                    Ok(CatalogItem {
                        detail: Some(detail.into()),
                        ..CatalogItem::named(text(row, 0)?)
                    })
                })
                .collect()
        }
        TableFolder::Indexes => {
            let rows = session
                .query(&format!(
                    "SELECT name, type_desc, is_unique FROM {db}.sys.indexes
                     WHERE object_id = {object_id} AND type > 0
                     ORDER BY name"
                ))
                .await?;
            rows.iter()
                .map(|row| {
                    let mut detail = sentence_case(&text(row, 1)?);
                    if flag(row, 2)? {
                        detail.push_str(", unique");
                    }
                    Ok(CatalogItem {
                        detail: Some(detail),
                        ..CatalogItem::named(text(row, 0)?)
                    })
                })
                .collect()
        }
        TableFolder::Triggers => {
            let rows = session
                .query(&format!(
                    "SELECT name, is_disabled, object_id FROM {db}.sys.triggers
                     WHERE parent_id = {object_id}
                     ORDER BY name"
                ))
                .await?;
            rows.iter()
                .map(|row| {
                    Ok(CatalogItem {
                        detail: flag(row, 1)?.then(|| "disabled".to_string()),
                        // Triggers are Modules: scripting needs their id.
                        object_id: Some(int(row, 2)?),
                        ..CatalogItem::named(text(row, 0)?)
                    })
                })
                .collect()
        }
    }
}

async fn columns(session: &mut Session, db: &str, object_id: i64) -> Result<Vec<CatalogItem>> {
    let rows = session
        .query(&format!(
            "SELECT c.name, t.name, c.max_length, c.precision, c.scale, c.is_nullable,
                    CAST(CASE WHEN EXISTS (
                        SELECT 1 FROM {db}.sys.index_columns ic
                        JOIN {db}.sys.indexes i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
                        WHERE i.is_primary_key = 1 AND ic.object_id = c.object_id AND ic.column_id = c.column_id
                    ) THEN 1 ELSE 0 END AS bit),
                    CAST(CASE WHEN EXISTS (
                        SELECT 1 FROM {db}.sys.foreign_key_columns fk
                        WHERE fk.parent_object_id = c.object_id AND fk.parent_column_id = c.column_id
                    ) THEN 1 ELSE 0 END AS bit)
             FROM {db}.sys.columns c
             JOIN {db}.sys.types t ON t.user_type_id = c.user_type_id
             WHERE c.object_id = {object_id}
             ORDER BY c.column_id"
        ))
        .await?;
    rows.iter()
        .map(|row| {
            let column_type = SqlType {
                name: text(row, 1)?,
                // Shown as a label only, never run.
                schema: None,
                max_length: int(row, 2)?,
                precision: int(row, 3)?,
                scale: int(row, 4)?,
            };
            let mut parts = Vec::new();
            if flag(row, 6)? {
                parts.push("PK".to_string());
            }
            if flag(row, 7)? {
                parts.push("FK".to_string());
            }
            parts.push(column_type.to_string());
            parts.push(if flag(row, 5)? { "null" } else { "not null" }.to_string());
            Ok(CatalogItem {
                detail: Some(parts.join(", ")),
                ..CatalogItem::named(optional_text(row, 0)?.unwrap_or_default())
            })
        })
        .collect()
}

fn function_kind(type_code: &str) -> Option<&'static str> {
    match type_code {
        "FN" | "FS" => Some("Scalar"),
        "IF" | "TF" | "FT" => Some("Table-valued"),
        _ => None,
    }
}

/// `CLUSTERED COLUMNSTORE` → `Clustered columnstore`.
fn sentence_case(text: &str) -> String {
    let lower = text.replace('_', " ").to_lowercase();
    let mut chars = lower.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => lower,
    }
}

/// Brackets an identifier the way `QUOTENAME` does.
pub fn quote_name(name: &str) -> String {
    format!("[{}]", name.replace(']', "]]"))
}

/// A column type as `sys.columns` describes it.
pub(crate) struct SqlType {
    pub(crate) name: String,
    /// The schema of a user-defined type, which is then written as
    /// `[schema].[name]`: its name is chosen by whoever created it.
    pub(crate) schema: Option<String>,
    pub(crate) max_length: i64,
    pub(crate) precision: i64,
    pub(crate) scale: i64,
}

impl std::fmt::Display for SqlType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if let Some(schema) = &self.schema {
            return write!(f, "{}.{}", quote_name(schema), quote_name(&self.name));
        }
        let name = self.name.as_str();
        let length = |bytes_per_char: i64| match self.max_length {
            -1 => "max".to_string(),
            bytes => (bytes / bytes_per_char).to_string(),
        };
        match name {
            "char" | "varchar" | "binary" | "varbinary" => write!(f, "{name}({})", length(1)),
            "nchar" | "nvarchar" => write!(f, "{name}({})", length(2)),
            "decimal" | "numeric" => write!(f, "{name}({}, {})", self.precision, self.scale),
            "datetime2" | "time" | "datetimeoffset" => write!(f, "{name}({})", self.scale),
            _ => f.write_str(name),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sql_type(name: &str, max_length: i64, precision: i64, scale: i64) -> String {
        SqlType {
            name: name.into(),
            schema: None,
            max_length,
            precision,
            scale,
        }
        .to_string()
    }

    #[test]
    fn formats_column_types_like_ssms() {
        assert_eq!(sql_type("int", 4, 10, 0), "int");
        assert_eq!(sql_type("varchar", 50, 0, 0), "varchar(50)");
        assert_eq!(sql_type("nvarchar", 100, 0, 0), "nvarchar(50)");
        assert_eq!(sql_type("nvarchar", -1, 0, 0), "nvarchar(max)");
        assert_eq!(sql_type("varbinary", -1, 0, 0), "varbinary(max)");
        assert_eq!(sql_type("decimal", 9, 18, 2), "decimal(18, 2)");
        assert_eq!(sql_type("datetime2", 8, 27, 7), "datetime2(7)");
        assert_eq!(sql_type("datetime", 8, 23, 3), "datetime");
    }

    #[test]
    fn user_defined_types_are_quoted_with_their_schema() {
        let crafted = SqlType {
            name: "int);DROP TABLE dbo.Victim;CREATE TABLE #x(y int".into(),
            schema: Some("dbo".into()),
            max_length: 4,
            precision: 10,
            scale: 0,
        };
        assert_eq!(
            crafted.to_string(),
            "[dbo].[int);DROP TABLE dbo.Victim;CREATE TABLE #x(y int]"
        );
        let alias = SqlType {
            name: "Phone]x".into(),
            schema: Some("sales".into()),
            max_length: 40,
            precision: 0,
            scale: 0,
        };
        assert_eq!(alias.to_string(), "[sales].[Phone]]x]");
    }

    #[test]
    fn quote_name_escapes_closing_brackets() {
        assert_eq!(quote_name("H2O"), "[H2O]");
        assert_eq!(quote_name("we]ird"), "[we]]ird]");
    }

    #[test]
    fn index_types_read_naturally() {
        assert_eq!(sentence_case("CLUSTERED"), "Clustered");
        assert_eq!(sentence_case("NONCLUSTERED_HASH"), "Nonclustered hash");
    }
}
