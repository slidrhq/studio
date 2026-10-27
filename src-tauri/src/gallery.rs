//! The pictures of the published designs that the galleries show (ADR-109, ADR-111 and ADR-116 of
//! the app), drawn where the library lacks them, and sent to it as `designs: draw`.
//!
//! The library names each picture by the word of the slide it was drawn of
//! (`elements/designs/revs.json`, in `images/designs/thumbs/index.json`), and an app shows a picture
//! only while its design has that word. A design the studio publishes from now on comes with its
//! pictures (`<lang>-gallery` of its render); these are the others: designs published before, the
//! app's own among them, and slides changed since they were drawn.
//!
//! ```text
//! revs.json, thumbs/index.json   ──►  each slide whose word has no picture (`missing`)
//! render.html, kind "gallery"    ──►  the slide as published, 320×180, a window per batch
//! designs: draw, a design each   ──►  the library takes each picture while its slide is the one drawn
//! ```

use std::{collections::BTreeMap, fs, path::Path};

use serde::Serialize;
use serde_json::{Value, json};

use crate::{
    languages::CONTENT_LANGUAGES,
    library::{GALLERY, GALLERY_QUALITY, Library, webp_at},
    prompts::items,
    render::Renders,
};

pub const MANIFEST: &str = "manifest.json";
pub const REVS: &str = "elements/designs/revs.json";
pub const THUMBS: &str = "images/designs/thumbs/index.json";
/// How many slides a render window draws.
const BATCH: usize = 48;

/// A slide of a published design that the library has no picture of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Missing {
    pub id: String,
    pub lang: String,
    /// The word of the slide, as `revs.json` gives it.
    pub word: String,
    /// The catalog that has it: `index.json`, the app's own designs, or `managed.json`.
    pub catalog: String,
}

/// The catalog a design is in, when `revs.json` does not say: the designs made outside the app are
/// named `m-…`.
fn catalog_by_name(id: &str) -> &'static str {
    if id.starts_with("m-") {
        "managed.json"
    } else {
        "index.json"
    }
}

/// The slides of the published designs that have no picture of them as they are, by design and in
/// the order of the languages. `revs.json` must be of the library as the manifest lists it: the
/// words of another are not those an app makes.
pub fn missing(
    manifest: &Value,
    revs: Option<&Value>,
    thumbs: Option<&Value>,
) -> Result<Vec<Missing>, String> {
    let files = manifest
        .get("files")
        .and_then(Value::as_object)
        .ok_or("The library's manifest lists no files.")?;
    let (Some(from), Some(designs)) = (
        revs.and_then(|revs| revs.get("from"))
            .and_then(Value::as_object),
        revs.and_then(|revs| revs.get("designs"))
            .and_then(Value::as_object),
    ) else {
        return Err(format!("The library has no words of its designs ({REVS})."));
    };
    if from
        .iter()
        .any(|(path, hash)| files.get(path).and_then(|file| file.get("sha256")) != Some(hash))
    {
        return Err(format!(
            "The words of the designs ({REVS}) are of the library before it changed: publish it \
             once (Try again in Slidr Library), then draw."
        ));
    }
    let mut catalog_of: BTreeMap<&str, &str> = BTreeMap::new();
    if let Some(catalogs) = revs
        .and_then(|revs| revs.get("catalogs"))
        .and_then(Value::as_object)
    {
        for (path, ids) in catalogs {
            let name = path.rsplit('/').next().unwrap_or(path);
            for id in items(Some(ids)).iter().filter_map(Value::as_str) {
                catalog_of.entry(id).or_insert(name);
            }
        }
    }
    let mut found = Vec::new();
    for lang in CONTENT_LANGUAGES {
        let Some(words) = designs.get(lang).and_then(Value::as_object) else {
            continue;
        };
        let drawn = thumbs
            .and_then(|thumbs| thumbs.get("designs"))
            .and_then(|designs| designs.get(lang));
        for (id, word) in words {
            let Some(word) = word.as_str() else {
                continue;
            };
            if drawn
                .and_then(|drawn| drawn.get(id))
                .and_then(Value::as_str)
                == Some(word)
            {
                continue;
            }
            found.push(Missing {
                id: id.clone(),
                lang: lang.to_owned(),
                word: word.to_owned(),
                catalog: catalog_of
                    .get(id.as_str())
                    .copied()
                    .unwrap_or_else(|| catalog_by_name(id))
                    .to_owned(),
            });
        }
    }
    let order = |lang: &str| CONTENT_LANGUAGES.iter().position(|one| *one == lang);
    found.sort_by(|a, b| (&a.id, order(&a.lang)).cmp(&(&b.id, order(&b.lang))));
    Ok(found)
}

/// A slide drawn, as its upload takes it: its language, its word and its picture as WebP.
pub type Drawn = (String, String, Vec<u8>);

/// Draws the slides the library has no picture of, and sends each design's pictures to it as
/// `designs: draw`. `work` holds the renders of this drawing. The answer says how many were
/// missing, each upload, and each slide that could not be drawn.
pub async fn draw(library: &Library, renders: &Renders, work: &Path) -> Result<Value, String> {
    let missing = library.gallery_missing().await?;
    let _ = fs::remove_dir_all(work);
    let mut drawn: BTreeMap<String, Vec<Drawn>> = BTreeMap::new();
    let mut failed = Vec::new();
    for (number, batch) in missing.chunks(BATCH).enumerate() {
        let out = work.join(format!("b{number}"));
        let input = json!({
            "kind": "gallery",
            "items": batch
                .iter()
                .enumerate()
                .map(|(at, slide)| json!({
                    "name": format!("g{at}"),
                    "id": slide.id,
                    "lang": slide.lang,
                    "catalog": slide.catalog,
                }))
                .collect::<Vec<_>>(),
        });
        let title = format!("gallery {}", number + 1);
        let result = match renders.draw_input(input, &title, &out).await {
            Ok(result) => result,
            Err(error) => {
                failed.extend(batch.iter().map(|slide| failure(slide, &error)));
                continue;
            }
        };
        for (at, slide) in batch.iter().enumerate() {
            let name = format!("g{at}");
            let said = items(result.get("failed"))
                .iter()
                .find(|one| one.get("name").and_then(Value::as_str) == Some(name.as_str()))
                .and_then(|one| one.get("error").and_then(Value::as_str));
            if let Some(error) = said {
                failed.push(failure(slide, error));
                continue;
            }
            match webp_at(&out.join(format!("{name}.png")), GALLERY_QUALITY) {
                Ok((webp, size)) if size == GALLERY => drawn
                    .entry(slide.id.clone())
                    .or_default()
                    .push((slide.lang.clone(), slide.word.clone(), webp)),
                Ok((_, (width, height))) => failed.push(failure(
                    slide,
                    &format!(
                        "It was drawn at {width} × {height}, not {} × {}.",
                        GALLERY.0, GALLERY.1
                    ),
                )),
                Err(error) => failed.push(failure(slide, &error)),
            }
        }
    }
    let uploads = library.send_drawings(drawn).await;
    Ok(json!({"missing": missing.len(), "uploads": uploads, "failed": failed}))
}

fn failure(slide: &Missing, error: &str) -> Value {
    json!({"id": slide.id, "lang": slide.lang, "error": error})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(files: &[(&str, &str)]) -> Value {
        let files: serde_json::Map<String, Value> = files
            .iter()
            .map(|(path, hash)| ((*path).to_owned(), json!({"size": 1, "sha256": hash})))
            .collect();
        json!({"version": 1, "files": files})
    }

    #[test]
    fn the_slides_without_a_picture_of_them_as_they_are_are_missing() {
        let manifest = manifest(&[
            ("elements/designs/managed.json", "m1"),
            ("elements/designs/index.json", "i1"),
        ]);
        let revs = json!({
            "from": {"elements/designs/managed.json": "m1", "elements/designs/index.json": "i1"},
            "designs": {
                "en": {"m-party": "e1", "cover": "c1"},
                "he": {"m-party": "h2", "cover": "c2"},
                "zh-CN": {"m-party": "z1"},
            },
            "catalogs": {"elements/designs/index.json": ["cover"], "elements/designs/managed.json": ["m-party"]},
        });
        // Hebrew of m-party was drawn of a slide changed since; English of cover is as drawn.
        let thumbs = json!({"widths": [320], "designs": {"he": {"m-party": "h1", "cover": "c2"}, "en": {"cover": "c1"}}});
        let found = missing(&manifest, Some(&revs), Some(&thumbs)).expect("the missing");
        let listed: Vec<(&str, &str, &str, &str)> = found
            .iter()
            .map(|one| {
                (
                    one.id.as_str(),
                    one.lang.as_str(),
                    one.word.as_str(),
                    one.catalog.as_str(),
                )
            })
            .collect();
        assert_eq!(
            listed,
            [
                ("m-party", "he", "h2", "managed.json"),
                ("m-party", "en", "e1", "managed.json"),
                ("m-party", "zh-CN", "z1", "managed.json"),
            ]
        );
        // Without any picture, every slide is missing; without `catalogs`, by its name.
        let mut old = revs.clone();
        old.as_object_mut().expect("an object").remove("catalogs");
        let all = missing(&manifest, Some(&old), None).expect("the missing");
        assert_eq!(all.len(), 5);
        assert!(
            all.iter()
                .any(|one| one.id == "cover" && one.catalog == "index.json")
        );
    }

    #[test]
    fn words_of_another_library_draw_nothing() {
        let manifest = manifest(&[("elements/designs/managed.json", "m2")]);
        let revs = json!({"from": {"elements/designs/managed.json": "m1"}, "designs": {}});
        assert!(
            missing(&manifest, Some(&revs), None).is_err_and(|error| error.contains("Try again"))
        );
        assert!(missing(&manifest, None, None).is_err_and(|error| error.contains(REVS)));
    }
}
