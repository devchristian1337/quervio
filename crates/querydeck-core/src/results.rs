//! Result Sets kept on the Rust side (docs/adr/0001-result-set-nel-backend-rust.md):
//! every cell's display text in one buffer, so a million rows stay compact,
//! and the grid only ever asks for the window it shows.

use std::io::{self, Write};
use std::ops::Range;
use std::sync::{Arc, RwLock};

use mssql_tds::datatypes::column_values::ColumnValues;
use serde::Serialize;

use crate::format::write_value;

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
    columns: Vec<ResultColumn>,
    text: String,
    /// End offset in `text` of each cell, row-major.
    ends: Vec<u64>,
    nulls: BitSet,
    clipped: BitSet,
}

impl ResultSet {
    pub fn new(columns: Vec<ResultColumn>) -> Self {
        Self {
            columns,
            text: String::new(),
            ends: Vec::new(),
            nulls: BitSet::default(),
            clipped: BitSet::default(),
        }
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
            ResultColumn { name: "Id".into() },
            ResultColumn {
                name: "Name".into(),
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
    fn clips_long_values_on_a_char_boundary() {
        let mut set = ResultSet::new(vec![ResultColumn { name: "x".into() }]);
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
}
