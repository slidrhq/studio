//! The files of a variant's working folder, to the studio's pages: `studio://localhost/<vid>/<path>`
//! (`http://studio.localhost/…` on Windows), as `convertFileSrc(path, 'studio')` names them. The
//! picture, its renders and their results; never a file outside the variant's folder.

use std::{borrow::Cow, fs, path::Path};

use percent_encoding::percent_decode_str;
use tauri::http::{Request, Response, StatusCode, header};

use crate::store::Store;

pub const SCHEME: &str = "studio";

fn content_type(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|ext| ext.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("webp") => "image/webp",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("json") => "application/json",
        Some("html") => "text/html; charset=utf-8",
        Some("md" | "txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn answer(status: StatusCode, content_type: &str, body: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-store")
        // The render page reads the picture from its own origin, which is not this one.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Cow::Owned(body))
        .unwrap_or_else(|_| Response::new(Cow::Owned(Vec::new())))
}

fn missing() -> Response<Cow<'static, [u8]>> {
    answer(
        StatusCode::NOT_FOUND,
        "text/plain",
        b"No such file.".to_vec(),
    )
}

/// The file a request names, read from the variant's working folder.
pub fn respond(store: &Store, request: &Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = percent_decode_str(request.uri().path().trim_start_matches('/')).decode_utf8_lossy();
    let Some((vid, name)) = path.split_once('/') else {
        return missing();
    };
    let Some(variant) = store.variant(vid) else {
        return missing();
    };
    let Ok(work) = fs::canonicalize(store.work_dir(&variant)) else {
        return missing();
    };
    let Ok(file) = fs::canonicalize(work.join(name)) else {
        return missing();
    };
    if !file.starts_with(&work) || !file.is_file() {
        return missing();
    }
    match fs::read(&file) {
        Ok(bytes) => answer(StatusCode::OK, content_type(&file), bytes),
        Err(_) => missing(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::{
        NewVariant, Request as StudioRequest, RequestKind,
        tests::{design_brief, store},
    };

    #[test]
    fn a_variant_serves_its_own_files_and_nothing_else() {
        let dir = tempfile::tempdir().expect("a folder");
        let store = store(dir.path());
        let request = store.create_request(StudioRequest::draft(RequestKind::Design, "x".into()));
        let variant = store
            .create_variant(&request.id, design_brief(), NewVariant::default())
            .expect("a variant");
        let work = store.work_dir(&variant);
        fs::create_dir_all(work.join("renders/r1")).expect("a folder");
        fs::write(work.join("renders/r1/en-full.png"), b"png").expect("written");
        let get = |path: &str| {
            let request = Request::builder()
                .uri(format!("http://studio.localhost/{path}"))
                .body(Vec::new())
                .expect("a request");
            respond(&store, &request)
        };
        let found = get(&format!("{}%2Frenders%2Fr1%2Fen-full.png?r=2", variant.id));
        assert_eq!(found.status(), StatusCode::OK);
        assert_eq!(found.body().as_ref(), b"png");
        assert_eq!(found.headers()[header::CONTENT_TYPE], "image/png");
        assert_eq!(
            get(&format!("{}/..%2Fstate.json", variant.id)).status(),
            StatusCode::NOT_FOUND
        );
        assert_eq!(get("nosuch/x.png").status(), StatusCode::NOT_FOUND);
    }
}
