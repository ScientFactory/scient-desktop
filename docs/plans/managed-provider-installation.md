# Managed Provider Installation and Connection

Status: IMPLEMENTED LOCALLY; CROSS-PLATFORM RELEASE GATES REMAIN

## Objective

Make every provider that Scient currently exposes understandable and usable from a clean computer without requiring the user to install Homebrew, npm, Node.js, curl, wget, tar, unzip, Git, or a provider CLI.

The primary flow is one action: **Install and connect**. Scient downloads an approved provider runtime, verifies and installs it in user-owned application data, starts provider-owned authentication, verifies the result, and reports that the provider is ready. Existing user-managed installations and credentials remain untouched.

The runtime-installation half of this design is now implemented for every provider: eight providers have app-managed recipes and Pi is bundled. A user does not need Homebrew, npm, Node.js, curl, wget, tar, unzip, Git, an administrator password, or a shell-profile change. Connection is automated only where the provider exposes a reviewed, non-secret browser-login command and a reliable verification probe. Scient deliberately does not simulate success for providers whose account or model-provider choice is unresolved.

## Current implementation matrix

| Provider    | Automatic runtime on current macOS arm64 target  | In-app connection                                                           | Remaining release gate                                                                                     |
| ----------- | ------------------------------------------------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Codex       | Yes, pinned official standalone release          | Official browser login and status verification                              | Clean-machine proof on every claimed OS/architecture                                                       |
| Claude      | Yes, pinned native release and manifest checksum | Official Claude.ai browser login and status verification                    | Clean-machine proof and stronger manifest-signature verification if Anthropic publishes a stable mechanism |
| Antigravity | Yes, pinned manifest release                     | Official Google browser login through `agy models`, then model verification | Clean-account authentication proof; other targets need packaged proof                                      |
| Cursor      | Yes, pinned macOS arm64 archive                  | Official browser login and health verification                              | Managed installation is intentionally gated off on other targets until reviewed                            |
| Grok        | Yes, pinned macOS arm64 binary                   | Existing API-key detection; otherwise provider guidance                     | Review a reliable browser-login and non-inference verification flow; review other targets                  |
| Droid       | Yes, pinned native binary and vendor SHA-256     | Existing API-key detection; otherwise provider guidance                     | Review device-pairing supervision and a reliable non-inference auth probe                                  |
| OpenCode    | Yes, pinned official GitHub release              | Provider guidance                                                           | Design a provider-and-method chooser; clean-machine proof on claimed targets                               |
| Kilo        | Yes, pinned official GitHub release              | Provider guidance                                                           | Design Gateway/provider chooser; clean-machine proof on claimed targets                                    |
| Pi          | Bundled; no external CLI is required             | Existing embedded provider configuration                                    | Design the model-provider/OAuth chooser and verified credential presentation                               |

## Product requirements

1. A PATH lookup is discovery only; it is never the installation strategy.
2. No core provider installation may require a package manager, terminal, shell-profile edit, administrator permission, or global PATH change.
3. Resolution order is explicit custom path, healthy system runtime, Scient-managed runtime, bundled runtime, then missing.
4. Installation and authentication are separate states. Scient must not report "Connected" merely because an executable exists.
5. Downloads require explicit user consent and show provider, version, source, and approximate size.
6. Credentials stay in provider-owned storage. Scient must not log or persist passwords, API keys, access tokens, refresh tokens, device codes, or raw authentication output.
7. Every managed install or repair is staged, verified, smoke-tested, and atomically activated. The previous working release remains available for rollback.
8. Cancellation, repair, rollback, and removal are first-class server operations. Dedicated lifecycle controls in Settings are a separate product follow-up; failure recovery remains available through the guided setup flow.
9. Existing custom or system installations are never overwritten, updated, or removed by Scient.
10. Unsupported operating systems or architectures fail clearly and safely; Scient does not install WSL, package managers, Git, or other broad prerequisites automatically.

## Managed runtime model

Managed runtimes live under the server state directory:

```text
provider-runtimes/
  <provider>/
    releases/
      <version>-<target>/
    downloads/
    current.json
```

`current.json` is atomically replaced and records the active release, executable path, verified digest, source URL, installation time, and catalog revision. It is used instead of a symlink so activation behaves consistently on Windows.

Runtime sources are:

- `custom`: an explicit executable selected by the user.
- `system`: a healthy executable found through the inherited environment.
- `managed`: an executable installed and updated by Scient.
- `bundled`: runtime code shipped as part of Scient, currently Pi.
- `missing`: no usable runtime.

## Runtime catalog and trust

The current implementation uses a typed, compiled recipe registry. Each resolved artifact contains provider, pinned version, target, official URL, optional expected byte size, SHA-256 or SHA-512 digest, archive format, executable relative path, smoke-test arguments, and a catalog revision. Recipes reject a vendor's newer unreviewed release instead of silently installing it.

The app accepts only allowlisted HTTPS hosts and exact catalog entries. It never executes a downloaded installer script. Archives are extracted in-process with file-count and expanded-size limits, path traversal rejection, and unsafe-link rejection.

The compiled recipes are trusted as part of the signed Scient application. GitHub recipes read the digest attached to one exact release tag; Claude, Antigravity, and Droid use their vendor manifests or checksum endpoints; Grok and Cursor use reviewed digests pinned in source. This is materially safer than executing an upstream installer script, but it is not yet a separately signed Scient catalog. A future remote catalog must be signed with a dedicated Scient release key, pin complete artifact metadata, and include rollback protection.

Provider release monitoring and catalog-update CI are release follow-ups. They should download each candidate, check upstream evidence, record the digest, smoke-test the executable on its target, and require review before publication. The current code already refuses an unreviewed upstream version where a vendor exposes a moving version endpoint.

## Shared installation lifecycle

The server exposes these states:

```text
idle
resolving
awaiting_consent
downloading
verifying
installing
smoke_testing
installed
opening_browser
waiting_for_auth
verifying_auth
connected
failed
cancelled
```

The installation service must:

1. Serialize mutations per provider.
2. Resolve target and catalog entry.
3. Check destination permissions and disk capacity.
4. Download to a unique staging directory with bounded redirects, timeouts, size, and progress reporting.
5. Verify digest before extraction or execution.
6. Extract safely without external tools.
7. Apply executable permissions where required.
8. Run a bounded version smoke test.
9. Atomically activate the release.
10. Refresh provider health and continue into authentication when requested.
11. Roll back activation when the new runtime fails.
12. Remove staging data on success, cancellation, or failure.

## Provider recipes

### 1. Codex

- Source: official OpenAI standalone release package.
- Targets: official macOS, Linux, and Windows targets.
- Verification now: exact GitHub release tag plus GitHub's SHA-256 asset digest.
- Smoke test: `codex --version`.
- Authentication: `codex login`; fallback `codex login --device-auth`.
- Auth verification: `codex login status`.
- Preserve `CODEX_HOME`; executable updates must not modify conversation, configuration, or credential data.

### 2. Claude

- Source: Anthropic native stable release.
- Verification now: pinned version, exact manifest version/platform entry, and manifest SHA-256.
- Smoke test: `claude --version`.
- Authentication: `claude auth login --claudeai`; Console billing remains an advanced option.
- Auth verification: `claude auth status`.
- Managed updates run through Scient's runtime manager; independent-updater suppression still requires provider-specific release validation.

### 3. Antigravity

- Source: official platform manifest and native artifact.
- Verification now: pinned manifest version and manifest SHA-512.
- Smoke test: `agy --version`.
- Authentication now: the provider-owned `agy models` command triggers browser sign-in when needed and doubles as the post-login model probe.
- Auth verification: `agy models` returns models.
- Release gate: prove that authentication can be observed and the bootstrap process can be terminated cleanly without starting an unintended agent task.

### 4. Grok

- Source: official xAI native stable artifact.
- Verification now: pinned macOS arm64 URL, byte size, and reviewed SHA-256; Scient does not execute the vendor installer script.
- Smoke test: `grok --version`.
- Authentication: `grok login`; fallback `grok login --device-auth`.
- Auth verification: `grok models`.
- Other operating systems and architectures remain safely unsupported until their artifacts and checksums are reviewed.

### 5. Cursor

- Source: official Cursor Agent package.
- Verification now: pinned macOS arm64 URL, byte size, and reviewed SHA-256.
- Smoke test: `cursor-agent --version`.
- Authentication: `cursor-agent login`.
- Auth verification: `cursor-agent status` plus model discovery.
- Windows gate: do not install WSL. Automatic Windows installation remains unavailable until Cursor supports an appropriate native artifact and Scient verifies it end to end; an existing healthy custom/system executable remains usable.

### 6. Droid

- Source: official Factory native artifact and `.sha256`.
- Target selection includes baseline x64 when AVX2 is unavailable.
- Verification now: exact reviewed version and vendor `.sha256`.
- Smoke test: `droid --version`.
- Authentication: supervised first-run device-pairing flow. Scient opens captured URLs itself; a process-local opener shim handles Linux systems without `xdg-open`.
- Auth verification gate: identify a reliable provider-owned, non-inference status probe. Until then, installation may complete but Scient must not claim authentication is verified.
- Never kill externally owned Droid processes during install or update.

### 7. Pi

- Runtime source: `bundled`; no CLI installation.
- Remove the external `pi --version` requirement from provider health.
- Authentication proposal: use Pi SDK OAuth callbacks and credential storage directly.
- Auth verification proposal: validate provider credentials through Pi's auth storage and model registry without exposing secret material.
- An external Pi CLI remains an advanced custom override only.

### 8. OpenCode

- Source: official GitHub release asset selected for OS, architecture, libc, and baseline CPU compatibility.
- Verification now: exact GitHub release tag plus GitHub's SHA-256 asset digest.
- Smoke test: `opencode --version`.
- Authentication: provider chooser followed by `opencode auth login --provider <id> --method <method>`.
- Auth verification: `opencode auth list` and model discovery.
- Optional plugins and their package-manager dependencies are outside the core installation path.
- Native Windows support is released only after packaged clean-machine tests pass; Scient does not install WSL.

### 9. Kilo

- Source: official GitHub release asset selected for OS, architecture, libc, and baseline CPU compatibility.
- Verification now: exact GitHub release tag plus GitHub's SHA-256 asset digest.
- Smoke test: `kilo --version`.
- Authentication: prefer the Kilo Gateway browser-account path, otherwise choose a model provider and run `kilo auth login --provider <id> --method <method>`.
- Auth verification: `kilo auth list` and model discovery.

## Missing optional capabilities

- Missing Git does not block installation, authentication, ordinary projects, or conversations. Git-dependent agent features are described as optional capabilities.
- Missing browser support falls back to device-code login when the provider offers it, with copy-link and copy-code actions.
- Missing `xdg-open`, PowerShell scripts, shell profile, curl, tar, unzip, or checksum utilities is handled inside Scient.
- Offline, proxy, TLS, disk-space, permission, and unsupported-target failures preserve the active runtime and provide actionable recovery.

## Implementation and release phases

1. [x] Add contracts for runtime source, installation state, progress, errors, and operations.
2. [x] Add the typed, pinned provider recipe registry.
3. [x] Implement target detection, safe downloading, hashing, extraction, activation, rollback, and cleanup.
4. [x] Integrate managed runtime resolution into provider health and process startup.
5. [x] Add prepare, install, cancel, repair, rollback, and remove RPCs.
6. [x] Automate reviewed browser authentication for Codex, Claude, Antigravity, and Cursor.
7. [x] Replace installation-guide-first UI with reviewed consent, progress, cancellation, connection, and safe guidance fallbacks.
8. [ ] Add reviewed authentication flows for Grok and Droid and provider-chooser flows for Pi, OpenCode, and Kilo.
9. [ ] Add signed catalog/release-monitoring automation.
10. [ ] Complete packaged clean-machine validation for each released target.

## Verification requirements

### Unit and integration

- Target mapping, runtime precedence, catalog decoding, allowlisted redirects, size limits, digest mismatch, cancellation, archive traversal, unsafe links, atomic activation, rollback, cleanup, and restart recovery.
- Provider recipe argument generation and auth-state parsing.
- Fake HTTPS release server and fake provider executables; routine CI must not depend on live provider releases or real credentials.
- Contract backwards compatibility for existing settings and provider status consumers.

### UI and packaged app

- Missing provider to installed to authenticated to ready.
- Existing authenticated provider skips installation and login.
- Existing unauthenticated provider starts login only.
- Download cancellation, retry, corrupt artifact, unsupported target, offline state, repair, rollback, removal, and custom executable selection.
- Packaged desktop app can write its runtime directory and launch a managed executable.

### Clean-machine release matrix

For every released OS/architecture combination, use a clean VM or clean account with no package manager, Node.js, Git, provider CLI, credentials, or shell customization. Prove installation without administrator permission, provider authentication, a real session, restart persistence, update credential preservation, failed-update rollback, and non-interference with user-managed installations.

## Local implementation evidence

- [x] Shared installation/runtime manager and RPC surface are implemented.
- [x] Resolution precedence preserves explicit custom and healthy system installations before managed runtimes.
- [x] Pi health no longer requires an external CLI.
- [x] Consent, progress, cancellation, safe extraction, digest verification, smoke testing, activation, persistence, repair, rollback, and deferred removal are implemented.
- [x] Managed executable paths stay server-side; credentials and raw login output are not persisted or sent to the renderer.
- [x] Focused contracts, server, web presentation, and browser tests pass.
- [x] Full repository test suite passes locally.
- [x] A real Antigravity artifact completed download, verification, extraction, smoke test, activation, resolution, and persisted-record checks in an isolated state directory.
- [x] Formatting, lint (0 errors), full typecheck, arm64 DMG/ZIP packaging, desktop smoke test, and final real-browser inspection pass.
- [x] The complete isolated UI path passes: missing runtime, reviewed consent, download progress, verified activation, and explicit browser-login handoff.

## Release gates

- [ ] Prove Codex, Claude, Antigravity, and Cursor login with fresh provider accounts in a packaged app.
- [ ] Complete the provider-specific connection work listed in the implementation matrix.
- [ ] Add the signed catalog and reviewed release-monitoring pipeline.
- [ ] Run the clean-machine matrix for every OS/architecture Scient intends to claim.
- [ ] Record platform signing/notarization evidence and confirm managed-runtime updater behavior for each provider.
