//! The studio's token to the library's API, in the credential store of the operating system (the
//! Windows Credential Manager), under the studio's identifier, as the app keeps its keys
//! (`src-tauri/src/secrets/keychain.rs`). Given once in the Publish panel, it is there the next
//! time the studio starts; `SLIDR_LIBRARY_TOKEN` still wins over it.

use keyring::{Entry, Error};

/// The service the entry is kept under: the studio's identifier.
const SERVICE: &str = "slidr.studio";
const LIBRARY_TOKEN: &str = "library-token";
/// Where a program's key to the library was kept, before the library took tokens alone.
const LIBRARY_KEY: &str = "library-key";

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

/// The token given before; none when it never was, or the store cannot be read.
pub fn library_token() -> Option<String> {
    match entry(LIBRARY_TOKEN).ok()?.get_password() {
        Ok(token) if !token.is_empty() => Some(token),
        Ok(_) | Err(Error::NoEntry) => None,
        Err(error) => {
            eprintln!("slidr-studio: the library token could not be read: {error}");
            None
        }
    }
}

/// Keeps the token, and takes away the key kept before, which the library no longer takes.
pub fn set_library_token(token: &str) -> Result<(), String> {
    entry(LIBRARY_TOKEN)?
        .set_password(token)
        .map_err(|e| format!("The token could not be kept in the credential store: {e}"))?;
    if let Ok(old) = entry(LIBRARY_KEY) {
        let _ = old.delete_credential();
    }
    Ok(())
}
