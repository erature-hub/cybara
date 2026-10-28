# NOTICE

This repository is a maintained fork of **Cybara** by **Carsen Klock**
(<https://github.com/metaspartan/cybara>).

## Upstream attribution

Cybara was created by Carsen Klock and is distributed under the **MIT License**.
This fork preserves that license and the original copyright notice verbatim in
[LICENSE.md](./LICENSE.md). Third-party attributions are preserved in
[THIRD-PARTY-NOTICES.md](./THIRD-PARTY-NOTICES.md).

- Upstream project: <https://github.com/metaspartan/cybara>
- Upstream author: Carsen Klock
- Upstream license: MIT
- Fork maintained by: Erature (<https://github.com/erature-hub>)

## What this fork changes

This fork exists to carry a specific upstream contribution and to ship a
self-contained CLI release channel. The substantive change relative to upstream
is the **tool-call argument repair** for providers that elide or truncate
tool-call arguments in streamed responses:

- Upstream pull request: <https://github.com/metaspartan/cybara/pull/122>
- Fixes the failure where a streamed tool call arrives with missing, partial,
  or JSON-invalid `arguments`, which previously surfaced as an unparseable tool
  call rather than a recoverable one.

No upstream attribution has been removed. Changes here are additive and
MIT-compatible.

## Distribution scope

This fork publishes **standalone CLI binaries** only:

| Channel | Published here | Source |
| --- | --- | --- |
| Standalone CLI (`cybara-v<version>-<target>-cli`) | Yes | This repository |
| Nix hashes | Yes | This repository |
| Desktop app (Tauri) | No | [Upstream releases](https://github.com/metaspartan/cybara/releases/latest) |
| macOS native app | No | [Upstream releases](https://github.com/metaspartan/cybara/releases/latest) |
| Android APK | No | [Upstream releases](https://github.com/metaspartan/cybara/releases/latest) |
| iOS build | No | [Upstream releases](https://github.com/metaspartan/cybara/releases/latest) |
| Browser extension | No | [Upstream releases](https://github.com/metaspartan/cybara/releases/latest) |
| npm package | No | [Upstream releases](https://github.com/metaspartan/cybara/releases/latest) |
| Container image | No | [Upstream releases](https://github.com/metaspartan/cybara/releases/latest) |

The desktop, mobile, and npm channels depend on upstream-owned signing
material and registry credentials. This repository deliberately does not hold
those credentials, so it does not attempt to publish those artifacts.

## Security

Report security issues in this fork through the upstream security process
described in [SECURITY.md](./SECURITY.md). Do not open a public issue for a
vulnerability.
