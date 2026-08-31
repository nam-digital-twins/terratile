# Contributing to terratile

Thanks for your interest in terratile. It is a small library; contributions of
any size are welcome.

## Development setup

```
npm install
npm run build      # bundles src/index.mjs -> dist/terratile.js (UMD)
npm run lint       # eslint over src/ and integrations/
```

`npm run build` must be run after any change under `src/` - `dist/terratile.js`
is the committed UMD bundle that examples and PlayCanvas projects load.
`integrations/playcanvas/*.js` are plain `<script>` files and are not bundled;
they ship as-is.

## Running the examples

```
npm run build
python -m http.server 8000
# open http://localhost:8000/examples/basic-viewer/
```

Each example needs a Google Maps API key - see the per-example README. Never
commit a key; `examples/**/config.local.js` is gitignored for local use.

## Project layout

- `src/` - the bundled engine-agnostic core (ES modules). `src/index.mjs` is
  the public entry point.
- `integrations/playcanvas/` - PlayCanvas integration scripts that attach to
  the `terratile` global.
- `examples/` - standalone runnable examples.
- `dist/` - the committed build artefact.

## Pull requests

- Keep `npm run lint` and `npm run build` clean - CI runs both.
- Match the surrounding code style; the lint config is `@playcanvas/eslint-config`.
- Document exported APIs with JSDoc.
- For changes under `src/`, rebuild and commit the updated `dist/terratile.js`.
- Describe what changed and why in the PR; update `CHANGELOG.md` for
  user-visible changes.

## License

By contributing you agree your contributions are licensed under the Apache
License 2.0, the same as the rest of terratile (see [LICENSE](LICENSE) and
[NOTICE](NOTICE)). Please keep the copyright and NOTICE attribution intact, and
preserve the third-party notices in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
