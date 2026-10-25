# The app's code

The files of the app's repository ([slidrhq/app](https://github.com/slidrhq/app)) the studio uses, copied at their own paths, so the studio makes and checks its work with the app's own code and this repository stands on its own:

- `packages/` — `@slidr/html-import`, `@slidr/renderer`, `@slidr/lint`, `@slidr/templates`, `@slidr/model`, `@slidr/agent-tools`, `@slidr/media-library` and `@slidr/runtime`, the files of them that are used; members of this workspace (`pnpm-workspace.yaml`). And the app's instructions to its design agent, `packages/prompts/src/design.ts` and `html.ts`, which `web/tools/instructions.mjs` writes into `src-tauri/instructions.json` for the studio's binary.
- `desktop/src/templates/messages.ts` — the names of the built-in templates.
- `AGENTS.md` — the app's quality bar for designs and templates, which the studio gives Claude (`src-tauri/src/instructions.rs`, which carries it in the binary).
- `tsconfig.base.json` — the app's compiler options.

`FILES.txt` lists the files, and `COMMIT` the app's commit they were copied from. They are not edited here. To take a newer version of the app's code:

```powershell
pnpm vendor --from ../app     # any checkout of the app
pnpm install; pnpm check     # the copy also writes src-tauri/instructions.json
cargo test                    # the studio's copy of the language list is held to the model's
```

A file the app's code comes to import is added to `FILES.txt` (the type check, or the build, names it).
