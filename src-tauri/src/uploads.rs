//! Uploads to Slidr Library ([slidrhq/library](https://github.com/slidrhq/library), README
//! "Uploading"): the studio sends its approved work to the library's REST API, which checks it
//! against the published library and keeps it until an editor accepts it. The studio's publication
//! then takes the accepted uploads into the library, by the library's API too (`POST /api/publish`):
//! the library lives in its Worker's bucket, and nothing of it is copied here.
//!
//! A design goes as `designs: add`, with its picture, its slide in each language it was made in, and
//! its names and search tags in Hebrew and English (ADR-108 of the app); a template's sample as
//! `templates: translate`, in its language. The studio signs in as a program, by its key
//! (`Authorization: Bearer`, the Worker's `LIBRARY_KEYS`).

use std::{future::Future, pin::Pin, sync::Arc, time::Duration};

use serde_json::{Map, Value, json};

use crate::{languages, net};

const TIMEOUT: Duration = Duration::from_secs(120);

/// The library did not take an upload, or a request: why, and each issue at its place.
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
/// `record` is what the library writes into `managed.json` (`library::design_record`): its id,
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
            format!(
                "--{boundary}\r\nContent-Disposition: {disposition}\r\nContent-Type: {content_type}\r\n\r\n"
            )
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

/// What the library said no to, in its words: its message, else its status and what was asked.
fn refused(status: u16, answer: Option<&Value>, doing: &str) -> UploadError {
    let answer = answer.filter(|answer| answer.is_object());
    let message = answer
        .and_then(|answer| answer.get("message"))
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map_or_else(
            || format!("The library answered {status} to {doing}."),
            str::to_owned,
        );
    let issues = answer
        .and_then(|answer| answer.get("issues"))
        .and_then(Value::as_array)
        .map(|issues| {
            issues
                .iter()
                .filter(|issue| issue.is_object())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    UploadError { message, issues }
}

/// One request to the library's API: the method, the path, and the body with its type.
pub struct Call {
    pub method: &'static str,
    pub path: String,
    pub body: Vec<u8>,
    pub content_type: Option<String>,
}

/// What a request to the library brings: the status and the bytes of the answer, or why the
/// library could not be reached.
pub type Fetched<'a> = Pin<Box<dyn Future<Output = Result<(u16, Vec<u8>), String>> + Send + 'a>>;

/// How a request reaches the library: over HTTPS, or a test's stand-in. The status and the bytes
/// of the answer, or why the library could not be reached.
pub trait Transport: Send + Sync {
    fn fetch<'a>(&'a self, url: &'a str, key: &'a str, call: Call) -> Fetched<'a>;
}

/// The library's API over HTTPS.
struct Https;

pub fn https() -> Arc<dyn Transport> {
    Arc::new(Https)
}

impl Transport for Https {
    fn fetch<'a>(&'a self, url: &'a str, key: &'a str, call: Call) -> Fetched<'a> {
        Box::pin(async move {
            let method =
                reqwest::Method::from_bytes(call.method.as_bytes()).map_err(|e| e.to_string())?;
            let mut request = net::client()
                .request(method, format!("{url}{}", call.path))
                .bearer_auth(key)
                .header("Accept", "application/json")
                .timeout(TIMEOUT);
            if let Some(content_type) = call.content_type {
                request = request.header("Content-Type", content_type).body(call.body);
            }
            let answer = request.send().await.map_err(|e| e.to_string())?;
            let status = answer.status().as_u16();
            let bytes = answer.bytes().await.unwrap_or_default();
            Ok((status, bytes.to_vec()))
        })
    }
}

/// The library's API at an address, with the studio's key.
pub struct LibraryApi {
    url: String,
    key: Option<String>,
    transport: Arc<dyn Transport>,
}

impl LibraryApi {
    pub fn with(url: &str, key: Option<String>, transport: Arc<dyn Transport>) -> Self {
        Self {
            url: url.trim_end_matches('/').to_owned(),
            key,
            transport,
        }
    }

    /// A request whose answer is JSON: the status, and the answer (None when it is not JSON).
    async fn call(&self, call: Call) -> Result<(u16, Option<Value>), UploadError> {
        let key = self.key.as_deref().filter(|key| !key.is_empty()).ok_or_else(|| {
            UploadError::new(
                "The studio has no key to the library: set SLIDR_LIBRARY_KEY, or give it in the \
                 Publish panel.",
            )
        })?;
        let (status, bytes) = self
            .transport
            .fetch(&self.url, key, call)
            .await
            .map_err(|e| UploadError::new(format!("{} could not be reached: {e}", self.url)))?;
        Ok((status, serde_json::from_slice(&bytes).ok()))
    }

    async fn get(&self, path: String) -> Result<(u16, Option<Value>), UploadError> {
        self.call(Call {
            method: "GET",
            path,
            body: Vec::new(),
            content_type: None,
        })
        .await
    }

    /// Sends an upload; the upload as the library keeps it, or `UploadError` with what is wrong.
    pub async fn send(
        &self,
        upload: &Value,
        files: &[(&str, &[u8], &str)],
    ) -> Result<Value, UploadError> {
        let (body, content_type) = multipart(upload, files);
        let (status, answer) = self
            .call(Call {
                method: "POST",
                path: "/api/uploads".into(),
                body,
                content_type: Some(content_type),
            })
            .await?;
        match answer {
            Some(answer) if status == 201 && answer.is_object() => Ok(answer),
            answer => Err(refused(status, answer.as_ref(), "the upload")),
        }
    }

    /// The uploads an editor accepted, which a publication takes: oldest first, so that of two
    /// that touch the same thing the later one is written last.
    pub async fn accepted(&self) -> Result<Vec<Value>, UploadError> {
        let mut found = Vec::new();
        let mut after: Option<String> = None;
        loop {
            let mut path = "/api/uploads?status=accepted&limit=200".to_owned();
            if let Some(after) = &after {
                path.push_str(&format!("&after={after}"));
            }
            let (status, answer) = self.get(path).await?;
            let page = match answer {
                Some(answer) if status == 200 && answer.is_object() => answer,
                answer => {
                    return Err(refused(
                        status,
                        answer.as_ref(),
                        "listing the accepted uploads",
                    ));
                }
            };
            if let Some(uploads) = page.get("uploads").and_then(Value::as_array) {
                found.extend(uploads.iter().filter(|upload| upload.is_object()).cloned());
            }
            after = page
                .get("next")
                .and_then(Value::as_str)
                .filter(|next| !next.is_empty())
                .map(str::to_owned);
            if after.is_none() {
                break;
            }
        }
        found.reverse();
        Ok(found)
    }

    /// Where the published library is, when it was published, and how many uploads wait
    /// (`GET /api/library`).
    pub async fn library(&self) -> Result<Value, UploadError> {
        match self.get("/api/library".into()).await? {
            (200, Some(answer)) if answer.is_object() => Ok(answer),
            (status, answer) => Err(refused(
                status,
                answer.as_ref(),
                "reading the library's state",
            )),
        }
    }

    /// Writes the accepted uploads (or those named) into the library (`POST /api/publish`): the
    /// uploads published and the files each wrote, those left accepted and why.
    pub async fn publish(&self, upload_ids: Option<&[String]>) -> Result<Value, UploadError> {
        let body = match upload_ids {
            Some(ids) if !ids.is_empty() => json!({"uploads": ids}),
            _ => json!({}),
        };
        let (status, answer) = self
            .call(Call {
                method: "POST",
                path: "/api/publish".into(),
                body: body.to_string().into_bytes(),
                content_type: Some("application/json".into()),
            })
            .await?;
        match answer {
            Some(answer) if status == 200 && answer.is_object() => Ok(answer),
            answer => Err(refused(status, answer.as_ref(), "the publication")),
        }
    }
}

#[cfg(test)]
pub mod tests {
    use std::{collections::HashMap, sync::Mutex};

    use super::*;

    /// A request as the stand-in heard it: the method, the path, the body and its type.
    pub type Sent = (String, String, Vec<u8>, Option<String>);

    /// The library's answers by method and path; any other request is refused as the library
    /// refuses one while it is not in its bucket.
    pub struct Pages {
        pub pages: Mutex<HashMap<(String, String), (u16, Value)>>,
        pub sent: Mutex<Vec<Sent>>,
    }

    impl Pages {
        pub fn new(pages: &[(&str, &str, u16, Value)]) -> Arc<Self> {
            Arc::new(Self {
                pages: Mutex::new(
                    pages
                        .iter()
                        .map(|(method, path, status, answer)| {
                            (
                                ((*method).to_owned(), (*path).to_owned()),
                                (*status, answer.clone()),
                            )
                        })
                        .collect(),
                ),
                sent: Mutex::new(Vec::new()),
            })
        }
    }

    impl Transport for Pages {
        fn fetch<'a>(&'a self, _url: &'a str, _key: &'a str, call: Call) -> Fetched<'a> {
            let key = (call.method.to_owned(), call.path.clone());
            self.sent.lock().expect("the log").push((
                call.method.to_owned(),
                call.path,
                call.body,
                call.content_type,
            ));
            let (status, answer) = self
                .pages
                .lock()
                .expect("the pages")
                .get(&key)
                .cloned()
                .unwrap_or((
                    409,
                    json!({"error": "not-live", "message": "The library is not in its bucket yet."}),
                ));
            Box::pin(async move { Ok((status, answer.to_string().into_bytes())) })
        }
    }

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

    #[tokio::test]
    async fn the_library_says_why_it_did_not_take_an_upload() {
        let pages = Pages::new(&[(
            "POST",
            "/api/uploads",
            422,
            json!({"error": "invalid", "message": "The upload does not hold.",
                   "issues": [{"path": "languages.he.tags", "message": "The search tags…"}]}),
        )]);
        let api = LibraryApi::with(
            "https://library.example/",
            Some("a-key".into()),
            pages.clone(),
        );
        let refused = api
            .send(&json!({"type": "designs"}), &[])
            .await
            .expect_err("refused");
        assert_eq!(refused.message, "The upload does not hold.");
        assert_eq!(refused.issues[0]["path"], "languages.he.tags");
        let sent = pages.sent.lock().expect("the log")[0].clone();
        assert_eq!((sent.0.as_str(), sent.1.as_str()), ("POST", "/api/uploads"));
        assert!(sent.3.is_some_and(|t| t.starts_with("multipart/form-data")));
        pages.pages.lock().expect("the pages").insert(
            ("POST".into(), "/api/uploads".into()),
            (201, json!({"id": "u-1", "status": "pending"})),
        );
        let taken = api
            .send(&json!({"type": "designs"}), &[])
            .await
            .expect("taken");
        assert_eq!(taken["id"], "u-1");
        let keyless = LibraryApi::with("https://library.example/", None, pages);
        let refused = keyless.library().await.expect_err("no key");
        assert!(refused.message.contains("no key"));
    }

    #[tokio::test]
    async fn the_library_is_asked_for_its_state_its_accepted_uploads_and_a_publication() {
        let pages = Pages::new(&[
            (
                "GET",
                "/api/library",
                200,
                json!({"live": true, "published": "2026-10-21T00:00:00.000Z", "accepted": 3}),
            ),
            (
                "GET",
                "/api/uploads?status=accepted&limit=200",
                200,
                json!({"uploads": [{"id": "u-new"}, {"id": "u-mid"}], "next": "u-mid"}),
            ),
            (
                "GET",
                "/api/uploads?status=accepted&limit=200&after=u-mid",
                200,
                json!({"uploads": [{"id": "u-old"}]}),
            ),
            (
                "POST",
                "/api/publish",
                200,
                json!({"published": "2026-10-21T00:00:01.000Z", "uploads": [{"id": "u-old"}], "skipped": []}),
            ),
        ]);
        let api = LibraryApi::with(
            "https://library.example/",
            Some("a-key".into()),
            pages.clone(),
        );
        assert_eq!(api.library().await.expect("the state")["accepted"], 3);
        // Oldest first, across the pages of the listing.
        let ids: Vec<Value> = api
            .accepted()
            .await
            .expect("the uploads")
            .iter()
            .map(|upload| upload["id"].clone())
            .collect();
        assert_eq!(ids, [json!("u-old"), json!("u-mid"), json!("u-new")]);
        let done = api
            .publish(Some(&["u-old".to_owned()]))
            .await
            .expect("published");
        assert_eq!(done["uploads"], json!([{"id": "u-old"}]));
        let last = pages
            .sent
            .lock()
            .expect("the log")
            .last()
            .cloned()
            .expect("sent");
        assert_eq!(
            (
                last.0.as_str(),
                last.1.as_str(),
                last.2.as_slice(),
                last.3.as_deref()
            ),
            (
                "POST",
                "/api/publish",
                b"{\"uploads\":[\"u-old\"]}".as_slice(),
                Some("application/json")
            )
        );
        api.publish(None).await.expect("published");
        let last = pages
            .sent
            .lock()
            .expect("the log")
            .last()
            .cloned()
            .expect("sent");
        assert_eq!(last.2, b"{}");
        // What the library refuses is said in its words.
        pages
            .pages
            .lock()
            .expect("the pages")
            .remove(&("POST".into(), "/api/publish".into()));
        let refused = api.publish(None).await.expect_err("refused");
        assert!(refused.message.contains("not in its bucket"));
    }
}
