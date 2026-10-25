//! The studio's key to the library's upload API, in the credential store of the operating system
//! (the Windows Credential Manager), under the studio's identifier, as the app keeps its keys
//! (`src-tauri/src/secrets/keychain.rs`). Given once in the Publish panel, it is there the next
//! time the studio starts; `SLIDR_LIBRARY_KEY` still wins over it.

use keyring::{Entry, Error};

/// The service the entry is kept under: the studio's identifier.
const SERVICE: &str = "slidr.studio";
const LIBRARY_KEY: &str = "library-key";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, LIBRARY_KEY).map_err(|e| e.to_string())
}

/// The key given before; none when it never was, or the store cannot be read.
pub fn library_key() -> Option<String> {
    match entry().ok()?.get_password() {
        Ok(key) if !key.is_empty() => Some(key),
        Ok(_) | Err(Error::NoEntry) => None,
        Err(error) => {
            eprintln!("slidr-studio: the library key could not be read: {error}");
            None
        }
    }
}

pub fn set_library_key(key: &str) -> Result<(), String> {
    entry()?
        .set_password(key)
        .map_err(|e| format!("The key could not be kept in the credential store: {e}"))
}
