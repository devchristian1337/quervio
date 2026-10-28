//! Scripts the Object Explorer opens in a new Query Tab: SELECT TOP (1000),
//! the definition of a Module (as CREATE, or as ALTER for Modify), and a
//! CREATE TABLE rebuilt from the catalog.

use std::fmt::Write;

use mssql_tds::datatypes::column_values::ColumnValues;

use crate::catalog::{SqlType, quote_name};
use crate::error::{Error, Result};
use crate::session::{Session, flag, int, optional_text, text};

/// `[schema].[name]` of an Object.
async fn qualified_name(session: &mut Session, db: &str, object_id: i64) -> Result<String> {
    let rows = session
        .query(&format!(
            "SELECT s.name, o.name FROM {db}.sys.objects o
             JOIN {db}.sys.schemas s ON s.schema_id = o.schema_id
             WHERE o.object_id = {object_id}"
        ))
        .await?;
    let row = rows.first().ok_or(Error::ObjectNotFound(object_id))?;
    Ok(format!(
        "{}.{}",
        quote_name(&text(row, 0)?),
        quote_name(&text(row, 1)?)
    ))
}

async fn column_names(session: &mut Session, db: &str, object_id: i64) -> Result<Vec<String>> {
    let rows = session
        .query(&format!(
            "SELECT name FROM {db}.sys.columns WHERE object_id = {object_id} ORDER BY column_id"
        ))
        .await?;
    rows.iter().map(|row| text(row, 0)).collect()
}

/// `SELECT TOP (n)` of every column, as SSMS's "Select Top 1000 Rows".
pub async fn select_top(
    session: &mut Session,
    database: &str,
    object_id: i64,
    rows: u32,
) -> Result<String> {
    let db = quote_name(database);
    let name = qualified_name(session, &db, object_id).await?;
    let columns: Vec<_> = column_names(session, &db, object_id)
        .await?
        .iter()
        .map(|c| quote_name(c))
        .collect();
    Ok(format!(
        "SELECT TOP ({rows})\n      {}\n  FROM {name};\n",
        columns.join("\n     ,")
    ))
}

/// The CREATE statement a Module (view, procedure, function, trigger) was
/// defined with.
pub async fn module_definition(
    session: &mut Session,
    database: &str,
    object_id: i64,
) -> Result<String> {
    let db = quote_name(database);
    let rows = session
        .query(&format!(
            "SELECT definition FROM {db}.sys.sql_modules WHERE object_id = {object_id}"
        ))
        .await?;
    match rows.first() {
        None => Err(Error::ObjectNotFound(object_id)),
        Some(row) => optional_text(row, 0)?.ok_or(Error::EncryptedModule),
    }
}

/// Turns a Module's `CREATE` into `ALTER`, for Modify. `CREATE OR ALTER`
/// and anything unexpected are returned unchanged.
pub fn as_alter(definition: &str) -> String {
    let start = skip_comments(definition);
    let rest = &definition[start..];
    let word = |s: &str| {
        s.split(|c: char| !c.is_alphanumeric())
            .next()
            .unwrap_or("")
            .to_string()
    };
    if !word(rest).eq_ignore_ascii_case("CREATE") {
        return definition.to_string();
    }
    let after = &rest[6..];
    let next = &after[skip_comments(after)..];
    if word(next).eq_ignore_ascii_case("OR") {
        return definition.to_string();
    }
    format!("{}ALTER{}", &definition[..start], after)
}

/// Byte offset of the first character that is not whitespace or a comment.
fn skip_comments(text: &str) -> usize {
    let bytes = text.as_bytes();
    let mut i = 0;
    loop {
        while i < bytes.len() && bytes[i].is_ascii_whitespace() {
            i += 1;
        }
        if bytes[i..].starts_with(b"--") {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
        } else if bytes[i..].starts_with(b"/*") {
            let mut depth = 0;
            while i < bytes.len() {
                if bytes[i..].starts_with(b"/*") {
                    depth += 1;
                    i += 2;
                } else if bytes[i..].starts_with(b"*/") {
                    depth -= 1;
                    i += 2;
                    if depth == 0 {
                        break;
                    }
                } else {
                    i += 1;
                }
            }
        } else {
            return i;
        }
    }
}

fn optional_int(row: &[ColumnValues], column: usize) -> Result<Option<i64>> {
    match row.get(column) {
        Some(ColumnValues::Null) => Ok(None),
        _ => int(row, column).map(Some),
    }
}

/// A CREATE TABLE for a table: columns with identity, defaults and computed
/// expressions, then primary key, unique, check and foreign key constraints.
/// Indexes that are not constraints and storage options are not scripted.
pub async fn create_table(session: &mut Session, database: &str, object_id: i64) -> Result<String> {
    let db = quote_name(database);
    let name = qualified_name(session, &db, object_id).await?;
    let mut lines = Vec::new();

    let columns = session
        .query(&format!(
            "SELECT c.name, t.name, c.max_length, c.precision, c.scale, c.is_nullable,
                    CAST(ic.seed_value AS bigint), CAST(ic.increment_value AS bigint),
                    dc.name, dc.definition, cc.definition, CAST(ISNULL(cc.is_persisted, 0) AS bit),
                    CASE WHEN t.is_user_defined = 1 THEN SCHEMA_NAME(t.schema_id) END
             FROM {db}.sys.columns c
             JOIN {db}.sys.types t ON t.user_type_id = c.user_type_id
             LEFT JOIN {db}.sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
             LEFT JOIN {db}.sys.default_constraints dc ON dc.object_id = c.default_object_id
             LEFT JOIN {db}.sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
             WHERE c.object_id = {object_id}
             ORDER BY c.column_id"
        ))
        .await?;
    for row in &columns {
        let mut line = format!("    {} ", quote_name(&text(row, 0)?));
        if let Some(expression) = optional_text(row, 10)? {
            write!(line, "AS {expression}").unwrap();
            if flag(row, 11)? {
                line.push_str(" PERSISTED");
            }
        } else {
            let column_type = SqlType {
                name: text(row, 1)?,
                schema: optional_text(row, 12)?,
                max_length: int(row, 2)?,
                precision: int(row, 3)?,
                scale: int(row, 4)?,
            };
            write!(line, "{column_type}").unwrap();
            if let (Some(seed), Some(increment)) = (optional_int(row, 6)?, optional_int(row, 7)?) {
                write!(line, " IDENTITY({seed}, {increment})").unwrap();
            }
            line.push_str(if flag(row, 5)? { " NULL" } else { " NOT NULL" });
            if let (Some(default_name), Some(definition)) =
                (optional_text(row, 8)?, optional_text(row, 9)?)
            {
                write!(
                    line,
                    " CONSTRAINT {} DEFAULT {definition}",
                    quote_name(&default_name)
                )
                .unwrap();
            }
        }
        lines.push(line);
    }

    // Primary key and unique constraints, columns in key order.
    let keys = session
        .query(&format!(
            "SELECT kc.name, CAST(kc.type AS nvarchar(2)), i.type_desc, col.name, ic.is_descending_key
             FROM {db}.sys.key_constraints kc
             JOIN {db}.sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
             JOIN {db}.sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
             JOIN {db}.sys.columns col ON col.object_id = ic.object_id AND col.column_id = ic.column_id
             WHERE kc.parent_object_id = {object_id} AND ic.key_ordinal > 0
             ORDER BY CAST(kc.type AS nvarchar(2)), kc.name, ic.key_ordinal"
        ))
        .await?;
    for group in group_by_first(&keys)? {
        let row = &group[0];
        let kind = if text(row, 1)?.trim() == "PK" {
            "PRIMARY KEY"
        } else {
            "UNIQUE"
        };
        let columns: Vec<_> = group
            .iter()
            .map(|row| {
                let order = if flag(row, 4)? { " DESC" } else { "" };
                Ok(format!("{}{order}", quote_name(&text(row, 3)?)))
            })
            .collect::<Result<_>>()?;
        lines.push(format!(
            "    CONSTRAINT {} {kind} {} ({})",
            quote_name(&text(row, 0)?),
            text(row, 2)?.replace('_', " "),
            columns.join(", ")
        ));
    }

    let checks = session
        .query(&format!(
            "SELECT name, definition FROM {db}.sys.check_constraints
             WHERE parent_object_id = {object_id} ORDER BY name"
        ))
        .await?;
    for row in &checks {
        lines.push(format!(
            "    CONSTRAINT {} CHECK {}",
            quote_name(&text(row, 0)?),
            text(row, 1)?
        ));
    }

    let foreign_keys = session
        .query(&format!(
            "SELECT fk.name, pc.name, rs.name, rt.name, rc.name,
                    fk.delete_referential_action_desc, fk.update_referential_action_desc
             FROM {db}.sys.foreign_keys fk
             JOIN {db}.sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
             JOIN {db}.sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
             JOIN {db}.sys.tables rt ON rt.object_id = fkc.referenced_object_id
             JOIN {db}.sys.schemas rs ON rs.schema_id = rt.schema_id
             JOIN {db}.sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
             WHERE fk.parent_object_id = {object_id}
             ORDER BY fk.name, fkc.constraint_column_id"
        ))
        .await?;
    for group in group_by_first(&foreign_keys)? {
        let row = &group[0];
        let parents: Vec<_> = group
            .iter()
            .map(|r| text(r, 1).map(|c| quote_name(&c)))
            .collect::<Result<_>>()?;
        let referenced: Vec<_> = group
            .iter()
            .map(|r| text(r, 4).map(|c| quote_name(&c)))
            .collect::<Result<_>>()?;
        let mut line = format!(
            "    CONSTRAINT {} FOREIGN KEY ({}) REFERENCES {}.{} ({})",
            quote_name(&text(row, 0)?),
            parents.join(", "),
            quote_name(&text(row, 2)?),
            quote_name(&text(row, 3)?),
            referenced.join(", ")
        );
        for (clause, column) in [("ON DELETE", 5), ("ON UPDATE", 6)] {
            let action = text(row, column)?;
            if action != "NO_ACTION" {
                write!(line, " {clause} {}", action.replace('_', " ")).unwrap();
            }
        }
        lines.push(line);
    }

    Ok(format!(
        "CREATE TABLE {name} (\n{}\n);\n",
        lines.join(",\n")
    ))
}

/// Consecutive rows that share their first column (a constraint name).
fn group_by_first(rows: &[Vec<ColumnValues>]) -> Result<Vec<&[Vec<ColumnValues>]>> {
    let mut groups = Vec::new();
    let mut start = 0;
    for i in 1..=rows.len() {
        if i == rows.len() || text(&rows[i], 0)? != text(&rows[start], 0)? {
            groups.push(&rows[start..i]);
            start = i;
        }
    }
    Ok(groups)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modify_turns_create_into_alter() {
        assert_eq!(
            as_alter("CREATE PROCEDURE p AS SELECT 1"),
            "ALTER PROCEDURE p AS SELECT 1"
        );
        assert_eq!(
            as_alter("-- header\n/* note /* nested */ */\n  create view v as select 1"),
            "-- header\n/* note /* nested */ */\n  ALTER view v as select 1"
        );
    }

    #[test]
    fn modify_leaves_create_or_alter_and_oddities_alone() {
        assert_eq!(
            as_alter("CREATE OR ALTER VIEW v AS SELECT 1"),
            "CREATE OR ALTER VIEW v AS SELECT 1"
        );
        assert_eq!(as_alter("CREATEX"), "CREATEX");
        assert_eq!(as_alter(""), "");
    }
}
