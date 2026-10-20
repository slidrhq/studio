# Slidr Studio

A local web app that makes content for the media library from a request, and publishes the approved work to the library on Cloudflare Pages (docs/media-library.md): ready-made designs for Elements → Designs, and the sample decks of the built-in templates in any content language (a translation, or a rewrite). The server is Python (FastAPI). The pages are React and use the app's own packages: the HTML conversion engine, the template engine, the renderer and the design check.

The studio makes and publishes. To see what the library holds, as every installed app reads it, use [Slidr Library](https://github.com/slidrhq/library), which the "Library" tab of the studio opens.

## Setup

The studio works with the app's own code: the packages it converts, renders and checks with, the app's instructions to its design agent and its quality bar (`AGENTS.md`), and the app's script that publishes the library. They are copied into `vendor/` from the app's repository, so this repository stands on its own; [vendor/README.md](vendor/README.md) says what is there and how to take a newer version. The media library's author copy sits beside the repository (`../Slidr-media`, `SLIDR_MEDIA_DIR`).

Paths in this README such as `packages/…`, `apps/desktop/…`, `AGENTS.md` and `docs/…` are of the app's repository, copied in `vendor/` where the studio uses them.

```powershell
./start.ps1            # http://127.0.0.1:8765, opened in the browser
```

On the first run, the launcher creates `server/.venv` and installs `server/requirements.txt`. It installs the pages' packages (`pnpm install`) and rebuilds the pages whenever a source file is newer than the build. It needs Python 3.11 or newer, Node, pnpm and the installed Microsoft Edge (the headless renders run in it). It also needs both CLIs, signed in:

- **Claude Code** (`claude`), on your Claude login. It plans the concepts and writes, reviews and fixes the designs.
- **Codex CLI** (`codex login`), on your ChatGPT login. It makes the pictures. The studio finds `codex` on the PATH, behind npm's shim, or inside VS Code's ChatGPT extension. `CODEX_PATH` names it outright.

The status chips at the top of the studio say which of them it found and whether they are signed in.

## Kinds of request

Each request is a tab, and requests run side by side. A tab keeps working while another is open, and survives a restart of the server. A request is one of:

- **A design**: ready-made slides for the gallery, below.
- **A template's sample**: the sample deck of a built-in template, written in languages. See [Template samples](#template-samples).
- **Read automatically** (the default): a request in words, such as "translate the Mifgash template into every language it does not support yet". One structured Claude call (`template_prompts.route_*`) reads it with the list of templates (their names in Hebrew and English from the app's messages, and the languages each sample is and is not written in) and makes it one of the two: here the template `mifgash` in its fourteen missing languages. A request for anything the studio does not make yet (a new template, its layouts or colours, card sets, frames, shapes, graphics, icons, fonts) stops with the reason, in the request's language, and what the studio can do instead.

## What happens to a design request

A design request also names its languages. Hebrew and English are always made, and by default they are the only ones. Tick any other content language of the app (`CONTENT_LANGUAGES` in `packages/model/src/languages.ts`: Arabic, German, Japanese…) and every concept of that request is planned, written, rendered, reviewed and published in it too. "More concepts" keeps the request's languages. A request made before there was a choice is Hebrew and English.

1. **Plan.** Claude plans the number of concepts asked for (1 to 6), each distinct in layout, type, palette and picture. Each concept has its own art direction, copy in each language of the request, written for its own readers, and a prompt for its picture. The gallery's names stay in Hebrew and English, and so do the search tags Claude gives each concept: the words people type to find it in the app's Ready slides (what it is for, the occasion, the field, the people it addresses; ADR-108 of the app). Claude may change them in `brief.json`, and the variant shows them.
2. **Picture.** For each concept, Codex makes the picture, as the app's own Codex provider does (same command line, same rule at the head of the prompt). At most four pictures are made at a time. One picture serves every language.
3. **Design.** Claude looks at the picture, then writes the design as HTML, one file per language: `he.html`, `en.html`, and `ar.html`, `de.html`, `zh-CN.html`… for the others. The English file sets the composition, every left-to-right file keeps it, and every right-to-left file (Hebrew, Arabic) is its mirror; a language changes only what its text needs to fit. Each concept has its own Claude conversation, whose file tools reach only its own folder.
4. **Render.** A headless Edge opens `render.html`. That page converts every file with `@slidr/html-import`, the engine the app's agent uses, and its fidelity guard gets real pictures of the page, as in the app. It then:
   - writes the theme's text styles out onto the runs, so the design keeps its type and colours in any deck;
   - runs the app's design check (`@slidr/lint`, the agent's rules);
   - checks the contract that `apps/desktop/src/elements/designs.test.ts` holds every design to;
   - finds the point on the picture's subject, on top in every language;
   - takes the full-size slide and the gallery's 384 px thumbnail, in every language.
5. **Review.** Claude reads the renders (two for each language) together with the findings and fixes the design. The number of rounds is set per request (default 2). A round in which Claude changes nothing ends the review. A design that still breaks the gallery's contract after the rounds gets one more turn to fix it, even when no rounds were asked for. Claude can also ask for a new picture, or a change to this one, through the concept's `brief.json`.
6. **You.** Open a variant to see it full size and as a thumbnail, in each of its languages, with its findings and a log of what Claude and Codex did. From there you can:
   - ask for a change in words (another turn of the same conversation, then a new render);
   - ask for a new picture, or a change to the current one;
   - approve the variant, or discard it.

   A design that breaks the gallery's contract cannot be approved. A design with errors from the design check can be, after a confirmation.

What Claude is told comes from the app's own text (copied in `vendor/`), never written again here: the design guidelines and HTML conventions of `packages/prompts` (read through `web/tools/instructions.mjs`), the quality bar of `AGENTS.md`, and the fonts the library offers: the families of each of the request's languages (made for its letters, or for Latin ones and having its letters), and the counterpart in each language of every family the English and Hebrew files may use, the family of its letters closest to it in character, which that language's file sets the same text in (the catalog's `counterparts`, ADR-105). `server/slidr_manager/prompts.py` adds only what a gallery design needs on top: the contract and the studio's workflow, for the request's languages. Where no family of the library has a language's letters (only in a catalog older than ADR-105), its text names one family of the library for its Latin letters and figures, then `sans-serif` (`font-family: 'Inter', sans-serif`), and the system's font draws the rest, the same when the HTML is converted as when the app draws the slide. The server's copy of the language list, `server/slidr_manager/languages.py`, is held to the model's by the unit tests.

## Template samples

A template request names a built-in template and the languages to write its sample in. The form offers the languages the sample lacks, and any it has: a language it has is rewritten as the instructions say. The template's layouts, colours and pictures do not change. Each language is a variant of its own, with its own Claude conversation, and they run side by side.

1. **Read.** The studio reads the template from the catalog of templates (`templates/catalog.json` of the author copy, or the published one when there is no author copy) into the variant's folder: `template.json`, `template.md` (the theme, its fonts and text styles, and every box of every layout: its size, its style, how many lines it holds), and the English and Hebrew samples, `en.json` and `he.json`. A rewrite also gets the sample it has.
2. **Write.** Claude writes `<lang>.json` in the catalog's own format (`SampleSlide[]`, `packages/templates/src/builtin/kit.ts`): the same slides, layouts, roles and pictures as the English sample, the words written natively for the language's readers, figures and dates as they write them, and no year. The system prompt (`template_prompts.py`) adds what the language needs: shorter wording where it runs longer, more leading where its letters are taller, phrase breaks where it can break anywhere, and which of its letters the template's families leave to the system's font (a run may name a family of the library that has them).
3. **Render.** The render page builds every slide on the template with `sampleSlides`, the engine the catalog and the app build a sample with, and draws them in one deck: each at 1920×1080 (`s01-full.png`…), each 384 px wide (`s01-thumb.png`…), and all of them on one sheet that reads in the language's direction (`sheet.png`). It runs the app's design check, every rule, as the acceptance of a template does, and builds the slide it was written from (English, or Hebrew for a right-to-left language) with the same seed: a finding that slide has on the same elements is not this language's doing, and is shown apart. It holds the sample to the English one: the same slides on the same layouts, as many fills under each role, the same pictures, text in the language's own letters, no English left (more than a quarter of the longer texts still in English is a contract issue) and no placeholder words.
4. **Review, you, publishing.** As for a design: review rounds, then the variant up close (each slide full size, the sheet, the findings slide by slide), a change in words, approval. A sample that breaks its contract cannot be approved. Publishing writes `samples[<template>][<lang>]` into the author copy's `templates/catalog.json`, in the registry's order of languages, and changes nothing else of the file (it is written as `export-templates.mjs` writes it). Any other difference between that catalog and the published one (an author's work that is not published yet, such as another template's new languages) goes with the file, so the panel lists it part by part among the unexpected changes. It refuses a catalog that would pass the 25 MB Pages serves; every template in all sixteen languages would.

`apps/desktop/scripts/export-templates.mjs` keeps a language the source file of a template does not write, so a template exported again keeps the translations the studio published.

## Publishing

Publishing has two steps, and nothing reaches Cloudflare before the second.

1. **Prepare** (the "Publish" panel):
   - The studio copies into the author copy of the library (`../Slidr-media`, or `SLIDR_MEDIA_DIR`) any published files that copy lacks. A file the copy already has is never touched.
   - It writes the approved designs into the copy: `elements/designs/managed.json` and `images/designs/<id>.webp`; and the approved template samples into its `templates/catalog.json`.
   - It runs `apps/desktop/scripts/media-publish.mjs --dry-run --report`, the app's own publishing script, with its staging, manifest and guards.
   - The panel then shows every file that would be added, changed or removed, and warns about any change that is not one of these designs.
2. **Confirm.** The script deploys with wrangler. The studio then reads the published manifest back to check the files.

Cancelling, or a failed deploy, puts the author copy back as it was.

Designs from the studio go to their own catalog, `elements/designs/managed.json`, with ids that start with `m-`. They never collide with the hand-authored `index.json`. The app reads both files: names, groups and search tags come from `managed.json`, and an authored design wins on an id clash. A design's `slides` hold a slide for each language it was made in (`he` and `en`, and any other), while its names stay in Hebrew and English; a deck in a language a design was not made in gets the English slide.

Publishing needs a Cloudflare API token with Pages edit rights. Give it in the panel, where it is kept in the server's memory only, or set `CLOUDFLARE_API_TOKEN` in the environment. The account defaults to the library's (`CLOUDFLARE_ACCOUNT_ID` overrides it).

## The library

The "Library" tab opens [Slidr Library](https://github.com/slidrhq/library) (`VITE_SLIDR_LIBRARY_URL` when the pages are built, `http://127.0.0.1:5176/` by default), which shows the media library as it is published. It reads which of the library's designs the studio made from this server (`/api/state`, `/api/status`), and links each one to its request here; the server answers such reads from any page of this machine.

## Settings

| Variable                                               | Default                          |
| ------------------------------------------------------ | -------------------------------- |
| `SLIDR_STUDIO_PORT`, `SLIDR_STUDIO_HOST`               | `8765`, `127.0.0.1`              |
| `SLIDR_STUDIO_DATA`                                    | `.data`                          |
| `SLIDR_MEDIA_DIR`                                      | `../Slidr-media`                 |
| `SLIDR_MEDIA_URL`                                      | `https://slidr-media.pages.dev/` |
| `SLIDR_STUDIO_MAX_CLAUDE`, `_MAX_CODEX`, `_MAX_RENDER` | `4`, `4`, `2`                    |
| `SLIDR_STUDIO_BROWSER`                                 | `msedge` (a Playwright channel)  |
| `CLAUDE_PATH`, `CODEX_PATH`, `NODE_PATH_EXE`           | found on the PATH                |

Each request lives in `.data/requests/<rid>/`. Each variant's working folder, `<vid>/work/`, holds the concept (`brief.json`), the picture (`subject.png`), an HTML file for each language, and `renders/r<n>/`, a folder for each revision with its renders (`<lang>-full.png`, `<lang>-thumb.png`) and `result.json`. A template variant's folder holds `brief.json`, `template.json`, `template.md`, `en.json`, `he.json` and its `<lang>.json`, and its renders are `s01-full.png`, `s01-thumb.png`… and `sheet.png`. The last three revisions are kept.

## Working on the studio

```powershell
pnpm dev          # the pages at http://127.0.0.1:5175, the API proxied to :8765
$env:SLIDR_STUDIO_UI_URL = 'http://127.0.0.1:5175'   # the server renders through the dev pages
cd server; .venv/Scripts/python -m slidr_manager --no-open
.venv/Scripts/python -m pip install -r requirements-dev.txt; .venv/Scripts/python -m pytest
node web/tools/snap.mjs --url "http://127.0.0.1:8765/render.html?v=<vid>" --out <dir> --debug
```

`pnpm check` runs `typecheck`, `eslint` and `prettier` over the pages. The unit tests hold the server's copy of the language list to the app's (`vendor/packages/model`).
