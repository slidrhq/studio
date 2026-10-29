# Slidr Studio

A desktop app for Windows that makes content for the media library in a chat, as a whole package in the app's sixteen languages, and publishes each piece to the library through its upload API the moment it is approved (docs/media-library.md, [Publishing](#publishing)): ready-made designs for Elements → Designs, and the sample decks of the built-in templates in any content language (a translation, or a rewrite). It looks as the app looks, and is built as the app is built: a Tauri shell whose Rust side (`src-tauri/`) keeps the chats and their work, runs the agents on this machine (Claude Code and the Codex CLI), renders in windows of its own that are never shown, and sends the work to the library; and pages in React (`web/`) that use the app's own packages: its design system (`@slidr/ui`), the HTML conversion engine, the template engine, the renderer and the design check. It is signed and released as the app is ([Releasing](#releasing)), and updates itself.

The studio makes and publishes. To see what the library holds, as every installed app reads it, use [Slidr Library](https://github.com/slidrhq/library), which the title bar of the studio opens in the browser.

## Setup

Install the studio from its [releases](https://github.com/slidrhq/studio/releases) (`Slidr-Studio_<version>_x64-setup.exe`). It needs no Python, Node or browser of its own: it renders in WebView2, which Windows has. It works with two CLIs, signed in:

- **Claude Code** (`claude`), on your Claude login.
- **Codex CLI** (`codex login`), on your ChatGPT login. The studio finds `codex` on the PATH, behind npm's shim, or inside VS Code's ChatGPT extension. `CODEX_PATH` names it outright.

Three agents do the work, each a role of its own whose program, model and effort are chosen in **Settings → Agents** (`src-tauri/src/agents.rs`):

- **Design**: the English design of each concept, the master the other languages are written from: the plan of the concepts, the HTML, its review, its names and its search tags in English. Claude Code by default, or Codex.
- **Images**: the picture of each design, by Codex's image tool, as the app makes them.
- **Translation**: every other language of an approved master, with the design's names and search tags in each, and the sample decks of the templates. Claude Code by default, or Codex.

A chat may choose its own agent for any role, from the pickers under its message box; the choice holds in that chat, and the settings' everywhere else. Codex works as an agent in its folder as Claude Code does: `codex exec` with the Windows sandbox, which keeps its writes to the folder; it reads its files with its shell, Windows PowerShell, since the Store's `pwsh` cannot start in the sandbox and its folder is left off the PATH Codex is given (`codex::run_agent`). A conversation belongs to its program: a role moved to the other program starts a new one, told where the work stands.

The status chips in the title bar say which programs the studio found and whether they are signed in. The installed studio keeps its work in `%LOCALAPPDATA%\slidr.studio` ([Settings](#settings)).

The studio works with the app's own code: the packages it converts, renders and checks with, the app's instructions to its design agent and its quality bar (`AGENTS.md`). They are copied into `vendor/` from the app's repository, so this repository stands on its own; [vendor/README.md](vendor/README.md) says what is there and how to take a newer version. The binary carries the instructions and the quality bar: `src-tauri/instructions.json`, which `pnpm vendor` writes from the copy, and `vendor/AGENTS.md`. The studio keeps no copy of the media library: it reads the library where it is published (`SLIDR_MEDIA_URL`), and writes to it only through Slidr Library's API (`SLIDR_LIBRARY_URL`).

Paths in this README such as `packages/…`, `desktop/…`, `AGENTS.md` and `docs/…` are of the app's repository, copied in `vendor/` where the studio uses them.

## The window

The studio's window is the app's: the rail of what it makes at the start of the line (on the right in Hebrew), the chat beside it, and the outputs in the rest of the window.

- **The rail**: Ready designs, Templates, Card sets, Frames, Shapes, Graphics, Emoji and Fonts, and Settings at its foot. A kind chosen there is what the next message makes; with none chosen, the studio reads the message and decides (below). The library takes new items of card sets, frames, shapes, graphics, emoji and fonts from no program yet (its API takes only their search tags), so the studio cannot make them, and says so.
- **The chat**: a conversation with the studio. Each message that asks for something starts a request in it, and the studio's turn under it says what became of it: the request read, the concepts planned, the outputs made, each one's stage. **New chat** starts another, **History** lists them, the newest first. A chat keeps working while another is open, and survives a restart of the studio; a request made before there were chats has a chat of its own, holding its words.
- **The outputs**: a card for each output (each design, each template's sample in a language), of the open chat or of every chat. Choose cards to talk about them: they show under the message box (**Your message is about**), and the message is then a change asked of each of them, a turn of its own agent's conversation. **Approve** on a card, or on every card chosen at once, does the next step: an English master is written in the other languages; a whole design, or a sample, is published at once.

A message without a kind is read by the design agent (`template_prompts.route_*`) with the list of templates (their names in Hebrew and English from the app's messages, and the languages each sample is and is not written in), and made a design request or a template request: "translate the Mifgash template into every language it does not support yet" is the template `mifgash` in its fourteen missing languages. A request for anything the studio does not make yet (a new template, its layouts or colours, card sets, frames, shapes, graphics, icons, fonts) stops with the reason, in the request's language, and what the studio can do instead.

## What happens to a design request

Every design is made in all sixteen content languages of the app (`CONTENT_LANGUAGES` in `packages/model/src/languages.ts`), the library's condition for taking it: first in English, its master, by the design agent; then, once the person approves the master, in the other fifteen by the translation agent. A design's `phase` says where it is: `master`, `translating`, `full`. A design made before there were stages (in Hebrew and English, or the languages its request chose) is whole: approving it has the translation agent write the languages it lacks from its English first.

1. **Plan.** The design agent plans the number of concepts asked for (as the words say, or the number chosen beside them; 1 to 12), each distinct in layout, type, palette and picture. Each concept has its own art direction, its English copy, and a prompt for its picture; its name in Hebrew and English, and its search tags in English: the words people type to find it in the app's Ready slides (what it is for, the occasion, the field, the people it addresses; ADR-108 of the app). The agent may change them in `brief.json`, and the variant shows them.

   Each concept starts from its own composition idea, found in the occasion and its world; text on one side and the picture in a shape on the other is allowed for one concept of a plan at most (`composition` in `plan_prompt`, `src-tauri/src/prompts.rs`). Write a request the same way: name the occasions, the group and the real constraints (a culture to respect, an existing design not to resemble), not layouts, shapes or a list of text blocks. A request that dictates the layout gets the same skeleton in every concept; one that names only the occasions gets compositions as varied as the gallery's.

2. **Picture.** For each concept, the images agent makes the picture, as the app's own Codex provider does (same command line, same rule at the head of the prompt). At most four pictures are made at a time. One picture serves every language.
3. **Master.** The design agent looks at the picture, then writes the English design as HTML, `en.html`, composed for the languages to come: room for text that runs a third longer, nothing that only English has, a picture whose mirror works too. Each concept has its own conversation of each agent, whose file tools reach only its own folder.
4. **Render.** A window of the studio that is never shown opens `render.html`, at 1920×1080 CSS px and one device pixel to each (`src-tauri/src/render`). That page converts every file with `@slidr/html-import`, the engine the app's agent uses, and its fidelity guard gets real pictures of the page from WebView2, as the app's capture window takes them. It then:
   - writes the theme's text styles out onto the runs, so the design keeps its type and colours in any deck;
   - runs the app's design check (`@slidr/lint`, the agent's rules);
   - checks the contract that `desktop/src/elements/designs.test.ts` holds every design to;
   - finds the point on the picture's subject, on top in every language;
   - draws the full-size slide and the gallery's 384 px thumbnail, in every language, and the studio takes a picture of each with WebView2's DevTools protocol (`Page.captureScreenshot`);
   - draws each slide at 320 × 180 too, as the app's galleries show it (`<lang>-gallery.png`): published with the design, it is the picture the galleries show of it, made ahead, and they draw it live only once it changes (ADR-109 and ADR-111 of the app).
5. **Review.** The agent reads the renders (two for each language) together with the findings and fixes the design. The number of rounds is set in the settings (default 2). A round in which it changes nothing ends the review. A design that still breaks the gallery's contract after the rounds gets one more turn to fix it, even when no rounds were asked for. The design agent can also ask for a new picture, or a change to this one, through the concept's `brief.json`.
6. **You approve the English design.** Open a card to see it full size and as a thumbnail, with its findings and a log of what the agents did; choose it to ask for a change in the chat; or approve it.
7. **The other languages.** The translation agent writes the design in the other fifteen languages, five at a time, from `en.html` and its render (`translation_*` in `prompts.rs`): every left-to-right file keeps the master's composition, every right-to-left file (Hebrew, Arabic) is its mirror, and a language changes only what its text needs to fit; each text is set in the counterpart of the master's family for the language's letters. Beside the files it writes `localized.json`: the design's name and its search tags in each of its languages, which the studio takes (`tags.rs` holds them to the library's rules: 3 to 20 a language, in the language's own letters). Then every language is rendered and reviewed, by the translation agent, as above; the master is never changed.
8. **You approve the design.** It is published at once ([Publishing](#publishing)). A change asked for in the chat goes first to the design agent, which changes the master when the change is the design's, then to the translation agent, which brings the other languages in line with it (or changes only the languages it concerns); then every language is rendered again.

A design that breaks the gallery's contract cannot be approved. A design with errors from the design check can be, after a confirmation.

What the agents are told comes from the app's own text (copied in `vendor/`), never written again here: the design guidelines and HTML conventions of `packages/prompts` (`src-tauri/instructions.json`, which `web/tools/instructions.mjs` writes from them), the quality bar of `AGENTS.md`, and the fonts the library offers: the families of each of the request's languages (made for its letters, or for Latin ones and having its letters), and the counterpart in each language of every family the English and Hebrew files may use, the family of its letters closest to it in character, which that language's file sets the same text in (the catalog's `counterparts`, ADR-105). `src-tauri/src/prompts.rs` adds only what a gallery design needs on top: the contract and the studio's workflow, for the request's languages. Where no family of the library has a language's letters (only in a catalog older than ADR-105), its text names one family of the library for its Latin letters and figures, then `sans-serif` (`font-family: 'Inter', sans-serif`), and the system's font draws the rest, the same when the HTML is converted as when the app draws the slide. The studio's copy of the language list, `src-tauri/src/languages.rs`, is held to the model's by the unit tests.

## Template samples

A template request names a built-in template and the languages to write its sample in: Templates on the rail offers them under the message box, the languages the sample lacks by default, and any it has: a language it has is rewritten as the message says. The template's layouts, colours and pictures do not change. Each language is a variant of its own, a card of its own, with its own conversation of the translation agent, and they run side by side.

1. **Read.** The studio reads the template from the catalog of templates (the published `templates/catalog.json`) into the variant's folder: `template.json`, `template.md` (the theme, its fonts and text styles, and every box of every layout: its size, its style, how many lines it holds), and the English and Hebrew samples, `en.json` and `he.json`. A rewrite also gets the sample it has.
2. **Write.** The translation agent writes `<lang>.json` in the catalog's own format (`SampleSlide[]`, `packages/templates/src/builtin/kit.ts`): the same slides, layouts, roles and pictures as the English sample, the words written natively for the language's readers, figures and dates as they write them, and no year. The system prompt (`template_prompts.rs`) adds what the language needs: shorter wording where it runs longer, more leading where its letters are taller, phrase breaks where it can break anywhere, and which of its letters the template's families leave to the system's font (a run may name a family of the library that has them).
3. **Render.** The render page builds every slide on the template with `sampleSlides`, the engine the catalog and the app build a sample with, and draws them in one deck: each at 1920×1080 (`s01-full.png`…), each 384 px wide (`s01-thumb.png`…), and all of them on one sheet that reads in the language's direction (`sheet.png`). It runs the app's design check, every rule, as the acceptance of a template does, and builds the slide it was written from (English, or Hebrew for a right-to-left language) with the same seed: a finding that slide has on the same elements is not this language's doing, and is shown apart. It holds the sample to the English one: the same slides on the same layouts, as many fills under each role, the same pictures, text in the language's own letters, no English left (more than a quarter of the longer texts still in English is a contract issue) and no placeholder words.
4. **Review, you, publishing.** As for a design: review rounds, then the variant up close (each slide full size, the sheet, the findings slide by slide), a change in the chat, approval. A sample that breaks its contract cannot be approved. Approved, it goes to the library at once as `templates: translate`, and a publication writes it as `samples[<template>][<lang>]` into `templates/catalog.json`, in the registry's order of languages, changing nothing else of the file ([Publishing](#publishing)).

`desktop/scripts/export-templates.mjs` keeps a language the source file of a template does not write, so a template exported again keeps the translations the studio published.

## Publishing

There is no separate step of publishing: approving a whole design, or a template's sample, sends it to the library through [Slidr Library](https://github.com/slidrhq/library)'s upload API (its README, "Uploading") at once, one at a time (`publish_steps` in `pipeline.rs`, `src-tauri/src/uploads.rs`). The card says it is being published, then that it is, or why the library did not take it, or why it waits there:

- a design as `designs: add`: its picture (`images/designs/<id>.webp`), its slide in each of its sixteen languages (the library takes a design only in all of them), its names, its group and the point of its picture's subject, and its search tags in Hebrew and English (all `add` takes). With it go the pictures of its slides that the galleries show, as its last render drew them (`thumb-<lang>`, WebP at quality 85); a render from before the studio drew them has none, and the galleries draw those slides live. Published, its search tags in every language follow as one `designs: tag` (every language of it, Hebrew and English too: the library keeps a design's tags as the upload gives them);
- a template's sample as `templates: translate`, in its language.

**Gallery pictures.** **Settings → Library** also says how many slides of the published designs the library has no picture of as they are now, and draws them (`src-tauri/src/gallery.rs`, the `gallery_missing` and `gallery_draw` commands): the designs published before the studio drew them, the app's own among them, and slides changed since they were drawn. It reads which are missing from `elements/designs/revs.json` and `images/designs/thumbs/index.json`, while `revs.json` is of the library as its manifest lists it. When it is not (the library changed since it wrote it), the settings say so, and drawing first has the library write it again, publishing no upload (`POST /api/publish` with `{"uploads": []}`). A hidden render window draws each slide as the library publishes it in its language (`elements/designs/<lang>/<catalog>`), as the app's gallery draws it (`web/src/gallery.tsx`), 48 to a window; each design's pictures go as one `designs: draw` upload, each with the word of the slide it was drawn of, which the library takes while the slide still has it (ADR-116 of the app).

The library checks each against what it publishes. The studio's token is of the `publish` scope, so the library publishes each upload at once (written into the files it changes in its bucket, where every app reads it the next time it reads the manifest), or keeps it and says why: publishing is the library's business, not the studio's. A variant keeps its upload and its status in the library (`library_statuses` reads it again), and one whose upload is published is marked published. An upload the library keeps (accepted while a publication cannot run, or pending for a person there) is no failure: its card says it waits in the library, with the library's reason on hover, and the studio asks after it as it starts and once a minute (`Library::watch`), so it is marked published when the library's own job publishes it. Nothing is staged on this machine, and no Cloudflare token is needed.

The studio sends the library a person's token, all the library takes from a program (`Authorization: Bearer slk_…`): one of the `publish` scope, so that the library publishes its uploads at once, which an admin of the library makes in its profile. Give the token in **Settings → Library** once, and replace it there (**Replace the library's token**), as a token of the `publish` scope in place of one that only uploads, whose uploads wait for a reviewer and which cannot have the library write the words of its designs: the studio keeps it in Windows' Credential Manager (under `slidr.studio`, as `library-token`), as the app keeps its keys, and takes away the program's key kept there before (`library-key`), which the library no longer takes. `SLIDR_LIBRARY_TOKEN` wins over it. `SLIDR_LIBRARY_URL` names the library (`https://library.slidr.workers.dev/`; an organization's own Slidr Library, installed on Linux in Docker, by its address, with a token made in its own profile; `http://127.0.0.1:5176/` for its dev server).

Designs from the studio join the library's one catalog of the designs, `elements/designs/index.json`, with ids that start with `m-`, which no first design's id takes (ADR-118 of the app). The catalog names them, and a group of their own, in Hebrew and English; the library writes the size of each picture into `images/designs/sizes.json` and their search tags into `tags/designs.json`, beside those of every other design. A design's `slides` hold a slide for each of its languages, while its names in the catalog stay in Hebrew and English (the studio keeps its name in every language in its brief); its search tags are kept in every language. A library not published since its catalog was in two (`managed.json` beside `index.json`) folds them on its next publication; until then the studio reads both.

## The library

The title bar opens [Slidr Library](https://github.com/slidrhq/library) in the browser (`VITE_SLIDR_LIBRARY_URL` when the pages are built, `https://library.slidr.workers.dev/` by default), which shows the media library as it is published.

Slidr Library served from this machine (its dev server) reads which of the library's designs the studio made, and links each one to its request here. The studio answers it at `http://127.0.0.1:8765/` (`src-tauri/src/local_server.rs`): `/api/state` and `/api/status` to read, to any page of this machine, and `/#tab=<rid>&v=<vid>`, which brings the studio's window forward on that request's chat and the variant up close. When another program holds the port, the studio works without them.

The pages read the media library where the app's pages read it, at `media://` (`http://media.localhost/` on Windows): the studio answers from `SLIDR_MEDIA_URL` (`src-tauri/src/media.rs`). A variant's own files (its picture, its renders) are at `studio://` (`src-tauri/src/files.rs`).

## Settings

| Variable                                               | Default                                                                                               |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `SLIDR_STUDIO_DATA`                                    | `%LOCALAPPDATA%\slidr.studio` installed; the repository's `.data` in a build of it (`pnpm tauri dev`) |
| `SLIDR_MEDIA_URL`                                      | `https://media.slidr.studio/`                                                                         |
| `SLIDR_LIBRARY_URL`, `SLIDR_LIBRARY_TOKEN`             | `https://library.slidr.workers.dev/`, the token given in Settings → Library                           |
| `SLIDR_STUDIO_MAX_CLAUDE`, `_MAX_CODEX`, `_MAX_RENDER` | `4`, `4`, `2`                                                                                         |
| `SLIDR_STUDIO_PORT`, `SLIDR_STUDIO_HOST`               | `8765`, `127.0.0.1` (the answers for Slidr Library)                                                   |
| `SLIDR_STUDIO_SHOW_RENDER`                             | not set: render windows are hidden, and closed when done                                              |
| `CLAUDE_PATH`, `CODEX_PATH`                            | found on the PATH                                                                                     |

Variables are read when the studio starts. A second start of the studio brings the first one forward: two would work on the same requests. What is chosen in the studio's settings (the agents of each role, the review rounds) is kept in `<data>/settings.json`.

Each chat lives in `<data>/chats/<cid>.json`, each request in `<data>/requests/<rid>/`. Each variant's working folder, `<vid>/work/`, holds the concept (`brief.json`), the picture (`subject.png`), an HTML file for each language, the names and tags of the other languages (`localized.json`), and `renders/r<n>/`, a folder for each revision with its renders (`<lang>-full.png`, `<lang>-thumb.png`) and `result.json`. A template variant's folder holds `brief.json`, `template.json`, `template.md`, `en.json`, `he.json` and its `<lang>.json`, and its renders are `s01-full.png`, `s01-thumb.png`… and `sheet.png`. The last three revisions are kept.

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
  pipeline.rs         the chats' messages, the work of a request and of each variant, as tasks
                      that can be stopped
  store.rs            chats, requests and variants as JSON files, each change sent to the window
  agents.rs           the three roles, the settings, one turn of either program
  claude.rs, codex.rs one turn of Claude Code; a picture, or a turn as an agent, of the Codex CLI
  tags.rs             search tags in every language, held to the library's rules
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
