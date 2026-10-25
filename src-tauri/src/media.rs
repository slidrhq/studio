//! The media library, to the studio's pages, where the app's pages find it:
//! `media://localhost/<path>` (`http://media.localhost/…` on Windows), the address
//! `@slidr/media-library` gives a file of the library inside a Tauri window (its `mediaUrl`). The
//! app keeps a copy of the library on the machine; the studio reads each file from the library
//! it works with (`SLIDR_MEDIA_URL`, the published one by default) when a page asks for it: the
//! manifest, and the pictures of the templates' samples.

use std::{borrow::Cow, time::Duration};

use tauri::http::{Request, Response, StatusCode, header};

use crate::net;

pub const SCHEME: &str = "media";

fn answer(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        // The render page asks from its own origin, which is not this one.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())))
}

/// The library's own address of a page's request: its path as the page wrote it, still encoded.
fn source(media_url: &str, path: &str) -> Option<String> {
    let path = path.trim_start_matches('/');
    let plain = !path.is_empty()
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != ".." && !part.contains('\\'));
    plain.then(|| format!("{}/{path}", media_url.trim_end_matches('/')))
}

/// The library's file a request names, as the library answers it.
pub async fn respond(media_url: &str, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let Some(url) = source(media_url, request.uri().path()) else {
        return answer(
            StatusCode::NOT_FOUND,
            "text/plain",
            b"No such file.".to_vec(),
        );
    };
    let sent = net::client()
        .get(&url)
        .timeout(Duration::from_secs(60))
        .send()
        .await;
    let Ok(sent) = sent else {
        return answer(
            StatusCode::BAD_GATEWAY,
            "text/plain",
            b"The library could not be reached.".to_vec(),
        );
    };
    let status = StatusCode::from_u16(sent.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let content_type = sent
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_owned();
    match sent.bytes().await {
        Ok(bytes) => answer(status, &content_type, bytes.to_vec()),
        Err(_) => answer(StatusCode::BAD_GATEWAY, "text/plain", Vec::new()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_page_reaches_the_library_and_nothing_beside_it() {
        let library = "https://slidr-media.pages.dev/";
        assert_eq!(
            source(library, "/images/templates/a%20b.webp").as_deref(),
            Some("https://slidr-media.pages.dev/images/templates/a%20b.webp")
        );
        assert_eq!(
            source(library, "/manifest.json").as_deref(),
            Some("https://slidr-media.pages.dev/manifest.json")
        );
        assert_eq!(source(library, "/../secret"), None);
        assert_eq!(source(library, "/"), None);
        assert_eq!(source(library, "/a//b"), None);
    }
}
