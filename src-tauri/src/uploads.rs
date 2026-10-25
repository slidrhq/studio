//! Uploads to Slidr Library ([slidrhq/library](https://github.com/slidrhq/library), README
//! "Uploading"): the studio sends its approved work to the library's REST API, which checks it
//! against the published library and keeps it until an editor accepts it. A publication takes the
//! accepted uploads into the library from there; the studio does not publish the author copy for them.
//!
//! A design goes as `designs: add`, with its picture, its slide in each language it was made in, and
//! its names and search tags in Hebrew and English (ADR-108 of the app); a template's sample as
//! `templates: translate`, in its language. The studio signs in as a program, by its key
//! (`Authorization: Bearer`, the Worker's `LIBRARY_KEYS`).

use std::time::Duration;

use serde_json::{Map, Value, json};

use crate::{languages, net};

const TIMEOUT: Duration = Duration::from_secs(120);

/// The library did not take an upload: why, and each issue at its place.
#[derive(Debug)]
pub struct UploadError {
    pub message: String,
    pub issues: Vec<Value>,
}

impl UploadError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            issues: Vec::new(),
        }
    }
}

/// A design of the studio, as the library's `designs: add` takes it.
///
/// `record` is what publishing writes into `managed.json` (`library::design_record`): its id,
/// names, group, slides by language, subject, and its tags when it has them.
pub fn design_upload(record: &Value) -> Value {
    let mut languages = Map::new();
    if let Some(slides) = record.get("slides").and_then(Value::as_object) {
        for (lang, slide) in slides {
            let mut part = Map::new();
            part.insert("slide".into(), slide.clone());
            if languages::is_base(lang) {
                part.insert(
                    "name".into(),
                    record
                        .pointer(&format!("/name/{lang}"))
                        .cloned()
                        .unwrap_or(Value::Null),
                );
                if let Some(group_name) = record
                    .pointer(&format!("/groupName/{lang}"))
                    .filter(|name| name.as_str().is_some_and(|name| !name.is_empty()))
                {
                    part.insert("groupName".into(), group_name.clone());
                }
                if let Some(tags) = record
                    .pointer(&format!("/tags/{lang}"))
                    .filter(|tags| tags.as_array().is_some_and(|tags| !tags.is_empty()))
                {
                    part.insert("tags".into(), tags.clone());
                }
            }
            languages.insert(lang.clone(), Value::Object(part));
        }
    }
    json!({
        "type": "designs",
        "action": "add",
        "id": record.get("id"),
        "group": record.get("group"),
        "subject": record.get("subject"),
        "languages": languages,
    })
}

/// A template's sample in one language, as the library's `templates: translate` takes it.
pub fn sample_upload(template_id: &str, lang: &str, sample: Value) -> Value {
    json!({
        "type": "templates",
        "action": "translate",
        "id": template_id,
        "languages": {lang: {"sample": sample}},
    })
}

/// A form of the upload as JSON (`upload`) and its files, each by its name; and its type.
pub fn multipart(upload: &Value, files: &[(&str, &[u8], &str)]) -> (Vec<u8>, String) {
    let boundary = format!("slidr-studio-{}", uuid::Uuid::new_v4().simple());
    let mut body = Vec::new();
    let mut part = |name: &str, data: &[u8], content_type: &str, filename: Option<String>| {
        let disposition = match filename {
            Some(filename) => format!("form-data; name=\"{name}\"; filename=\"{filename}\""),
            None => format!("form-data; name=\"{name}\""),
        };
        body.extend_from_slice(
            format!("--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {content_type}\r\n\r\n")
                .as_bytes(),
        );
        body.extend_from_slice(data);
        body.extend_from_slice(b"\r\n");
    };
    part(
        "upload",
        upload.to_string().as_bytes(),
        "application/json",
        None,
    );
    for (name, data, content_type) in files {
        let filename = if *content_type == "image/webp" {
            format!("{name}.webp")
        } else {
            (*name).to_owned()
        };
        part(name, data, content_type, Some(filename));
    }
    body.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (body, format!("multipart/form-data; boundary={boundary}"))
}

/// What the library's answer means: the upload as it keeps it, or why it did not take it.
pub fn answer(status: u16, body: Option<Value>) -> Result<Value, UploadError> {
    if status == 201 && body.as_ref().is_some_and(Value::is_object) {
        return Ok(body.unwrap_or_default());
    }
    let body = body.filter(Value::is_object).unwrap_or_default();
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map_or_else(|| format!("The library answered {status}."), str::to_owned);
    let issues = body
        .get("issues")
        .and_then(Value::as_array)
        .map(|issues| {
            issues
                .iter()
                .filter(|issue| issue.is_object())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    Err(UploadError { message, issues })
}

/// The library's upload API at an address, with the studio's key.
pub struct LibraryApi {
    url: String,
    key: Option<String>,
}

impl LibraryApi {
    pub fn new(url: &str, key: Option<String>) -> Self {
        Self {
            url: url.trim_end_matches('/').to_owned(),
            key,
        }
    }

    fn key(&self) -> Result<&str, UploadError> {
        self.key.as_deref().filter(|key| !key.is_empty()).ok_or_else(|| {
            UploadError::new(
                "The studio has no key to the library: set SLIDR_LIBRARY_KEY, or give it in the \
                 Publish panel.",
            )
        })
    }

    /// Sends an upload; the upload as the library keeps it, or `UploadError` with what is wrong.
    pub async fn send(
        &self,
        upload: &Value,
        files: &[(&str, &[u8], &str)],
    ) -> Result<Value, UploadError> {
        let key = self.key()?;
        let (body, content_type) = multipart(upload, files);
        let sent = net::client()
            .post(format!("{}/api/uploads", self.url))
            .bearer_auth(key)
            .header("Accept", "application/json")
            .header("Content-Type", content_type)
            .timeout(TIMEOUT)
            .body(body)
            .send()
            .await
            .map_err(|e| UploadError::new(format!("{} could not be reached: {e}", self.url)))?;
        let status = sent.status().as_u16();
        let text = sent.bytes().await.unwrap_or_default();
        answer(status, serde_json::from_slice(&text).ok())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_design_is_uploaded_with_its_slides_names_and_tags() {
        let record = json!({
            "id": "m-x",
            "name": {"he": "שם", "en": "Name"},
            "group": "g",
            "groupName": {"he": "ק", "en": "G"},
            "slides": {"he": {"id": "a"}, "en": {"id": "b"}, "ar": {"id": "c"}},
            "subject": [5, 6],
            "size": [64, 36],
            "tags": {"he": ["הזמנה", "מסיבה", "אירוע"], "en": ["invitation", "party", "event"]},
        });
        let upload = design_upload(&record);
        for (key, value) in [
            ("type", json!("designs")),
            ("action", json!("add")),
            ("id", json!("m-x")),
            ("group", json!("g")),
            ("subject", json!([5, 6])),
        ] {
            assert_eq!(upload[key], value, "{key}");
        }
        assert_eq!(
            upload["languages"]["he"],
            json!({"slide": {"id": "a"}, "name": "שם", "groupName": "ק", "tags": ["הזמנה", "מסיבה", "אירוע"]})
        );
        assert_eq!(
            upload["languages"]["en"]["tags"],
            json!(["invitation", "party", "event"])
        );
        // Another language carries its slide alone: names and tags are Hebrew and English.
        assert_eq!(upload["languages"]["ar"], json!({"slide": {"id": "c"}}));
        let mut untagged = record.clone();
        untagged["tags"] = Value::Null;
        assert!(
            design_upload(&untagged)["languages"]["he"]
                .get("tags")
                .is_none()
        );
        let sample = sample_upload("mifgash", "fr", json!([{"layout": "l"}]));
        assert_eq!(
            sample,
            json!({"type": "templates", "action": "translate", "id": "mifgash", "languages": {"fr": {"sample": [{"layout": "l"}]}}})
        );
    }

    #[test]
    fn an_upload_goes_as_a_form_of_its_json_and_its_files() {
        let picture: &[u8] = b"RIFF0000WEBP";
        let (body, content_type) = multipart(
            &json!({"id": "m-x", "name": "שם"}),
            &[("picture", picture, "image/webp")],
        );
        assert!(content_type.starts_with("multipart/form-data; boundary="));
        let boundary = content_type.split("boundary=").nth(1).expect("a boundary");
        let text = String::from_utf8_lossy(&body);
        assert!(
            text.contains("name=\"upload\"") && text.contains("{\"id\":\"m-x\",\"name\":\"שם\"}")
        );
        assert!(text.contains("name=\"picture\"; filename=\"picture.webp\""));
        assert!(text.contains("Content-Type: image/webp"));
        assert!(text.trim_end().ends_with(&format!("--{boundary}--")));
    }

    #[test]
    fn the_library_says_why_it_did_not_take_an_upload() {
        let refused = answer(
            422,
            Some(
                json!({"error": "invalid", "message": "The upload does not hold.",
                        "issues": [{"path": "languages.he.tags", "message": "The search tags…"}]}),
            ),
        )
        .expect_err("refused");
        assert_eq!(refused.message, "The upload does not hold.");
        assert_eq!(refused.issues[0]["path"], "languages.he.tags");
        let taken = answer(201, Some(json!({"id": "u-1", "status": "pending"}))).expect("taken");
        assert_eq!(taken["id"], "u-1");
        assert_eq!(
            answer(500, None).expect_err("refused").message,
            "The library answered 500."
        );
        let keyless = LibraryApi::new("https://library.example/", None);
        assert!(keyless.key().is_err_and(|e| e.message.contains("no key")));
    }
}
