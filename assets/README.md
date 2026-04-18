# Discord Rich Presence assets

Upload these keys in the Discord Developer Portal:
`Application -> Rich Presence -> Art Assets`.

Keys **must** match exactly — the names below are what `presence-builder.ts` sends.

| Key            | Size       | Slot        | Description                               |
|----------------|------------|-------------|-------------------------------------------|
| `codex_logo`   | 1024x1024  | Large image | Official OpenAI Codex logo                |

## Windows executable icon

Drop a multi-size `app.ico` (16/32/48/256) next to this README and run
`npm run pkg && npm run pkg:icon` — the post-build script stamps it onto
`bin/codex-rich-presence.exe` via `rcedit` (install globally: `npm i -g rcedit`).
If `app.ico` is missing, only version metadata is stamped.

Small image badges (`cli_badge`, `app_badge`, `combo_badge`) are intentionally
not shipped — the state (CLI / Desktop / Both) is conveyed by the `details` and
`state` strings only.

Source images are kept outside the repo. Once uploaded, Discord serves them by
key — no URLs are bundled.
