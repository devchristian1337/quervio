//! Saved Connection passwords, encrypted with DPAPI for the current Windows
//! user and kept in their own file next to the connections
//! (docs/adr/0003-passwords-with-dpapi.md).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use crate::error::{Error, Result};

/// Where Saved Connection passwords are kept, keyed by connection id.
pub trait SecretStore: Send + Sync {
    fn get(&self, connection_id: &str) -> Result<Option<String>>;
    fn set(&self, connection_id: &str, secret: &str) -> Result<()>;
    fn delete(&self, connection_id: &str) -> Result<()>;
}

/// A JSON file of DPAPI-encrypted passwords. Only the Windows user who wrote
/// it can decrypt it.
pub struct DpapiSecretStore {
    path: PathBuf,
    // Serialises read-modify-write of the file.
    lock: Mutex<()>,
}

impl DpapiSecretStore {
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            lock: Mutex::new(()),
        }
    }

    fn read(&self) -> Result<BTreeMap<String, String>> {
        match fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(error) => Err(error.into()),
        }
    }

    fn write(&self, entries: &BTreeMap<String, String>) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let temporary = self.path.with_extension("tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(entries)?)?;
        fs::rename(&temporary, &self.path)?;
        Ok(())
    }
}

impl SecretStore for DpapiSecretStore {
    fn get(&self, connection_id: &str) -> Result<Option<String>> {
        let _guard = self.lock.lock().expect("secret store lock");
        let Some(encoded) = self.read()?.remove(connection_id) else {
            return Ok(None);
        };
        let encrypted = from_hex(&encoded)
            .ok_or_else(|| Error::Secrets("stored password is not valid hex".into()))?;
        let plain = dpapi::unprotect(&encrypted)?;
        String::from_utf8(plain)
            .map(Some)
            .map_err(|_| Error::Secrets("stored password is not valid UTF-8".into()))
    }

    fn set(&self, connection_id: &str, secret: &str) -> Result<()> {
        let _guard = self.lock.lock().expect("secret store lock");
        let mut entries = self.read()?;
        entries.insert(
            connection_id.to_string(),
            to_hex(&dpapi::protect(secret.as_bytes())?),
        );
        self.write(&entries)
    }

    fn delete(&self, connection_id: &str) -> Result<()> {
        let _guard = self.lock.lock().expect("secret store lock");
        let mut entries = self.read()?;
        if entries.remove(connection_id).is_some() {
            self.write(&entries)?;
        }
        Ok(())
    }
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn from_hex(text: &str) -> Option<Vec<u8>> {
    if !text.len().is_multiple_of(2) {
        return None;
    }
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(text.get(i..i + 2)?, 16).ok())
        .collect()
}

#[cfg(windows)]
mod dpapi {
    use std::ptr;

    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };

    use crate::error::{Error, Result};

    /// Ties the ciphertext to Quervio, so another app's DPAPI blob for the
    /// same user cannot be swapped in. It still says Querydeck, the app's
    /// first name: changing it would make every saved password unreadable.
    const ENTROPY: &[u8] = b"Querydeck saved connection";

    fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB {
            cbData: bytes.len() as u32,
            pbData: bytes.as_ptr().cast_mut(),
        }
    }

    /// Copies DPAPI's output and frees it.
    unsafe fn take(output: CRYPT_INTEGER_BLOB) -> Vec<u8> {
        let bytes =
            unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize) }.to_vec();
        unsafe { LocalFree(output.pbData.cast()) };
        bytes
    }

    pub fn protect(plain: &[u8]) -> Result<Vec<u8>> {
        let input = blob(plain);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: input and entropy point at live slices for the call; DPAPI
        // allocates output with LocalAlloc, which `take` frees.
        let ok = unsafe {
            CryptProtectData(
                &input,
                ptr::null(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(Error::Secrets(format!(
                "could not encrypt: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(unsafe { take(output) })
    }

    pub fn unprotect(encrypted: &[u8]) -> Result<Vec<u8>> {
        let input = blob(encrypted);
        let entropy = blob(ENTROPY);
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in `protect`.
        let ok = unsafe {
            CryptUnprotectData(
                &input,
                ptr::null_mut(),
                &entropy,
                ptr::null(),
                ptr::null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        };
        if ok == 0 {
            return Err(Error::Secrets(format!(
                "could not decrypt: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(unsafe { take(output) })
    }
}

#[cfg(not(windows))]
mod dpapi {
    use crate::error::{Error, Result};

    pub fn protect(_: &[u8]) -> Result<Vec<u8>> {
        Err(Error::Secrets("DPAPI needs Windows".into()))
    }

    pub fn unprotect(_: &[u8]) -> Result<Vec<u8>> {
        Err(Error::Secrets("DPAPI needs Windows".into()))
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_never_stores_plain_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.json");
        let store = DpapiSecretStore::new(&path);

        assert_eq!(store.get("a").unwrap(), None);
        store.set("a", "pässword").unwrap();
        store.set("b", "other").unwrap();
        assert_eq!(store.get("a").unwrap().as_deref(), Some("pässword"));

        let on_disk = fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("other"));
        assert!(!on_disk.contains(&to_hex("other".as_bytes())));

        store.delete("a").unwrap();
        store.delete("a").unwrap();
        assert_eq!(store.get("a").unwrap(), None);
        assert_eq!(
            DpapiSecretStore::new(&path).get("b").unwrap().as_deref(),
            Some("other")
        );
    }

    #[test]
    fn hex_round_trips() {
        assert_eq!(from_hex(&to_hex(&[0, 15, 255])), Some(vec![0, 15, 255]));
        assert_eq!(from_hex("abc"), None);
        assert_eq!(from_hex("zz"), None);
    }
}
