# Fork Guide

This repository is an independent, maintained fork of
[metaspartan/cybara](https://github.com/metaspartan/cybara) — the original project
by [Carsen Klock](https://github.com/metaspartan). The fork is maintained by
**Erature** and is **not** an official upstream release channel.

This document is the contract between the fork and upstream: what changes here,
what does not, which release channel this repository owns, and how divergence is
tracked. Upstream authorship and the MIT license are preserved — see
[NOTICE.md](../NOTICE.md) and [LICENSE.md](../LICENSE.md).

## Why this fork exists

Upstream ships a broad release matrix — desktop, mobile, browser extension, npm,
container images — gated on signing material and registry credentials that only
the upstream maintainer holds. This fork exists to provide a **CLI-only,
credential-free release channel** that anyone can install and audit:

- Releases publish standalone CLI binaries for Linux, macOS, and Windows
  (x64 and arm64) with SHA256 sidecars.
- The repository holds **zero** GitHub Actions secrets, **zero** Actions
  variables, and **zero** webhooks. The release workflow uses only the built-in
  `GITHUB_TOKEN`. The one environment in the repository is `github-pages`, which
  GitHub provisions automatically for the marketing site and which holds no
  secrets of its own.
- Every published artifact is checksum-verified at install time, and the CI gate
  is reproducible without any private state.

The upstream project remains the canonical source for the desktop, mobile, and
browser-extension builds.

## Release channel

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

Installers resolve releases from **this repository** by default and verify the
published SHA256 checksum before installing. Override the channel explicitly
with `CYBARA_RELEASE_REPOSITORY` if you want a different source.

## Version numbering

This fork and upstream independently increment the same `<major>.<minor>.<patch>`
sequence, so a bare version number is ambiguous across channels. The fork marks
its channel explicitly:

- **Release tags** stay plain semver (`v1.0.2557`), so download URLs, Nix
  hashes, and the release manifest keep working unchanged.
- **The reported version** carries the channel marker: `cybara --version`,
  `GET /api/info`, `GET /api/build-info`, and `GET /api/health` all report
  `1.0.2557+fork.1`. A running binary therefore always identifies its channel.
- **`GET /api/build-info` and `GET /api/health`** also expose
  `release_channel: "fork"` for machine consumers.

Version *ordering* stays numeric within a channel, because build metadata after
`+` is not part of semver precedence. The marker identifies the channel; it
does not reorder releases. The self-updater therefore compares the numeric
release sequence exactly as upstream does.

When reporting a problem, always include the full version string including the
marker, and the output of `cybara doctor`.

## What this fork changes

Changes are additive and MIT-compatible. No upstream attribution has been
removed.

### Runtime fixes carried forward

- **Tool-call argument repair** (upstream PR
  [#122](https://github.com/metaspartan/cybara/pull/122), not yet merged
  upstream). When a provider elides or truncates streamed tool-call arguments,
  upstream substituted a bare notice string in place of the arguments. Every
  OpenAI-compatible provider then rejected the request with
  `HTTP 400 invalid tool call arguments`. This fork emits valid JSON instead,
  so a compacted tool call stays a recoverable tool call. The behaviour is
  covered by `tests/core/tool-call-argument-repair.test.ts` and
  `tests/core/tool-transcript-argument-compaction.test.ts`.

### Security remediation

- Mobile `deepmerge` prototype poisoning is patched in-tree via
  `apps/mobile/patches/deepmerge@4.3.1.patch`. The published `deepmerge@4.3.1`
  release has no fixed version.
- The `node-forge` signature-parser flaw
  (`GHSA-86w9-cpqp-85rv`) is remediated by pinning `node-forge@1.4.1`, which
  fixed the issue upstream by requiring a canonical DER `DigestInfo`. This
  replaced an earlier in-tree patch; that patch and its version-specific
  advisory exception have been removed.

### Release and distribution plumbing

- The release workflow is CLI-only and secret-free.
- The CLI self-updater, install scripts, and Nix release hashes resolve this
  repository's release channel.
- The version manifest is the single source of truth for the tag, the version
  files, and the built binary, so they cannot drift apart.

### Public surface

- Issues and Discussions are enabled on this repository. Report fork-specific
  problems here; report upstream problems upstream.
- Community chat, social accounts, and the website remain operated by upstream
  and are not moderated from this repository.

## What this fork does not change

- The product name, logo, and trademark remain the property of the upstream
  author.
- The desktop, mobile, and browser-extension artifacts remain upstream's.
- The upstream dependency graph is not forked. Runtime code follows upstream so
  that upstream fixes land here through a merge rather than a re-implementation.

## Staying current with upstream

`upstream` is tracked as a git remote:

```bash
git fetch upstream
git log --oneline upstream/main..main   # fork-only commits
git log --oneline main..upstream/main   # upstream commits not yet merged
```

The expected steady state is that `main..upstream/main` is empty or small:
upstream changes should be merged, not reimplemented. When a fork-only change
becomes generally useful, it is proposed upstream rather than kept here.

## Contributing

This fork publishes from a single branch. `main` is the integration branch, so
branch from `main` and open pull requests against `main`. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for setup, the local check gate, and
review requirements.

## Security

Report security issues through this repository's private advisory system, as
described in [SECURITY.md](../SECURITY.md). Do not open a public issue for a
vulnerability.
