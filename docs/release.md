# Release Checklist

This document covers build-only native validation, promotion through the protected
`release/stable` branch, and publishing desktop releases from one exact commit.

## What the workflow does

- Triggers:
  - Manual dispatch from any branch defaults to build-only validation and uploads workflow artifacts without publishing anything.
  - A pushed tag matching `v*.*.*` publishes only when the tag points to the exact head of `release/stable`.
  - Manual publication requires `publish_release=true` from the exact head of `release/stable`.
- Runs quality gates first: lint, typecheck, test.
- Builds four artifacts in parallel:
  - macOS `arm64` DMG
  - macOS `x64` DMG
  - Linux `x64` AppImage
  - Windows `x64` NSIS installer
- Publishes one versioned GitHub Release with all produced files.
  - Versions with a suffix after `X.Y.Z` (for example `1.2.3-alpha.1`) are published as GitHub prereleases.
  - Stable 0.5.x releases are GitHub Latest; the 0.4.x compatibility release remains historical.
- Publishes default `latest*.yml` metadata plus byte-identical `scient*.yml` aliases on every stable release.
- Keeps the historical 0.4.x compatibility release unchanged; current stable payloads stay on their own GitHub Latest release.
- Publishes prerelease installers only on their versioned GitHub prerelease; prereleases never replace the stable `scient` update manifests.
- Publishes the CLI package (`apps/server`, npm package `@scientfactory/cli`, executable `scient`) with OIDC trusted publishing when `SCIENT_PUBLISH_CLI=1`.
- Build-only runs auto-detect signing credentials and may produce unsigned validation artifacts.
- Public macOS releases always fail closed unless signing and notarization credentials are complete. A manual dispatch may explicitly allow only an unsigned Windows early-access installer.

## Desktop auto-update notes

- Runtime updater: `electron-updater` in `apps/desktop/src/main.ts`.
- Client update checks are enabled in packaged production builds by `SCIENT_DESKTOP_UPDATES_ENABLED = true`. Development builds, unpackaged builds, builds without `app-update.yml`, Linux builds not running as an AppImage, and installations with `SYNARA_DISABLE_AUTO_UPDATE=1` remain disabled.
- Linux AppImage launch is fail-closed: release packaging removes electron-builder's
  automatic `--no-sandbox` fallback. A host must provide working unprivileged user
  namespaces or a correctly configured Chromium sandbox helper; Scient never trades
  sandboxing for startup compatibility.
- `v0.5.6` was published with client update checks disabled. Existing `v0.5.6`
  installations therefore require one manual installation of the first
  updater-enabled release; the application cannot remotely enable code that is
  compiled off. Releases after that bootstrap can use the in-app update flow.
- Update UX:
  - Background checks run on startup delay + interval.
  - New updates are prepared/downloaded in the background after detection; install/restart stays manual.
  - The desktop UI shows a rocket update button while preparing and switches to an install action once the update is ready.
- Provider: GitHub Releases (`provider: github`) configured at build time.
- Repository visibility: public. The authenticated private-repository provider does not honor custom channel filenames.
- Runtime channel: `scient`. Stable releases publish both `latest` and `scient` metadata; the configured 0.4.x compatibility release remains available for historical migration.
- Repository slug source:
  - `SCIENT_DESKTOP_UPDATE_REPOSITORY` (format `owner/repo`) is required when releases are enabled.
  - The workflow requires it to equal the current GitHub repository and requires that repository to be public.
- Required Scient release assets for updater:
  - platform installers (`.exe`, `.dmg`, `.AppImage`, plus macOS `.zip` for Squirrel.Mac update payloads)
  - `scient-mac.yml`, `scient.yml`, and `scient-linux.yml` metadata
  - every stable release includes both `scient-mac.yml`, `scient.yml`, `scient-linux.yml` and `latest-mac.yml`, `latest.yml`, `latest-linux.yml`
  - `*.blockmap` files, except the macOS update `.zip.blockmap` removed after zip repack
- Enforced upgrade path:
  - Stable clean Scient releases are created with `make_latest=true` and carry both six-manifest filenames in the versioned release.
  - The historical 0.4.x compatibility release remains available for predecessor migration and is never overwritten by a 0.5.x release.
  - Clean releases do not mirror payloads onto the historical compatibility release, so the 0.4.x line remains immutable.
  - Clean-release publication fails closed if either the default Latest manifests or the dedicated `scient` aliases are missing.
- Production desktop builds omit web/server/desktop source maps by default to keep update payloads small. Set the inherited `SYNARA_WEB_SOURCEMAP=1` or `SYNARA_SERVER_SOURCEMAP=1`, or the Scient-owned `SCIENT_DESKTOP_SOURCEMAP=1`, only for a diagnostic release that needs them.
- macOS metadata note:
  - The build initially emits `latest-mac.yml` for both Intel and Apple Silicon.
  - The workflow merges the per-arch macOS metadata, then keeps the merged manifest as `latest-mac.yml` and copies it to `scient-mac.yml` for stable releases.
  - Local unsigned validation builds receive a complete ad-hoc signature. Public
    builds use the stable Developer ID identity, a dedicated minimal AppSnap
    signature, controlled notarization, and stapling. The notarization hook
    captures Apple's submission ID immediately, polls for up to 90 minutes,
    preserves Apple's completed log, and writes architecture-specific evidence
    even when the build fails. The build then repacks the macOS update `.zip`
    with `ditto`, verifies Electron framework symlinks and both source/extracted
    app signatures, validates the app inside the final DMG, patches the matching
    `latest-mac*.yml` hash/size, and removes the stale `.zip.blockmap`.
  - macOS updater downloads intentionally use the full zip payload so Squirrel.Mac installs the exact signed archive validated by release build.
- Local smoke test:
  - Run `bun run release:smoke:mac-update -- --skip-build --build-version 0.1.5` on macOS after local desktop/server/web dist files exist.
  - The smoke builds a mock update artifact, validates manifest hash/size, serves a HEAD-only local endpoint, confirms the manifest and zip are addressable without downloading the zip body, then cleans up its temp output.
  - Boolean env flags for release scripts accept `true/false`, `1/0`, `yes/no`, and `on/off`; CLI flags are still preferred for repeatable local commands.

## 0) npm OIDC trusted publishing setup (CLI)

The workflow publishes the CLI with `bun publish` from `apps/server` after bumping
the package version to the release tag version.

Checklist:

1. Confirm the npm account controls the `@scientfactory` scope and can publish `@scientfactory/cli`.
2. In npm package settings, configure Trusted Publisher:
   - Provider: GitHub Actions
   - Repository: this repo
   - Workflow file: `.github/workflows/release.yml`
   - Environment (if used): match your npm trusted publishing config
3. Ensure npm account and org policies allow trusted publishing for the package.
4. Create release tag `vX.Y.Z` and push; workflow will:
   - set `apps/server/package.json` version to `X.Y.Z`
   - build web + server
   - run `bun publish --access public`

## Scient release controls

- `release/stable` is the protected public-release pointer. It starts at the exact
  commit shipped as `v0.5.6` and advances only through a promotion PR.
- Ordinary development remains on `main`. Merging or pushing to `main` cannot
  publish a release and cannot update installed apps.
- Publication preflight fetches `release/stable` and requires `github.sha` to
  equal its exact head for both version-tag pushes and manual publication.
- Set `SCIENT_DESKTOP_RELEASES_ENABLED=true` only after `SCIENT_DESKTOP_UPDATE_REPOSITORY=ScientFactory/scient-desktop` is configured and the release candidate is ready for native CI validation.
- The desktop updater expects the pinned compatibility release in this repository to include the generated updater metadata files, not just the installers.
- The published release title should read `Scient vX.Y.Z`.
- By default, the first-party desktop release path does not require CLI publish or post-release version-bump automation.
- Optional jobs stay disabled unless repository variables enable them:
  - `SCIENT_PUBLISH_CLI=1`
  - `SCIENT_FINALIZE_RELEASE=1`

## Prepare the in-app release note

Every release candidate must include one Scient-owned, user-friendly entry in
`apps/web/src/whatsNew/entries.json` whose version exactly matches the candidate.
The release workflow fails before native builds when that entry is absent,
malformed, duplicated, or names a different stable or prerelease version.

The release owner prepares and approves the entry before promotion:

1. List only improvements that are present and verified in the exact candidate.
2. Write a short, benefit-led headline for the small sidebar card.
3. Add normally three to five highlights (one is acceptable for a focused hotfix).
   Explain what became easier, clearer, safer, or more reliable for the user.
4. Keep the language warm, concise, and nontechnical. Do not mention commits,
   pull requests, frameworks, internal components, protocols, migrations, or
   implementation details.
5. Add only Scient-owned artwork. Pair every image with useful alt text, and
   verify the image at normal, minimum, mobile, and short-height layouts.
6. Have the product owner approve the claims, order, and wording. This human
   review is the authority for tone and accuracy; automated checks cannot infer it.
7. Run `bun run release:notes:check -- X.Y.Z` and commit the approved entry with
   the candidate before opening the promotion PR.

Acceptance on a packaged upgrade must prove all of the following:

- A clean first installation stays quiet.
- After upgrading, the small branded card appears inline above Activity and
  Settings only once for that release; it never opens the larger dialog by itself.
- A hidden desktop sidebar or closed mobile drawer does not consume the one-time
  presentation. The marker advances only when the card is genuinely visible.
- The card never overlaps or blocks Activity, Settings, or the update control.
- Opening it shows the matching version, date, approved highlights, and release
  history. Keyboard focus, Escape, close, reduced motion, and screen-reader labels work.
- Dismissing or ignoring the visible card prevents it from returning on the next launch.
- The previous packaged release can update to the candidate and see this exact note.

Release history remains available from the release-note dialog. A permanent
Settings entry may be added when the settings information architecture has an
approved location; its absence does not weaken the release gate above.

## 1) Promote and validate a release candidate

Use this before publication to validate the exact protected-branch commit on the
real native macOS, Linux, and Windows build matrix. Build-only mode does not
create a tag, GitHub Release, npm package, updater manifest, or version-bump commit.

1. Make sure the intended source commit is merged and green on `main`.
2. Open a promotion PR from `main` into `release/stable` and merge it only after
   the protected branch checks pass.
3. Start the workflow against the promoted branch in build-only mode:
   - `gh workflow run release.yml --ref release/stable -f version=X.Y.Z -f publish_release=false`
4. Wait for `.github/workflows/release.yml` to finish.
5. Confirm preflight and all four native matrix builds pass.
6. Download the workflow artifacts and sanity-check installation on each OS.
7. For an updater activation or updater change, install the candidate and verify
   check, background download, visible Update action, restart/install, and
   post-restart version/state continuity before publication.
8. For the first updater-enabled release, verify both the one-time manual upgrade
   from `v0.5.6` and an automatic update from that candidate to a higher mock or
   prerelease version.

To publish from a manual dispatch instead of a tag push, dispatch the exact
`release/stable` head with `publish_release=true`. The workflow rejects
publication from every other ref or commit.

### Temporary unsigned Windows early-access publication

When signing credentials are unavailable, a manual dispatch from the exact
`release/stable` head may set both `publish_release=true` and
`allow_unsigned_release=true`. This option is unavailable to tag-triggered
publication and never weakens the default signed-release gate.

The override applies only to Windows:

- Windows keeps the normal in-app NSIS update handoff. Windows may show an
  Unknown Publisher or SmartScreen warning before installation continues.
- macOS publication still requires a Developer ID signature, successful
  notarization, a stapled ticket, and final artifact verification. There is no
  unsigned public macOS lane because ad-hoc releases do not retain a stable
  privacy identity across updates.
- Linux keeps the existing AppImage behavior and is unaffected by the override.

Never enable unsigned publication while a platform has a partial signing-secret
configuration. Remove incomplete secrets or finish the signing setup first.

## 2) Apple signing + notarization setup (macOS)

Required secrets used by the workflow:

- `CSC_LINK`
- `CSC_KEY_PASSWORD`
- `APPLE_API_KEY`
- `APPLE_API_KEY_ID`
- `APPLE_API_ISSUER`

Checklist:

1. Apple Developer account access:
   - Team has rights to create Developer ID certificates.
2. Create `Developer ID Application` certificate.
3. Export certificate + private key as `.p12` from Keychain.
4. Base64-encode the `.p12` and store as `CSC_LINK`.
5. Store the `.p12` export password as `CSC_KEY_PASSWORD`.
6. In App Store Connect, create an API key (Team key).
7. Add API key values:
   - `APPLE_API_KEY`: contents of the downloaded `.p8`
   - `APPLE_API_KEY_ID`: Key ID
   - `APPLE_API_ISSUER`: Issuer ID
8. Re-run a tag release and confirm macOS artifacts are signed, notarized, and
   stapled. The macOS jobs allow up to 120 minutes for Apple service delays;
   Linux and Windows remain capped at 30 minutes.
9. Download the `notarization-<arch>` workflow artifacts and confirm each
   evidence file records an Apple submission ID, `Accepted` status, Developer ID
   Team ID, successful stapling, Gatekeeper acceptance, and the corresponding
   Apple notarization log.
10. For publishing runs, confirm both `Verify published macOS` jobs downloaded
    the public DMGs and updater ZIPs, matched them against `SHA256SUMS.txt`, and
    re-ran Developer ID, nested-helper identity, stapling, and Gatekeeper checks
    against the extracted delivered copies. Release finalization waits for these
    checks.

Notes:

- `APPLE_API_KEY` is stored as raw key text in secrets.
- The workflow writes it with owner-only permissions to a temporary
  `AuthKey_<id>.p8` file at runtime and removes the file when the build exits.
- The custom notarization workflow deliberately disables electron-builder's
  opaque automatic `submit --wait` integration. A submission timeout is
  recovered from `notarytool history` when Apple accepted the uniquely named
  archive but the runner lost the response; the entire app build is never
  retried automatically after notarization starts.

## 3) Windows signing setup

Public releases require exactly one complete Windows signing provider by default.
Build-only validation may continue with an unsigned NSIS installer when neither
provider is configured; a deliberate unsigned early-access dispatch may publish
that installer with its operating-system warning.

### Option A: standard Authenticode certificate

This path supports an OV/EV code-signing certificate accepted by electron-builder.
Add both secrets:

- `WIN_CSC_LINK`: a base64-encoded certificate file, local file path, or supported URL
- `WIN_CSC_KEY_PASSWORD`: the certificate password

Use this option for a certificate from a generally available CA or compatible
managed signing service. Confirm the resulting `.exe` has a valid Authenticode
signature before publication.

### Option B: Azure Trusted Signing

Azure signing is enabled only when all of the following secrets are present:

- `AZURE_TENANT_ID`
- `AZURE_CLIENT_ID`
- `AZURE_CLIENT_SECRET`
- `AZURE_TRUSTED_SIGNING_ENDPOINT`
- `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`
- `AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`
- `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`

Azure signing checklist:

1. Create Azure Trusted Signing account and certificate profile.
2. Record ATS values:
   - Endpoint
   - Account name
   - Certificate profile name
   - Publisher name
3. Create/choose an Entra app registration (service principal).
4. Grant service principal permissions required by Trusted Signing.
5. Create a client secret for the service principal.
6. Add Azure secrets listed above in GitHub Actions secrets.
7. Re-run a build-only workflow and confirm the Windows installer is signed.

Do not mix the standard certificate and Azure secrets. Partial or conflicting
configuration remains unsigned in build-only mode and fails public publication.
If Windows signing is not yet configured, leave all provider secrets absent and
use build-only validation by default or the explicit unsigned early-access lane.

## 4) Ongoing release checklist

1. Ensure `main` is green in CI.
2. Promote `main` to `release/stable` through a protected PR.
3. Run build-only native validation for the exact `release/stable` head and version.
4. Install and smoke-test the produced artifacts; updater changes require the full check/download/button/install/restart path.
5. Confirm all required Apple secrets and exactly one Windows signing provider are configured before publication.
6. Confirm `gh api repos/OWNER/REPO/releases/latest --jq .tag_name` returns the current stable release.
7. Either create and push `vX.Y.Z` at the exact `release/stable` head or manually dispatch that branch with `publish_release=true`.
8. Verify workflow steps:
   - preflight passes
   - all matrix builds pass
   - release job uploads expected files
9. Confirm a stable release is GitHub Latest and contains the new payloads plus all three `scient` manifests; prereleases must not replace Latest.
10. From an installed previous version, verify detection, background preparation,
    the Update button, confirmed install/restart, and post-restart continuity.

## 5) Troubleshooting

- macOS build unsigned when expected signed:
  - Check all Apple secrets are populated and non-empty.
- Windows build unsigned when expected signed:
  - Check both standard certificate secrets or all Azure secrets are populated and non-empty.
  - Ensure secrets from the unused Windows provider are absent.
- Build fails with signing error:
  - Use a build-only run while credentials are incomplete; public release runs intentionally fail closed.
  - Re-check certificate/profile names and tenant/client credentials.
