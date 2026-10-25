//! The studio's one HTTP client: the media library, its font catalog, and the library's upload API.

use std::{sync::LazyLock, time::Duration};

use serde_json::Value;

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .user_agent("slidr-studio")
        .connect_timeout(Duration::from_secs(20))
        .build()
        .unwrap_or_default()
});

pub fn client() -> &'static reqwest::Client {
    &CLIENT
}

/// A failed read: the site answered with a status, or could not be reached.
#[derive(Debug)]
pub enum FetchError {
    Status(u16),
    Failed(String),
}

impl std::fmt::Display for FetchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Status(status) => write!(f, "HTTP Error {status}"),
            Self::Failed(error) => f.write_str(error),
        }
    }
}

/// A file of a site, as it is now (never a cached copy).
pub async fn fetch(url: &str, timeout: Duration) -> Result<Vec<u8>, FetchError> {
    let answer = client()
        .get(url)
        .header("Cache-Control", "no-cache")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| FetchError::Failed(e.to_string()))?;
    let status = answer.status();
    if !status.is_success() {
        return Err(FetchError::Status(status.as_u16()));
    }
    answer
        .bytes()
        .await
        .map(|bytes| bytes.to_vec())
        .map_err(|e| FetchError::Failed(e.to_string()))
}

/// A JSON file of a site.
pub async fn fetch_json(url: &str, timeout: Duration) -> Result<Value, String> {
    let bytes = fetch(url, timeout).await.map_err(|e| e.to_string())?;
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}
