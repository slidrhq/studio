# Slidr Studio

A desktop app for Windows that makes content for the media library from a request, and sends the approved work to the library through its upload API (docs/media-library.md, [Publishing](#publishing)): ready-made designs for Elements → Designs, and the sample decks of the built-in templates in any content language (a translation, or a rewrite). It is built as the app is built: a Tauri shell whose Rust side (`src-tauri/`) keeps the requests, runs Claude Code and Codex on this machine, renders in windows of its own that are never shown, and sends the work to the library; and pages in React (`web/`) that use the app's own packages: the HTML conversion engine, the template engine, the renderer and the design check. It is signed and released as the app is ([Releasing](#releasing)), and updates itself.

The studio makes and publishes. To see what the library holds, as every installed app reads it, use [Slidr Library](https://github.com/slidrhq/library), which the "Library" tab of the studio opens in the browser.

## Setup

Install the studio from its [releases](https://github.com/slidrhq/studio/releases) (`Slidr-Studio_<version>_x64-setup.exe`). It needs no Python, Node or browser of its own: it renders in WebView2, which Windows has. It needs both CLIs, signed in:

- **Claude Code** (`claude`), on your Claude login. It plans the concepts and writes, reviews and fixes the designs.
- **Codex CLI** (`codex login`), on your ChatGPT login. It makes the pictures. The studio finds `codex` on the PATH, behind npm's shim, or inside VS Code's ChatGPT extension. `CODEX_PATH` names it outright.

The status chips at the top of the studio say which of them it found and whether they are signed in. The installed studio keeps its work in `%LOCALAPPDATA%\slidr.studio\requests` ([Settings](#settings)).

The studio works with the app's own code: the packages it converts, renders and checks with, the app's instructions to its design agent and its quality bar (`AGENTS.md`). They are copied into `vendor/` from the app's repository, so this repository stands on its own; [vendor/README.md](vendor/README.md) says what is there and how to take a newer version. The binary carries the instructions and the quality bar: `src-tauri/instructions.json`, which `pnpm vendor` writes from the copy, and `vendor/AGENTS.md`. The studio keeps no copy of the media library: it reads the library where it is published (`SLIDR_MEDIA_URL`), and writes to it only through Slidr Library's API (`SLIDR_LIBRARY_URL`).

Paths in this README such as `packages/…`, `desktop/…`, `AGENTS.md` and `docs/…` are of the app's repository, copied in `vendor/` where the studio uses them.

## Kinds of request

Each request is a tab, and requests run side by side. A tab keeps working while another is open, and survives a restart of the studio. A request is one of:

- **A design**: ready-made slides for the gallery, below.
- **A template's sample**: the sample deck of a built-in template, written in languages. See [Template samples](#template-samples).
- **Read automatically** (the default): a request in words, such as "translate the Mifgash template into every language it does not support yet". One structured Claude call (`template_prompts.route_*`) reads it with the list of templates (their names in Hebrew and English from the app's messages, and the languages each sample is and is not written in) and makes it one of the two: here the template `mifgash` in its fourteen missing languages. A request for anything the studio does not make yet (a new template, its layouts or colours, card sets, frames, shapes, graphics, icons, fonts) stops with the reason, in the request's language, and what the studio can do instead.

## What happens to a design request

A design request also names its languages. Hebrew and English are always made, and by default they are the only ones. Tick any other content language of the app (`CONTENT_LANGUAGES` in `packages/model/src/languages.ts`: Arabic, German, Japanese…) and every concept of that request is planned, written, rendered, reviewed and published in it too. "More concepts" keeps the request's languages. A request made before there was a choice is Hebrew and English.

1. **Plan.** Claude plans the number of concepts asked for (1 to 6), each distinct in layout, type, palette and picture. Each concept has its own art direction, copy in each language of the request, written for its own readers, and a prompt for its picture. The gallery's names stay in Hebrew and English, and so do the search tags Claude gives each concept: the words people type to find it in the app's Ready slides (what it is for, the occasion, the field, the people it addresses; ADR-108 of the app). Claude may change them in `brief.json`, and the variant shows them.

   Each concept starts from its own composition idea, found in the occasion and its world; text on one side and the picture in a shape on the other is allowed for one concept of a plan at most (`composition` in `plan_prompt`, `src-tauri/src/prompts.rs`). Write a request the same way: name the occasions, the group and the real constraints (a culture to respect, an existing design not to resemble), not layouts, shapes or a list of text blocks. A request that dictates the layout gets the same skeleton in every concept; one that names only the occasions gets compositions as varied as the gallery's.

2. **Picture.** For each concept, Codex makes the picture, as the app's own Codex provider does (same command line, same rule at the head of the prompt). At most four pictures are made at a time. One picture serves every language.
3. **Design.** Claude looks at the picture, then writes the design as HTML, one file per language: `he.html`, `en.html`, and `ar.html`, `de.html`, `zh-CN.html`… for the others. The English file sets the composition, every left-to-right file keeps it, and every right-to-left file (Hebrew, Arabic) is its mirror; a language changes only what its text needs to fit. Each concept has its own Claude conversation, whose file tools reach only its own folder.
4. **Render.** A window of the studio that is never shown opens `render.html`, at 1920×1080 CSS px and one device pixel to each (`src-tauri/src/render`). That page converts every file with `@slidr/html-import`, the engine the app's agent uses, and its fidelity guard gets real pictures of the page from WebView2, as the app's capture window takes them. It then:
   - writes the theme's text styles out onto the runs, so the design keeps its type and colours in any deck;
   - runs the app's design check (`@slidr/lint`, the agent's rules);
   - checks the contract that `desktop/src/elements/designs.test.ts` holds every design to;
   - finds the point on the picture's subject, on top in every language;
   - draws the full-size slide and the gallery's 384 px thumbnail, in every language, and the studio takes a picture of each with WebView2's DevTools protocol (`Page.captureScreenshot`);
   - draws each slide at 320 × 180 too, as the app's galleries show it (`<lang>-gallery.png`): published with the design, it is the picture the galleries show of it, made ahead, and they draw it live only once it changes (ADR-109 and ADR-111 of the app).
5. **Review.** Claude reads the renders (two for each language) together with the findings and fixes the design. The number of rounds is set per request (default 2). A round in which Claude changes nothing ends the review. A design that still breaks the gallery's contract after the rounds gets one more turn to fix it, even when no rounds were asked for. Claude can also ask for a new picture, or a change to this one, through the concept's `brief.json`.
6. **You.** Open a variant to see it full size and as a thumbnail, in each of its languages, with its findings and a log of what Claude and Codex did. From there you can:
   - ask for a change in words (another turn of the same conversation, then a new render);
   - ask for a new picture, or a change to the current one;
   - approve the variant, or discard it.

   A design that breaks the gallery's contract cannot be approved. A design with errors from the design check can be, after a confirmation.

What Claude is told comes from the app's own text (copied in `vendor/`), never written again here: the design guidelines and HTML conventions of `packages/prompts` (`src-tauri/instructions.json`, which `web/tools/instructions.mjs` writes from them), the quality bar of `AGENTS.md`, and the fonts the library offers: the families of each of the request's languages (made for its letters, or for Latin ones and having its letters), and the counterpart in each language of every family the English and Hebrew files may use, the family of its letters closest to it in character, which that language's file sets the same text in (the catalog's `counterparts`, ADR-105). `src-tauri/src/prompts.rs` adds only what a gallery design needs on top: the contract and the studio's workflow, for the request's languages. Where no family of the library has a language's letters (only in a catalog older than ADR-105), its text names one family of the library for its Latin letters and figures, then `sans-serif` (`font-family: 'Inter', sans-serif`), and the system's font draws the rest, the same when the HTML is converted as when the app draws the slide. The studio's copy of the language list, `src-tauri/src/languages.rs`, is held to the model's by the unit tests.

## Template samples

A template request names a built-in template and the languages to write its sample in. The form offers the languages the sample lacks, and any it has: a language it has is rewritten as the instructions say. The template's layouts, colours and pictures do not change. Each language is a variant of its own, with its own Claude conversation, and they run side by side.

1. **Read.** The studio reads the template from the catalog of templates (the published `templates/catalog.json`) into the variant's folder: `template.json`, `template.md` (the theme, its fonts and text styles, and every box of every layout: its size, its style, how many lines it holds), and the English and Hebrew samples, `en.json` and `he.json`. A rewrite also gets the sample it has.
2. **Write.** Claude writes `<lang>.json` in the catalog's own format (`SampleSlide[]`, `packages/templates/src/builtin/kit.ts`): the same slides, layouts, roles and pictures as the English sample, the words written natively for the language's readers, figures and dates as they write them, and no year. The system prompt (`template_prompts.rs`) adds what the language needs: shorter wording where it runs longer, more leading where its letters are taller, phrase breaks where it can break anywhere, and which of its letters the template's families leave to the system's font (a run may name a family of the library that has them).
3. **Render.** The render page builds every slide on the template with `sampleSlides`, the engine the catalog and the app build a sample with, and draws them in one deck: each at 1920×1080 (`s01-full.png`…), each 384 px wide (`s01-thumb.png`…), and all of them on one sheet that reads in the language's direction (`sheet.png`). It runs the app's design check, every rule, as the acceptance of a template does, and builds the slide it was written from (English, or Hebrew for a right-to-left language) with the same seed: a finding that slide has on the same elements is not this language's doing, and is shown apart. It holds the sample to the English one: the same slides on the same layouts, as many fills under each role, the same pictures, text in the language's own letters, no English left (more than a quarter of the longer texts still in English is a contract issue) and no placeholder words.
4. **Review, you, publishing.** As for a design: review rounds, then the variant up close (each slide full size, the sheet, the findings slide by slide), a change in words, approval. A sample that breaks its contract cannot be approved. Approved, it goes to the library as `templates: translate`, and a publication writes it as `samples[<template>][<lang>]` into `templates/catalog.json`, in the registry's order of languages, changing nothing else of the file ([Publishing](#publishing)).

`desktop/scripts/export-templates.mjs` keeps a language the source file of a template does not write, so a template exported again keeps the translations the studio published.

## Publishing

The approved work goes to the library through [Slidr Library](https://github.com/slidrhq/library)'s upload API (its README, "Uploading"). The "Publish" panel sends each approved item as one upload (`src-tauri/src/uploads.rs`, the `library_upload` command):

- a design as `designs: add`: its picture (`images/designs/<id>.webp`), its slide in each language it was made in, its names, its group and the point of its picture's subject, and its search tags in Hebrew and English. The library refuses a design without tags; one made before the plan asked for them gets them by a change asked for in words. With it go the pictures of its slides that the galleries show, as its last render drew them (`thumb-<lang>`, WebP at quality 85); a render from before the studio drew them has none, and the galleries draw those slides live;
- a template's sample as `templates: translate`, in its language.

**Gallery pictures.** The panel also says how many slides of the published designs the library has no picture of as they are now, and draws them (`src-tauri/src/gallery.rs`, the `gallery_missing` and `gallery_draw` commands): the designs published before the studio drew them, the app's own among them, and slides changed since they were drawn. It reads which are missing from `elements/designs/revs.json` and `images/designs/thumbs/index.json`, and only while `revs.json` is of the library as its manifest lists it (else: publish once, **Try again** in Slidr Library). A hidden render window draws each slide as the library publishes it in its language (`elements/designs/<lang>/<catalog>`), as the app's gallery draws it (`web/src/gallery.tsx`), 48 to a window; each design's pictures go as one `designs: draw` upload, each with the word of the slide it was drawn of, which the library takes while the slide still has it (ADR-116 of the app).

The library checks each against what it publishes. The studio's token is of the `publish` scope, so the library publishes each upload at once (written into the files it changes in its bucket, where every app reads it the next time it reads the manifest), or keeps it and says why: publishing is the library's business, not the studio's. The panel shows each item's status in the library (published, waiting for approval, accepted and waiting to be published, rejected), with why it waits and a link to it on the library's page, or each thing the library found wrong; it reads the status of what was sent before when it opens (the `library_statuses` command). A variant keeps its upload, and one whose upload is published leaves the queue, marked published. Nothing is staged on this machine, and no Cloudflare token is needed.

The studio sends the library a person's token, all the library takes from a program (`Authorization: Bearer slk_…`): one of the `publish` scope, so that the library publishes its uploads at once, which an admin of the library makes in its profile. Give the token in the panel once: the studio keeps it in Windows' Credential Manager (under `slidr.studio`, as `library-token`), as the app keeps its keys, and takes away the program's key kept there before (`library-key`), which the library no longer takes. `SLIDR_LIBRARY_TOKEN` wins over it. `SLIDR_LIBRARY_URL` names the library (`https://library.slidr.workers.dev/`; an organization's own Slidr Library, installed on Linux in Docker, by its address, with a token made in its own profile; `http://127.0.0.1:5176/` for its dev server).

Designs from the studio go to their own catalog, `elements/designs/managed.json`, with ids that start with `m-`. They never collide with the hand-authored `index.json`. The app reads both files: names, groups and search tags come from `managed.json`, and an authored design wins on an id clash. A design's `slides` hold a slide for each language it was made in (`he` and `en`, and any other), while its names stay in Hebrew and English; a deck in a language a design was not made in gets the English slide.

## The library

The "Library" tab opens [Slidr Library](https://github.com/slidrhq/library) in the browser (`VITE_SLIDR_LIBRARY_URL` when the pages are built, `https://library.slidr.workers.dev/` by default), which shows the media library as it is published.

Slidr Library served from this machine (its dev server) reads which of the library's designs the studio made, and links each one to its request here. The studio answers it at `http://127.0.0.1:8765/` (`src-tauri/src/local_server.rs`): `/api/state` and `/api/status` to read, to any page of this machine, and `/#tab=<rid>&v=<vid>`, which brings the studio's window forward on that request and variant. When another program holds the port, the studio works without them.

The pages read the media library where the app's pages read it, at `media://` (`http://media.localhost/` on Windows): the studio answers from `SLIDR_MEDIA_URL` (`src-tauri/src/media.rs`). A variant's own files (its picture, its renders) are at `studio://` (`src-tauri/src/files.rs`).

## Settings

| Variable                                               | Default                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `SLIDR_STUDIO_DATA`                                    | `%LOCALAPPDATA%\slidr.studio` installed; the repository's `.data` in a build of it (`pnpm tauri dev`) |
| `SLIDR_MEDIA_URL`                                      | `https://media.slidr.studio/`                                                                         |
| `SLIDR_LIBRARY_URL`, `SLIDR_LIBRARY_TOKEN`             | `https://library.slidr.workers.dev/`, the token given in the Publish panel                            |
| `SLIDR_STUDIO_MAX_CLAUDE`, `_MAX_CODEX`, `_MAX_RENDER` | `4`, `4`, `2`                                                                                         |
| `SLIDR_STUDIO_PORT`, `SLIDR_STUDIO_HOST`               | `8765`, `127.0.0.1` (the answers for Slidr Library)                                                   |
| `SLIDR_STUDIO_SHOW_RENDER`                             | not set: render windows are hidden, and closed when done                                              |
| `CLAUDE_PATH`, `CODEX_PATH`                            | found on the PATH                                                                                     |

Variables are read when the studio starts. A second start of the studio brings the first one forward: two would work on the same requests.

Each request lives in `<data>/requests/<rid>/`. Each variant's working folder, `<vid>/work/`, holds the concept (`brief.json`), the picture (`subject.png`), an HTML file for each language, and `renders/r<n>/`, a folder for each revision with its renders (`<lang>-full.png`, `<lang>-thumb.png`) and `result.json`. A template variant's folder holds `brief.json`, `template.json`, `template.md`, `en.json`, `he.json` and its `<lang>.json`, and its renders are `s01-full.png`, `s01-thumb.png`… and `sheet.png`. The last three revisions are kept.

## Working on the studio

It takes Rust (stable, MSVC), Node and pnpm, as the app does.

```powershell
pnpm install
pnpm tauri dev                        # the studio; Vite serves its pages (127.0.0.1:5175) as they change,
                                      # and Rust is built again when src-tauri/ changes
$env:SLIDR_STUDIO_SHOW_RENDER = '1'   # render windows shown and left open, to see the render page
pnpm check                            # typecheck, eslint and prettier over the pages, and
                                      # src-tauri/instructions.json held to vendor/
pnpm check:rust                       # cargo fmt, clippy, and the unit tests
pnpm tauri build                      # the installer, signed where the project's certificate is
```

```text
src-tauri/src/
  lib.rs              the shell: the window, the commands, the protocols, the updater
  commands.rs         what the pages ask of it
  pipeline.rs         the work of a request and of each variant, as tasks that can be stopped
  store.rs            requests and variants as JSON files, each change sent to the window
  claude.rs, codex.rs one turn of Claude Code, one picture from the Codex CLI
  programs.rs         finding them; jobs.rs ends them with the studio
  render/             the hidden render windows and their pictures
  prompts.rs, template_prompts.rs, instructions.rs   what Claude is told
  templates.rs, library.rs, uploads.rs                the catalogs, the library and its upload API
  files.rs, media.rs, local_server.rs                 studio://, media://, the answers for Slidr Library
```

The unit tests hold the studio's copy of the language list to the app's (`vendor/packages/model`).

## Releasing

The studio is signed and released as the app is (`.github/workflows/release.yml`, `release.mjs`, `scripts/sign-windows.mjs`, each as the app's):

- **Authenticode**, with the project's certificate from Certum. `tauri build` signs the studio's exe, the uninstaller and the installer. The certificate's key opens only in SimplySign Desktop, so the release builds on the author's machine: a self-hosted runner with the label `slidr-signing`, registered for this repository (or for the organization).
- **The updater's signature**, with the studio's own key, whose public half is `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`: the repository's secrets `TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, when it has one). The installed studio reads `latest.json` of the newest published release, downloads a newer installer while it runs, and installs it when it closes.

To release: log in to SimplySign Desktop, start the runner as yourself, then `pnpm release` (`--bump` raises the version by 0.1.0 first; `--dry-run` says what it would do). The workflow builds and signs the installer and drafts the release with `latest.json`; publish the draft when it is ready.
