//! `.sql` files as SSMS writes them: UTF-8 or UTF-16 with a byte order
//! mark, or older files in the Windows ANSI code page (1252).

use std::fs;
use std::path::Path;

use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};

use crate::error::Result;

/// Reads a script, detecting its encoding.
pub fn read_script(path: &Path) -> Result<String> {
    Ok(decode(&fs::read(path)?))
}

/// Writes a script as UTF-8 with a BOM, which SSMS and Notepad both read
/// back correctly, with Windows line endings.
pub fn write_script(path: &Path, text: &str) -> Result<()> {
    let normalized = text.replace("\r\n", "\n").replace('\n', "\r\n");
    let mut bytes = Vec::with_capacity(normalized.len() + 3);
    bytes.extend_from_slice(b"\xEF\xBB\xBF");
    bytes.extend_from_slice(normalized.as_bytes());
    // Write through a temporary file so a failure never truncates the script.
    let temporary = path.with_extension("sql.tmp");
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, path)?;
    Ok(())
}

fn decode(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(b"\xEF\xBB\xBF") {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFF\xFE") {
        return UTF_16LE.decode_without_bom_handling(rest).0.into_owned();
    }
    if let Some(rest) = bytes.strip_prefix(b"\xFE\xFF") {
        return UTF_16BE.decode_without_bom_handling(rest).0.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(text) => text.to_string(),
        // Not UTF-8: an old script saved in the ANSI code page.
        Err(_) => WINDOWS_1252
            .decode_without_bom_handling(bytes)
            .0
            .into_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_every_encoding_ssms_writes() {
        let text = "SELECT N'àè€'";
        let utf16le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let utf16be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain(text.encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        let utf8_bom = [b"\xEF\xBB\xBF".as_slice(), text.as_bytes()].concat();
        let ansi = WINDOWS_1252.encode(text).0.into_owned();

        for bytes in [utf16le, utf16be, utf8_bom, text.as_bytes().to_vec(), ansi] {
            assert_eq!(decode(&bytes), text);
        }
    }

    #[test]
    fn writes_utf8_with_bom_and_crlf_and_reads_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("q.sql");
        write_script(&path, "SELECT 'à'\nGO\r\nSELECT 2").unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
        assert_eq!(read_script(&path).unwrap(), "SELECT 'à'\r\nGO\r\nSELECT 2");
        assert!(!dir.path().join("q.sql.tmp").exists());
    }
}
