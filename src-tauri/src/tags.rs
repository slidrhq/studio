//! Search tags in every content language, held to the rules the library holds them to (its
//! `server/core/uploads/tags.ts`, ADR-108 of the app): 3 to 20 tags a language, each of one to four
//! words in up to 40 characters, in the language's own letters (or of numbers alone), Hebrew
//! without niqqud, English in lower case, none twice, and none that says how the item is drawn.
//!
//! An agent's tags are cleaned rather than refused: a tag that does not hold is left out, and a
//! language left with too few has none.

use serde_json::Value;

use crate::{languages::CONTENT_LANGUAGES, prompts::items, store::Tags};

pub const FEWEST: usize = 3;
pub const MOST: usize = 20;
const CHARACTERS: usize = 40;
const WORDS: usize = 4;

/// Words about the drawing rather than what it shows (the library's `MEDIUM`).
const MEDIUM: [&str; 24] = [
    "icon",
    "icons",
    "illustration",
    "drawing",
    "sticker",
    "emoji",
    "clipart",
    "clip art",
    "graphic",
    "outline",
    "flat",
    "3d",
    "אייקון",
    "אייקונים",
    "איור",
    "ציור",
    "סטיקר",
    "מדבקה",
    "אימוגי",
    "אמוגי",
    "קליפארט",
    "גרפיקה",
    "קו מתאר",
    "קווי מתאר",
];

fn within(c: char, ranges: &[(u32, u32)]) -> bool {
    let c = c as u32;
    ranges.iter().any(|(from, to)| (*from..=*to).contains(&c))
}

fn hebrew(c: char) -> bool {
    within(c, &[(0x05D0, 0x05EA), (0x05EF, 0x05F2), (0xFB1D, 0xFB4F)])
}

fn niqqud(c: char) -> bool {
    within(c, &[(0x0591, 0x05C7)])
}

fn latin(c: char) -> bool {
    c.is_ascii_alphabetic()
        || within(
            c,
            &[
                (0x00C0, 0x00D6),
                (0x00D8, 0x00F6),
                (0x00F8, 0x024F),
                (0x1E00, 0x1EFF),
            ],
        )
}

fn han(c: char) -> bool {
    within(c, &[(0x3400, 0x4DBF), (0x4E00, 0x9FFF), (0xF900, 0xFAFF)])
}

/// Whether a character is a letter of the language's script (the library's `LETTERS`).
fn of_script(lang: &str, c: char) -> bool {
    match lang {
        "he" => hebrew(c),
        "ar" => within(
            c,
            &[
                (0x0600, 0x06FF),
                (0x0750, 0x077F),
                (0x08A0, 0x08FF),
                (0xFB50, 0xFDFF),
                (0xFE70, 0xFEFF),
            ],
        ),
        "ru" => within(c, &[(0x0400, 0x052F)]),
        "hi" => within(c, &[(0x0900, 0x097F)]),
        "ja" => han(c) || within(c, &[(0x3040, 0x30FF), (0x31F0, 0x31FF)]),
        "ko" => within(c, &[(0xAC00, 0xD7AF), (0x1100, 0x11FF), (0x3130, 0x318F)]),
        "zh-CN" => han(c),
        _ => latin(c),
    }
}

/// One tag as the library keeps it, or none when it does not hold.
pub fn clean_tag(lang: &str, tag: &str) -> Option<String> {
    let mut text = tag.split_whitespace().collect::<Vec<_>>().join(" ");
    if lang == "he" {
        text = text.chars().filter(|c| !niqqud(*c)).collect();
    } else if lang == "en" {
        text = text.to_lowercase();
    }
    let words = text.split(' ').count();
    if text.is_empty() || text.chars().count() > CHARACTERS || words > WORDS {
        return None;
    }
    let numbers =
        text.chars().any(|c| c.is_ascii_digit()) && !text.chars().any(char::is_alphabetic);
    let own = text.chars().any(|c| of_script(lang, c));
    if !numbers && (!own || (lang != "he" && text.chars().any(hebrew))) {
        return None;
    }
    let bare: String = text
        .chars()
        .filter(|c| !"'\"׳״`’".contains(*c))
        .collect::<String>()
        .to_lowercase();
    (!MEDIUM.contains(&bare.as_str())).then_some(text)
}

/// The tags of one language, cleaned: each once, at most 20; none when fewer than 3 hold.
pub fn clean_list(lang: &str, value: Option<&Value>) -> Vec<String> {
    let mut kept: Vec<String> = Vec::new();
    for tag in items(value) {
        if let Some(tag) = tag.as_str().and_then(|tag| clean_tag(lang, tag))
            && !kept.contains(&tag)
        {
            kept.push(tag);
        }
    }
    if kept.len() < FEWEST {
        return Vec::new();
    }
    kept.truncate(MOST);
    kept
}

/// The tags of every content language an agent gave (`{"he": […], "fr": […]}`), cleaned; a
/// language with too few that hold is left out.
pub fn clean_tags(value: Option<&Value>) -> Tags {
    let mut tags = Tags::default();
    let Some(value) = value.and_then(Value::as_object) else {
        return tags;
    };
    for lang in CONTENT_LANGUAGES {
        let kept = clean_list(lang, value.get(lang));
        if !kept.is_empty() {
            tags.set(lang, kept);
        }
    }
    tags
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn tags_are_kept_clean_and_in_their_own_letters() {
        let tags = clean_tags(Some(&json!({
            "he": ["יוֹם הולדת", "יום הולדת", "birthday", "מסיבה", " עוגה ", 7, "איור"],
            "en": ["Birthday", "kids  party", "מסיבה", "cake", "x".repeat(41), "Icon", "16:9"],
            "ja": ["誕生日", "パーティー", "birthday", "ケーキ"],
            "ru": ["день рождения", "праздник", "торт"],
            "ar": ["عيد ميلاد", "حفلة"],
            "xx": ["a", "b", "c"],
        })));
        assert_eq!(tags.get("he"), ["יום הולדת", "מסיבה", "עוגה"]);
        assert_eq!(tags.get("en"), ["birthday", "kids party", "cake", "16:9"]);
        assert_eq!(tags.get("ja"), ["誕生日", "パーティー", "ケーキ"]);
        assert_eq!(tags.get("ru").len(), 3);
        // Two that hold are too few; an unknown language is no language.
        assert!(!tags.has("ar"));
        assert_eq!(tags.0.len(), 4);
        assert_eq!(clean_tags(None), Tags::default());
        assert_eq!(clean_tags(Some(&json!({"he": "יום"}))), Tags::default());
    }

    #[test]
    fn a_tag_is_one_to_four_words_and_says_what_it_is() {
        assert_eq!(clean_tag("de", "Geburtstag"), Some("Geburtstag".into()));
        assert_eq!(clean_tag("de", "ein sehr langer Tag hier"), None);
        assert_eq!(clean_tag("fr", "anniversaire"), Some("anniversaire".into()));
        assert_eq!(clean_tag("vi", "sinh nhật"), Some("sinh nhật".into()));
        assert_eq!(clean_tag("ko", "생일"), Some("생일".into()));
        assert_eq!(clean_tag("ko", "birthday"), None);
        assert_eq!(clean_tag("hi", "जन्मदिन"), Some("जन्मदिन".into()));
        assert_eq!(clean_tag("es", "sticker"), None);
        assert_eq!(clean_tag("es", "fiesta עם"), None);
    }
}
