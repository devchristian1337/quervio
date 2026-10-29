//! Result Sets kept on the Rust side (docs/adr/0001-result-set-nel-backend-rust.md):
//! every cell's display text in one buffer, so a million rows stay compact,
//! and the grid only ever asks for the window it shows.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::io::{self, Write};
use std::ops::Range;
use std::sync::atomic::{AtomicU64, Ordering as AtomicOrdering};
use std::sync::{Arc, RwLock};

use mssql_tds::datatypes::column_values::{
    ColumnValues, SqlDate, SqlDateTime, SqlDateTime2, SqlDateTimeOffset, SqlMoney,
    SqlSmallDateTime, SqlSmallMoney, SqlTime, SqlXml,
};
use mssql_tds::datatypes::decoder::DecimalParts;
use mssql_tds::datatypes::row_writer::RowWriter;
use mssql_tds::datatypes::sql_json::SqlJson;
use mssql_tds::datatypes::sql_string::EncodingType;
use mssql_tds::datatypes::sql_vector::SqlVector;
use serde::Serialize;
use uuid::Uuid;

use crate::format::{write_hex, write_text, write_value};

/// The Result Sets of a Query Tab's latest Execution, shared between the
/// Execution writing them and the grid reading them.
pub type SharedResults = Arc<RwLock<Vec<ResultSet>>>;

#[derive(Debug, Clone, Copy)]
pub struct ResultLimits {
    /// Rows kept per Result Set; reaching it stops the Execution.
    pub max_rows: usize,
    /// Bytes of display text kept per cell; longer values are clipped.
    pub max_cell_bytes: usize,
}

impl Default for ResultLimits {
    fn default() -> Self {
        Self {
            max_rows: 1_000_000,
            max_cell_bytes: 2 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultColumn {
    pub name: String,
    pub kind: ColumnKind,
}

/// What a column holds, for sorting and for right-aligning numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ColumnKind {
    Number,
    /// Dates and times, written so that text order is time order.
    Date,
    Binary,
    #[default]
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SortDirection {
    Ascending,
    Descending,
}

/// One cell's text, or NULL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValue {
    pub text: Option<String>,
    /// The value was longer than the per-cell limit and was cut.
    pub clipped: bool,
}

#[derive(Debug)]
pub struct ResultSet {
    /// Unique per set, so a sort computed outside the lock is applied only to
    /// the set it was computed on.
    id: u64,
    columns: Vec<ResultColumn>,
    text: String,
    /// End offset in `text` of each cell, row-major.
    ends: Vec<u64>,
    nulls: BitSet,
    clipped: BitSet,
    /// Display order of the rows while sorted: `order[shown] = stored`.
    order: Option<Vec<u32>>,
}

impl ResultSet {
    pub fn has_clipped_cells(&self) -> bool {
        self.clipped.0.iter().any(|word| *word != 0)
    }

    pub fn write_csv(&self, out: &mut impl Write) -> io::Result<()> {
        if self.has_clipped_cells() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "This result contains truncated values. Increase the cell limit and rerun the query before exporting.",
            ));
        }
        fn field(out: &mut impl Write, value: Option<&str>, escape: bool) -> io::Result<()> {
            if value.is_some_and(is_spreadsheet_formula) {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "CSV contains formula-like text in a value or column name. Export as Excel (.xlsx) to preserve it safely as text.",
                ));
            }
            out.write_all(b"\"")?;
            match value {
                None => out.write_all(br"\N")?,
                Some(text) => {
                    if escape && text.starts_with('\\') {
                        out.write_all(br"\")?;
                    }
                    out.write_all(text.replace('"', "\"\"").as_bytes())?;
                }
            }
            out.write_all(b"\"")
        }
        out.write_all(&[0xef, 0xbb, 0xbf])?;
        for (i, column) in self.columns.iter().enumerate() {
            if i > 0 {
                out.write_all(b",")?;
            }
            field(out, Some(&column.name), false)?;
        }
        out.write_all(b"\r\n")?;
        for row in 0..self.row_count() {
            let stored = self.stored(row);
            for column in 0..self.columns.len() {
                if column > 0 {
                    out.write_all(b",")?;
                }
                field(out, self.cell_text(stored, column), true)?;
            }
            out.write_all(b"\r\n")?;
        }
        Ok(())
    }
    pub fn new(columns: Vec<ResultColumn>) -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(0);
        Self {
            id: NEXT_ID.fetch_add(1, AtomicOrdering::Relaxed),
            columns,
            text: String::new(),
            ends: Vec::new(),
            nulls: BitSet::default(),
            clipped: BitSet::default(),
            order: None,
        }
    }

    /// The stored row shown at `row`. Rows read after a sort keep their place
    /// at the end.
    fn stored(&self, row: usize) -> usize {
        match &self.order {
            Some(order) => order.get(row).map_or(row, |&stored| stored as usize),
            None => row,
        }
    }

    /// Orders the rows by one column, NULLs last in both directions, or back
    /// to the order the Server sent with `None`. Ties keep the Server's order.
    pub fn sort(&mut self, by: Option<(usize, SortDirection)>) {
        let order = self.sorted(by);
        self.apply(order);
    }

    /// The order `sort` would give, computed without changing the set, so the
    /// caller needs only a read lock while it runs; `apply` installs it.
    pub fn sorted(&self, by: Option<(usize, SortDirection)>) -> SortOrder {
        SortOrder {
            set: self.id,
            order: by
                .filter(|(column, _)| *column < self.columns.len())
                .map(|(column, direction)| self.order_by(column, direction)),
        }
    }

    /// Installs an order from `sorted`. False when it was computed on another
    /// set: the Result Sets were replaced meanwhile.
    pub fn apply(&mut self, order: SortOrder) -> bool {
        if order.set != self.id {
            return false;
        }
        self.order = order.order;
        true
    }

    fn order_by(&self, column: usize, direction: SortDirection) -> Vec<u32> {
        let rows = self.row_count();
        let kind = self.columns[column].kind;
        // Numbers are compared as numbers; parse each one once.
        let numbers: Vec<f64> = if kind == ColumnKind::Number {
            (0..rows)
                .map(|row| {
                    self.cell_text(row, column)
                        .and_then(|text| text.parse().ok())
                        .unwrap_or(f64::NAN)
                })
                .collect()
        } else {
            Vec::new()
        };
        // Text is compared case-insensitively; fold each value once, not at
        // every comparison.
        let folded: Vec<Cow<str>> = if kind == ColumnKind::Text {
            (0..rows)
                .map(|row| {
                    self.cell_text(row, column)
                        .map_or(Cow::Borrowed(""), fold_case)
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut order: Vec<u32> = (0..rows as u32).collect();
        // Stable: ties keep the Server's order. A merge sort also makes fewer
        // comparisons than an unstable one here.
        order.sort_by(|&a, &b| {
            let (a, b) = (a as usize, b as usize);
            let ordering = match (self.cell_text(a, column), self.cell_text(b, column)) {
                (None, None) => return Ordering::Equal,
                (None, Some(_)) => return Ordering::Greater,
                (Some(_), None) => return Ordering::Less,
                (Some(left), Some(right)) => match kind {
                    ColumnKind::Number => numbers[a]
                        .partial_cmp(&numbers[b])
                        .unwrap_or_else(|| left.cmp(right)),
                    ColumnKind::Date | ColumnKind::Binary => left.cmp(right),
                    // UTF-8 byte order is code point order, so comparing the
                    // folded bytes is comparing the lowercased characters.
                    ColumnKind::Text => folded[a]
                        .as_bytes()
                        .cmp(folded[b].as_bytes())
                        .then_with(|| left.cmp(right)),
                },
            };
            match direction {
                SortDirection::Ascending => ordering,
                SortDirection::Descending => ordering.reverse(),
            }
        });
        order
    }

    pub fn columns(&self) -> &[ResultColumn] {
        &self.columns
    }

    pub fn row_count(&self) -> usize {
        match self.columns.len() {
            0 => 0,
            width => self.ends.len() / width,
        }
    }

    pub fn push_row(&mut self, row: &[ColumnValues], max_cell_bytes: usize) {
        for value in row.iter().take(self.columns.len()) {
            let index = self.ends.len();
            let start = self.text.len();
            if write_value(value, &mut self.text).is_none() {
                self.nulls.set(index);
            } else if self.text.len() - start > max_cell_bytes {
                let mut cut = start + max_cell_bytes;
                while !self.text.is_char_boundary(cut) {
                    cut -= 1;
                }
                self.text.truncate(cut);
                self.clipped.set(index);
            }
            self.ends.push(self.text.len() as u64);
        }
    }

    /// Adds the complete rows of `chunk` and empties it, keeping its buffers
    /// for the next rows.
    pub fn append(&mut self, chunk: &mut RowChunk) {
        debug_assert_eq!(chunk.width, self.columns.len());
        let (text, cells, nulls, clipped) = chunk.complete;
        let base_text = self.text.len() as u64;
        let base_cell = self.ends.len();
        self.text.push_str(&chunk.text[..text]);
        self.ends
            .extend(chunk.ends[..cells].iter().map(|end| end + base_text));
        for &cell in &chunk.nulls[..nulls] {
            self.nulls.set(base_cell + cell as usize);
        }
        for &cell in &chunk.clipped[..clipped] {
            self.clipped.set(base_cell + cell as usize);
        }
        chunk.clear();
    }

    fn cell_text(&self, row: usize, column: usize) -> Option<&str> {
        let index = row * self.columns.len() + column;
        if self.nulls.get(index) {
            return None;
        }
        let start = if index == 0 {
            0
        } else {
            self.ends[index - 1] as usize
        };
        Some(&self.text[start..self.ends[index] as usize])
    }

    pub fn cell(&self, row: usize, column: usize) -> Option<CellValue> {
        if row >= self.row_count() || column >= self.columns.len() {
            return None;
        }
        let row = self.stored(row);
        Some(CellValue {
            text: self.cell_text(row, column).map(str::to_string),
            clipped: self.clipped.get(row * self.columns.len() + column),
        })
    }

    /// Rows `start..start + count` in the binary form the grid decodes
    /// (src/lib/results.ts): `u32` row count, `u32` column count, then per
    /// cell a kind byte (0 text, 1 NULL, 2 text cut to `preview_chars`), a
    /// `u32` byte length and the UTF-8 bytes, all little-endian.
    pub fn window(&self, start: usize, count: usize, preview_chars: usize) -> Vec<u8> {
        let rows = start.min(self.row_count())..(start + count).min(self.row_count());
        let width = self.columns.len();
        let mut out = Vec::with_capacity(8 + rows.len() * width * 16);
        out.extend_from_slice(&(rows.len() as u32).to_le_bytes());
        out.extend_from_slice(&(width as u32).to_le_bytes());
        for row in rows {
            let row = self.stored(row);
            for column in 0..width {
                match self.cell_text(row, column) {
                    None => {
                        out.push(1);
                        out.extend_from_slice(&0u32.to_le_bytes());
                    }
                    Some(text) => {
                        let (preview, cut) = match text.char_indices().nth(preview_chars) {
                            Some((end, _)) => (&text[..end], true),
                            None => (text, false),
                        };
                        out.push(if cut { 2 } else { 0 });
                        out.extend_from_slice(&(preview.len() as u32).to_le_bytes());
                        out.extend_from_slice(preview.as_bytes());
                    }
                }
            }
        }
        out
    }

    /// Tab-separated text of a block of cells, as SSMS copies it.
    pub fn copy_text(&self, rows: Range<usize>, columns: Range<usize>, headers: bool) -> String {
        let rows = rows.start.min(self.row_count())..rows.end.min(self.row_count());
        let columns = columns.start.min(self.columns.len())..columns.end.min(self.columns.len());
        let mut out = String::new();
        if headers {
            let names: Vec<_> = self.columns[columns.clone()]
                .iter()
                .map(|c| c.name.as_str())
                .collect();
            out.push_str(&names.join("\t"));
            out.push_str("\r\n");
        }
        for row in rows {
            let row = self.stored(row);
            for (i, column) in columns.clone().enumerate() {
                if i > 0 {
                    out.push('\t');
                }
                out.push_str(self.cell_text(row, column).unwrap_or("NULL"));
            }
            out.push_str("\r\n");
        }
        out
    }

    /// A block of cells as a GitHub-flavoured Markdown table, kept compact
    /// for LLM prompts: no padding, `|` escaped, line breaks as `<br>`, and
    /// NULL spelled out so it differs from an empty string.
    pub fn write_markdown(
        &self,
        out: &mut impl Write,
        rows: Range<usize>,
        columns: Range<usize>,
    ) -> io::Result<()> {
        let rows = rows.start.min(self.row_count())..rows.end.min(self.row_count());
        let columns = columns.start.min(self.columns.len())..columns.end.min(self.columns.len());
        let names = self.columns[columns.clone()].iter().map(|c| {
            if c.name.is_empty() {
                "(No column name)".to_string()
            } else {
                markdown_cell(&c.name)
            }
        });
        writeln!(out, "| {} |", names.collect::<Vec<_>>().join(" | "))?;
        writeln!(out, "|{}", "---|".repeat(columns.len()))?;
        for row in rows {
            let row = self.stored(row);
            let cells: Vec<_> = columns
                .clone()
                .map(|column| {
                    self.cell_text(row, column)
                        .map_or_else(|| "NULL".to_string(), markdown_cell)
                })
                .collect();
            writeln!(out, "| {} |", cells.join(" | "))?;
        }
        Ok(())
    }

    pub fn markdown(&self, rows: Range<usize>, columns: Range<usize>) -> String {
        let mut out = Vec::new();
        self.write_markdown(&mut out, rows, columns)
            .expect("writing to memory cannot fail");
        String::from_utf8(out).expect("cells are UTF-8")
    }
}

// Quoting a CSV field does not stop spreadsheet formula interpretation. Reject
// ambiguous text rather than silently changing values used in data round trips.
fn is_spreadsheet_formula(text: &str) -> bool {
    let text = text.trim_start_matches(|c: char| {
        c.is_whitespace() || c.is_control() || matches!(c, '\u{feff}' | '\u{200b}')
    });
    if text.starts_with(['+', '-'])
        && text
            .bytes()
            .all(|c| c.is_ascii_digit() || b".+-eE".contains(&c))
        && text.parse::<f64>().is_ok()
    {
        return false;
    }
    text.starts_with(['=', '+', '-', '@', '＝', '＋', '－', '＠'])
}

/// The text a sort compares, case-insensitive like the default SQL Server
/// collations: each character lowercased on its own (`char::to_lowercase`,
/// with no word-final sigma rule). Ties then fall back to exact order, so the
/// result is stable. Text with nothing to lowercase is borrowed.
fn fold_case(text: &str) -> Cow<'_, str> {
    if text.is_ascii() {
        return match text.bytes().any(|byte| byte.is_ascii_uppercase()) {
            true => Cow::Owned(text.to_ascii_lowercase()),
            false => Cow::Borrowed(text),
        };
    }
    let unchanged = text.chars().all(|c| {
        let mut lower = c.to_lowercase();
        lower.next() == Some(c) && lower.next().is_none()
    });
    match unchanged {
        true => Cow::Borrowed(text),
        false => Cow::Owned(text.chars().flat_map(char::to_lowercase).collect()),
    }
}

/// A display order from `ResultSet::sorted`, for `ResultSet::apply`.
#[derive(Debug)]
pub struct SortOrder {
    set: u64,
    order: Option<Vec<u32>>,
}

/// Rows decoded straight from the wire into display text, with no
/// `ColumnValues` row or `String` per cell, then added to a `ResultSet` a
/// batch at a time with `ResultSet::append`, under one lock.
#[derive(Debug)]
pub struct RowChunk {
    width: usize,
    max_cell_bytes: usize,
    text: String,
    /// End offset in `text` of each cell, row-major, as in `ResultSet`.
    ends: Vec<u64>,
    /// Indexes of the NULL and the clipped cells in this chunk.
    nulls: Vec<u32>,
    clipped: Vec<u32>,
    /// Cells of the row being decoded.
    row_cells: usize,
    rows: usize,
    /// Lengths of `text`, `ends`, `nulls` and `clipped` at the last complete row.
    complete: (usize, usize, usize, usize),
}

impl RowChunk {
    pub fn new(width: usize, max_cell_bytes: usize) -> Self {
        Self {
            width,
            max_cell_bytes,
            text: String::new(),
            ends: Vec::new(),
            nulls: Vec::new(),
            clipped: Vec::new(),
            row_cells: 0,
            rows: 0,
            complete: (0, 0, 0, 0),
        }
    }

    /// Complete rows waiting to be appended.
    pub fn rows(&self) -> usize {
        self.rows
    }

    /// Drops the cells of a row the driver did not finish (an error or a
    /// cancel mid-row), so only complete rows are appended.
    pub fn discard_partial_row(&mut self) {
        let (text, cells, nulls, clipped) = self.complete;
        self.text.truncate(text);
        self.ends.truncate(cells);
        self.nulls.truncate(nulls);
        self.clipped.truncate(clipped);
        self.row_cells = 0;
    }

    fn clear(&mut self) {
        self.text.clear();
        self.ends.clear();
        self.nulls.clear();
        self.clipped.clear();
        self.row_cells = 0;
        self.rows = 0;
        self.complete = (0, 0, 0, 0);
    }

    /// Writes one cell's text with `write`, clipped as `ResultSet::push_row`
    /// clips it. Values past the column count are ignored, as there.
    fn cell(&mut self, write: impl FnOnce(&mut String)) {
        if self.row_cells >= self.width {
            return;
        }
        let index = self.ends.len() as u32;
        let start = self.text.len();
        write(&mut self.text);
        if self.text.len() - start > self.max_cell_bytes {
            let mut cut = start + self.max_cell_bytes;
            while !self.text.is_char_boundary(cut) {
                cut -= 1;
            }
            self.text.truncate(cut);
            self.clipped.push(index);
        }
        self.ends.push(self.text.len() as u64);
        self.row_cells += 1;
    }

    /// Fixed-size and rarer values go through `write_value`, so each type is
    /// formatted in one place.
    fn value(&mut self, value: ColumnValues) {
        self.cell(|out| {
            let _ = write_value(&value, out);
        });
    }
}

impl RowWriter for RowChunk {
    fn write_null(&mut self, _col: usize) {
        if self.row_cells >= self.width {
            return;
        }
        self.nulls.push(self.ends.len() as u32);
        self.ends.push(self.text.len() as u64);
        self.row_cells += 1;
    }
    fn write_bool(&mut self, _col: usize, val: bool) {
        self.value(ColumnValues::Bit(val));
    }
    fn write_u8(&mut self, _col: usize, val: u8) {
        self.value(ColumnValues::TinyInt(val));
    }
    fn write_i16(&mut self, _col: usize, val: i16) {
        self.value(ColumnValues::SmallInt(val));
    }
    fn write_i32(&mut self, _col: usize, val: i32) {
        self.value(ColumnValues::Int(val));
    }
    fn write_i64(&mut self, _col: usize, val: i64) {
        self.value(ColumnValues::BigInt(val));
    }
    fn write_f32(&mut self, _col: usize, val: f32) {
        self.value(ColumnValues::Real(val));
    }
    fn write_f64(&mut self, _col: usize, val: f64) {
        self.value(ColumnValues::Float(val));
    }
    fn write_string(&mut self, _col: usize, bytes: Cow<'_, [u8]>, encoding_type: EncodingType) {
        self.cell(|out| write_text(&bytes, encoding_type, out));
    }
    fn write_bytes(&mut self, _col: usize, bytes: Cow<'_, [u8]>) {
        self.cell(|out| write_hex(&bytes, out));
    }
    fn write_decimal(&mut self, _col: usize, val: DecimalParts) {
        self.value(ColumnValues::Decimal(val));
    }
    fn write_numeric(&mut self, _col: usize, val: DecimalParts) {
        self.value(ColumnValues::Numeric(val));
    }
    fn write_date(&mut self, _col: usize, val: SqlDate) {
        self.value(ColumnValues::Date(val));
    }
    fn write_time(&mut self, _col: usize, val: SqlTime) {
        self.value(ColumnValues::Time(val));
    }
    fn write_datetime(&mut self, _col: usize, val: SqlDateTime) {
        self.value(ColumnValues::DateTime(val));
    }
    fn write_smalldatetime(&mut self, _col: usize, val: SqlSmallDateTime) {
        self.value(ColumnValues::SmallDateTime(val));
    }
    fn write_datetime2(&mut self, _col: usize, val: SqlDateTime2) {
        self.value(ColumnValues::DateTime2(val));
    }
    fn write_datetimeoffset(&mut self, _col: usize, val: SqlDateTimeOffset) {
        self.value(ColumnValues::DateTimeOffset(val));
    }
    fn write_money(&mut self, _col: usize, val: SqlMoney) {
        self.value(ColumnValues::Money(val));
    }
    fn write_smallmoney(&mut self, _col: usize, val: SqlSmallMoney) {
        self.value(ColumnValues::SmallMoney(val));
    }
    fn write_uuid(&mut self, _col: usize, val: Uuid) {
        self.value(ColumnValues::Uuid(val));
    }
    fn write_xml(&mut self, _col: usize, val: SqlXml) {
        self.value(ColumnValues::Xml(val));
    }
    fn write_json(&mut self, _col: usize, val: SqlJson) {
        self.value(ColumnValues::Json(val));
    }
    fn write_vector(&mut self, _col: usize, val: SqlVector) {
        self.value(ColumnValues::Vector(val));
    }
    fn end_row(&mut self) {
        // A row the driver sent short still fills every column.
        while self.row_cells < self.width {
            self.write_null(self.row_cells);
        }
        self.row_cells = 0;
        self.rows += 1;
        self.complete = (
            self.text.len(),
            self.ends.len(),
            self.nulls.len(),
            self.clipped.len(),
        );
    }
}

fn markdown_cell(text: &str) -> String {
    text.replace('|', r"\|")
        .replace("\r\n", "<br>")
        .replace(['\n', '\r'], "<br>")
}

#[derive(Debug, Default)]
struct BitSet(Vec<u64>);

impl BitSet {
    fn set(&mut self, index: usize) {
        let word = index / 64;
        if self.0.len() <= word {
            self.0.resize(word + 1, 0);
        }
        self.0[word] |= 1 << (index % 64);
    }

    fn get(&self, index: usize) -> bool {
        self.0
            .get(index / 64)
            .is_some_and(|word| word & (1 << (index % 64)) != 0)
    }
}

#[cfg(test)]
mod tests {
    use mssql_tds::datatypes::sql_string::SqlString;

    use super::*;

    fn set() -> ResultSet {
        let mut set = ResultSet::new(vec![
            ResultColumn {
                name: "Id".into(),
                kind: ColumnKind::Number,
            },
            ResultColumn {
                name: "Name".into(),
                kind: ColumnKind::Text,
            },
        ]);
        for (id, name) in [
            (1, Some("Rossi")),
            (2, None),
            (3, Some("Bianchi, \"Gino\"")),
        ] {
            let name = name.map_or(ColumnValues::Null, |n| {
                ColumnValues::String(SqlString::from_utf8_string(n.into()))
            });
            set.push_row(&[ColumnValues::Int(id), name], 100);
        }
        set
    }

    #[test]
    fn stores_rows_and_nulls() {
        let set = set();
        assert_eq!(set.row_count(), 3);
        assert_eq!(set.cell(0, 1).unwrap().text.as_deref(), Some("Rossi"));
        assert_eq!(set.cell(1, 1).unwrap().text, None);
        assert_eq!(set.cell(2, 0).unwrap().text.as_deref(), Some("3"));
        assert_eq!(set.cell(3, 0), None);
    }

    #[test]
    fn csv_preserves_nulls_quotes_and_display_order() {
        let mut data = set();
        data.sort(Some((0, SortDirection::Descending)));
        let mut out = Vec::new();
        data.write_csv(&mut out).unwrap();
        assert_eq!(&out[..3], &[0xef, 0xbb, 0xbf]);
        let text = String::from_utf8(out).unwrap();
        assert!(text.contains(r#""2","\N""#));
        assert!(text.contains(r#"Bianchi, ""Gino"""#));
        assert!(text.lines().nth(1).unwrap().starts_with(r#""3""#));
    }

    #[test]
    fn csv_rejects_formula_cells_and_headers_without_changing_data() {
        for text in [
            "=1+1",
            "+SUM(A1)",
            "-1+2",
            "@SUM(A1)",
            " \t\r\n=1+1",
            "\u{feff}=1",
            "\u{200b}=1",
            "＝1+1",
            "＋SUM(A1)",
            "－1+2",
            "＠SUM(A1)",
        ] {
            let mut data = ResultSet::new(vec![ResultColumn {
                name: "Value".into(),
                kind: ColumnKind::Text,
            }]);
            data.push_row(
                &[ColumnValues::String(SqlString::from_utf8_string(
                    text.into(),
                ))],
                1024,
            );
            let error = data.write_csv(&mut Vec::new()).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            assert!(error.to_string().contains(".xlsx"));
            assert_eq!(data.cell(0, 0).unwrap().text.as_deref(), Some(text));
            data.columns[0].name = text.into();
            let mut header_only = ResultSet::new(data.columns.clone());
            assert!(header_only.write_csv(&mut Vec::new()).is_err());
            // A clean header with no rows must still be a valid export.
            header_only.columns[0].name = "Value".into();
            assert!(header_only.write_csv(&mut Vec::new()).is_ok());
        }
    }

    #[test]
    fn csv_preserves_signed_numeric_literals_and_ordinary_text() {
        for text in [
            "-123",
            "+123",
            "-12.50",
            "+1.2e-3",
            "-.5",
            "-1e999",
            "text=1",
            "a,b",
            "a\"b",
            "",
            "line one\nline two",
        ] {
            let mut data = ResultSet::new(vec![ResultColumn {
                name: "Value".into(),
                kind: ColumnKind::Text,
            }]);
            data.push_row(
                &[ColumnValues::String(SqlString::from_utf8_string(
                    text.into(),
                ))],
                1024,
            );
            let mut out = Vec::new();
            data.write_csv(&mut out).unwrap();
            assert!(
                String::from_utf8(out)
                    .unwrap()
                    .contains(&format!("\"{}\"", text.replace('"', "\"\"")))
            );
        }
    }

    #[test]
    fn lossy_results_cannot_be_exported_as_complete_data() {
        let mut data = set();
        data.push_row(
            &[
                ColumnValues::Int(4),
                ColumnValues::String(SqlString::from_utf8_string("clipped".into())),
            ],
            2,
        );
        let mut out = Vec::new();
        assert!(data.write_csv(&mut out).is_err());
        assert!(out.is_empty());
    }

    #[test]
    fn clips_long_values_on_a_char_boundary() {
        let mut set = ResultSet::new(vec![ResultColumn {
            name: "x".into(),
            kind: ColumnKind::Text,
        }]);
        set.push_row(
            &[ColumnValues::String(SqlString::from_utf8_string(
                "àààà".into(),
            ))],
            5,
        );
        let cell = set.cell(0, 0).unwrap();
        assert_eq!(cell.text.as_deref(), Some("àà"));
        assert!(cell.clipped);
    }

    #[test]
    fn window_encodes_kinds_and_previews() {
        let window = set().window(1, 10, 3);
        let u32_at = |at: usize| u32::from_le_bytes(window[at..at + 4].try_into().unwrap());
        assert_eq!((u32_at(0), u32_at(4)), (2, 2));
        // Row 1: "2", NULL.
        assert_eq!((window[8], u32_at(9), window[13]), (0, 1, b'2'));
        assert_eq!((window[14], u32_at(15)), (1, 0));
        // Row 2: "3", then "Bianchi…" cut to 3 chars.
        assert_eq!(window[19..25], [0, 1, 0, 0, 0, b'3']);
        assert_eq!((window[25], u32_at(26)), (2, 3));
        assert_eq!(&window[30..33], b"Bia");
    }

    #[test]
    fn copies_like_ssms() {
        assert_eq!(
            set().copy_text(0..2, 0..2, true),
            "Id\tName\r\n1\tRossi\r\n2\tNULL\r\n"
        );
        assert_eq!(set().copy_text(2..9, 1..2, false), "Bianchi, \"Gino\"\r\n");
    }

    #[test]
    fn markdown_is_compact_and_escaped() {
        let mut set = set();
        set.push_row(
            &[
                ColumnValues::Int(4),
                ColumnValues::String(SqlString::from_utf8_string("a|b\r\nc".into())),
            ],
            100,
        );
        assert_eq!(
            set.markdown(0..9, 0..2),
            concat!(
                "| Id | Name |\n",
                "|---|---|\n",
                "| 1 | Rossi |\n",
                "| 2 | NULL |\n",
                "| 3 | Bianchi, \"Gino\" |\n",
                "| 4 | a\\|b<br>c |\n",
            )
        );
        assert_eq!(set.markdown(0..1, 1..2), "| Name |\n|---|\n| Rossi |\n");
    }
    #[test]
    fn sorts_numbers_text_and_nulls_without_moving_the_data() {
        let mut set = set();
        set.push_row(
            &[
                ColumnValues::Int(10),
                ColumnValues::String(SqlString::from_utf8_string("alfa".into())),
            ],
            100,
        );
        let names = |set: &ResultSet| -> Vec<Option<String>> {
            (0..set.row_count())
                .map(|row| set.cell(row, 1).unwrap().text)
                .collect()
        };
        // Numbers as numbers: 10 before 3 when descending, not after 1.
        set.sort(Some((0, SortDirection::Descending)));
        assert_eq!(set.cell(0, 0).unwrap().text.as_deref(), Some("10"));
        assert_eq!(set.cell(3, 0).unwrap().text.as_deref(), Some("1"));
        // Text ignores case; NULL stays last in both directions.
        set.sort(Some((1, SortDirection::Ascending)));
        assert_eq!(
            names(&set),
            [
                Some("alfa".into()),
                Some("Bianchi, \"Gino\"".into()),
                Some("Rossi".into()),
                None
            ]
        );
        set.sort(Some((1, SortDirection::Descending)));
        assert_eq!(names(&set).last(), Some(&None));
        // Copies follow what is shown.
        assert_eq!(set.copy_text(0..1, 1..2, false), "Rossi\r\n");
        // None goes back to the Server's order.
        set.sort(None);
        assert_eq!(set.cell(0, 1).unwrap().text.as_deref(), Some("Rossi"));
    }

    #[test]
    fn row_chunks_append_complete_rows_with_their_nulls_and_clips() {
        let mut data = set();
        let mut chunk = RowChunk::new(2, 4);
        chunk.write_i32(0, 4);
        chunk.write_string(1, Cow::Borrowed(b"Verdi"), EncodingType::Utf8);
        chunk.end_row();
        // A short row is padded with NULL; a value past the columns is ignored.
        chunk.write_i32(0, 5);
        chunk.end_row();
        chunk.write_i32(0, 6);
        chunk.write_string(1, Cow::Borrowed(&[b'B', 0, 0xE8, 0]), EncodingType::Utf16);
        chunk.write_i32(2, 99);
        chunk.end_row();
        // A row the driver did not finish is dropped.
        chunk.write_i32(0, 7);
        chunk.discard_partial_row();
        data.append(&mut chunk);

        assert_eq!(chunk.rows(), 0);
        assert_eq!(data.row_count(), 6);
        let text = |row, column| data.cell(row, column).unwrap().text;
        assert_eq!(text(1, 1), None, "rows already there are untouched");
        assert_eq!(text(2, 1).as_deref(), Some("Bianchi, \"Gino\""));
        assert_eq!(text(3, 0).as_deref(), Some("4"));
        assert_eq!(
            data.cell(3, 1),
            Some(CellValue {
                text: Some("Verd".into()),
                clipped: true
            })
        );
        assert_eq!(text(4, 1), None);
        assert_eq!(text(5, 0).as_deref(), Some("6"));
        assert_eq!(text(5, 1).as_deref(), Some("Bè"));
        assert!(!data.cell(5, 1).unwrap().clipped);
    }
}
