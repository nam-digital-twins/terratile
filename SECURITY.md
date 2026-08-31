# Security Policy

## Supported versions

terratile is pre-1.0. Security fixes are applied to the latest released version
on npm and the `main` branch only. Please upgrade to the latest version before
reporting.

| Version | Supported          |
| ------- | ------------------ |
| latest  | yes                |
| older   | no                 |

## Reporting a vulnerability

Please do NOT open a public GitHub issue for security problems.

Report vulnerabilities privately to **itsampras@ece.upatras.gr**. If you prefer,
you can also use GitHub's private ["Report a vulnerability"] advisory flow under
the repository's Security tab.

Include, where possible:

- a description of the issue and its impact,
- steps to reproduce or a proof of concept,
- affected version(s), and
- any suggested fix.

You can expect an acknowledgement within a few working days. Once the issue is
confirmed, a fix will be prepared and released, and you will be credited in the
release notes unless you ask otherwise. Please give a reasonable period for a
fix to ship before any public disclosure.

## Scope notes

terratile streams third-party 3D Tiles (Google Photorealistic 3D Tiles, Cesium
ion, or arbitrary tileset URLs) and runs in the browser. Credentials (Google
Maps API keys, Cesium ion tokens) are provided by the host application and are
sent only to the provider you configure. Never commit credentials; the examples
read them from the page or the URL, and `examples/**/config.local.js` is
gitignored for local use.
