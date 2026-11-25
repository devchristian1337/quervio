//! `.sql` files as SSMS writes them: UTF-8 or UTF-16 with a byte order
//! mark, or older files in the Windows ANSI code page (1252).

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use encoding_rs::{UTF_16BE, UTF_16LE, WINDOWS_1252};

use crate::error::Result;

/// Reads a script, detecting its encoding.
pub fn read_script(path: &Path) -> Result<String> {
    Ok(decode(&fs::read(path)?))
}

/// Writes a script as UTF-8 with a BOM, which SSMS and Notepad both read
/// back correctly, with Windows line endings.
pub fn write_script(path: &Path, text: &str) -> Result<()> {
    let normalized = text
        .replace("\r\n", "\n")
        .replace('\r', "\n")
        .replace('\n', "\r\n");
    let mut bytes = Vec::with_capacity(normalized.len() + 3);
    bytes.extend_from_slice(b"\xEF\xBB\xBF");
    bytes.extend_from_slice(normalized.as_bytes());
    // Write through a unique flushed temporary file so concurrent or failed
    // saves never truncate the script, collide across extensions, or leave
    // stale temp files behind.
    let temporary = unique_temp_path(path);
    let write_result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error.into());
    }
    Ok(())
}

fn unique_temp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(format!(".{}.tmp", uuid::Uuid::new_v4().simple()));
    path.with_file_name(name)
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
        write_script(&path, "SELECT 'à'\nGO\r\nSELECT 2\rSELECT 3").unwrap();
        let bytes = fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
        assert_eq!(
            read_script(&path).unwrap(),
            "SELECT 'à'\r\nGO\r\nSELECT 2\r\nSELECT 3"
        );
        assert!(!dir.path().join("q.sql.tmp").exists());
    }

    #[test]
    fn write_script_preserves_bystander_tmp_files_and_cleans_up_on_error() {
        let dir = tempfile::tempdir().unwrap();
        let bystander = dir.path().join("report.sql.tmp");
        fs::write(&bystander, "keep me").unwrap();
        let target = dir.path().join("report.txt");
        write_script(&target, "SELECT 1").unwrap();
        assert_eq!(fs::read_to_string(&bystander).unwrap(), "keep me");

        let blocked = dir.path().join("locked.sql");
        fs::create_dir(&blocked).unwrap();
        let err = write_script(&blocked, "SELECT 1").unwrap_err();
        assert!(!err.to_string().contains("saved connections"), "{err}");
        let leftover: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("locked.sql."))
            .collect();
        assert!(leftover.is_empty(), "leftover temp files: {leftover:?}");
    }
}
