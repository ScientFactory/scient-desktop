# Scient desktop release runbook

This runbook describes release machinery. It does not authorize a release.
Observed source, promoted source, packaged artifacts, signed artifacts,
published artifacts, installed updates, and accepted migration behavior are
separate states and must be reported separately.

## Authority and invariants

- `main` is the reviewed integration branch.
- `release/stable` contains an exact commit already present on `main`; promotion
  creates no commit and changes no tree.
- `.github/workflows/promote-release.yml` is the only normal promotion path.
- `.github/workflows/release.yml` is manual-only. Its default is a build-only
  proof and creates no tag or release.
- `.github/workflows/scheduled-stable-candidate.yml` may dispatch those two
  guarded workflows at 03:00 Asia/Jerusalem, but it has no direct publication
  or branch-write authority. The existing promotion and production gates remain
  authoritative.
- Publication additionally requires the protected `production` environment and
  repository variable `SCIENT_DESKTOP_RELEASES_ENABLED=true`.
- Never publish from an arbitrary branch, an unreviewed commit, or a dirty local
  build.
- Release preflight requires the selected source SHA and the checked-out
  `release/stable` SHA to be identical, not merely tree-equivalent.
- Never rerun the full source test suite merely to reproduce evidence already
  green on the exact source SHA. Release jobs verify that exact CI provenance,
  then perform native build, signing, manifest, checksum, and distribution work.

Release versions follow the current stable line. A version does not imply
proximity to `v1.0.0`; semantic versions permit any number of patch and minor
releases before the product earns the `1.0.0` contract.

## Production identity and data safety

Production artifacts use product name `Scient`, bundle/application ID
`com.scientfactory.scient`, protocol `scient://`, and the `Scient` artifact
prefix. Those values are the current supported installation identity.

The app intentionally continues to use its established `scient-next`
application data directory. That name is a compatibility value rather than
product branding; changing it requires a separate versioned data migration.
`Scient (Dev)` retains its separate identity, protocol, state, ports, and
lifecycle and is never a publication source.

## Release graph

### Scheduled candidate path

At 03:00 Asia/Jerusalem, the scheduled candidate workflow checks current
`main`. It does nothing when `main` is already the source of the Latest stable
release or another stable candidate is active or awaiting approval. Otherwise
it requires successful CI for the exact current `main` commit, derives the next
patch version from the Latest stable tag (`v0.6.2` becomes `v0.6.3`), and
requires an approved What's New entry for that exact version.

After those checks, it invokes the normal exact-commit promotion and starts the
normal release workflow with `publish_release=true`, `allow_note_free=false`,
and the currently approved unsigned-Windows exception. The release workflow
builds, signs, assembles, and attests one immutable candidate, then stops at the
protected `production` environment. Only Yaacov is configured as its required
reviewer. Approval publishes those exact accepted bytes as the public Latest
release; rejection, cancellation, or no decision publishes nothing.

The schedule uses GitHub's named-time-zone support with `Asia/Jerusalem`, so it
remains at local 03:00 across daylight-saving changes. A manual invocation
defaults to a dry run that validates version, notes, and exact-main CI without
promoting a branch or starting release builds.

If a candidate is still awaiting a decision the following night, the scheduler
does not replace it. Approve, reject, or cancel that run first, then manually
rerun the scheduler or wait for the next 03:00 cycle. The scheduler fails closed
when current-main CI is missing or unsuccessful, the next release note is not
approved, the stable tag history is inconsistent, promotion fails, or a target
tag or release already exists.

### Manual path

1. Select the exact current `main` SHA after its CI workflow is successful.
2. Manually run **Promote main to release/stable** with that full SHA. Promotion
   fails unless the SHA is current `origin/main`, has successful CI, and can
   fast-forward `release/stable`.
3. Manually run **Scient stable release** from `release/stable` with the exact
   version and promoted SHA. For a real release candidate, select
   `publish_release=true`; this builds and assembles the candidate but does not
   publish it until the protected `production` job is separately approved. Use
   `publish_release=false` only for a non-publishing machinery rehearsal, not as
   the candidate for a later rebuilt publication. Keep `allow_note_free=false`
   unless Yaacov explicitly accepts a note-free release.
4. Wait for assembly, then inspect the `scient-release-v<version>` artifact from
   that same pending workflow run. It contains macOS arm64/x64, Linux x64,
   Windows x64, updater manifests, the exact server tarball,
   `SHA256SUMS.txt`, and `scient-release-handoff.json`. Assembly fails unless
   every manifest-referenced payload exists and matches its declared size and
   SHA-512, every required architecture is present, and no unattested file is
   included. Record the run ID, artifact ID, and artifact digest shown in its
   summary.
5. Resolve artifact, signing, installed-app, updater, migration, website, and
   rollback gates against that exact candidate. Reject the pending production
   deployment if any gate fails; fix the source and build a new candidate rather
   than approving or rebuilding the rejected bytes.
6. Only after explicit acceptance, approve the pending `production` deployment
   in the same workflow run. Publication fails closed if macOS is unsigned or
   the repository release gate is disabled. Windows is also required to be
   signed unless the operator explicitly set `allow_unsigned_windows=true` when
   creating the candidate; that exception is recorded in the release body and
   may trigger an Unknown Publisher or SmartScreen warning. The workflow
   publishes the already accepted assembled artifact, downloads the draft again,
   verifies every uploaded byte, and only then makes the release public and
   Latest. Existing tags or releases are never rebuilt, overwritten, or
   repurposed.
7. Verify the release, fresh downloads, signatures, updater manifests, an
   installed current-to-new update, a clean install, and rollback before
   describing the release as accepted. Automatic migration from the retired
   Synara-derived application is intentionally unsupported.

## Signing configuration

macOS publication requires secrets `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. The current
cloud-disabled product does not request T3's passkey Associated Domains
entitlement or require its provisioning profile. If Scient later enables that
cloud capability, the profile and relying-party domains become a separate
explicit release requirement.

Normal Windows publication requires Azure Trusted Signing secrets
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and
`AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.

Build-only proof may produce unsigned artifacts when credentials are absent.
It labels them unsigned and cannot publish them unless the explicit
`allow_unsigned_windows=true` publication exception is selected. That exception
applies only to Windows; macOS signing and notarization remain mandatory.

Release jobs expose Apple credentials only to macOS packaging and Azure
credentials only to Windows packaging. Publication additionally verifies the
final Windows Authenticode signature and the final macOS app signatures,
Gatekeeper assessment, and notarization ticket before the signing attestations
can authorize publication. Release-owned third-party actions and native build
tooling are pinned to reviewed revisions.

## Updater and remote-server distribution

Electron Builder derives the active GitHub repository from the release run.
Stable releases publish `latest*.yml` and their installers/blockmaps from
`ScientFactory/scient-desktop`.

Scient does not publish T3's npm package. Each release instead contains
`scient-server-<version>.tgz`. SSH launches and background-service updates use
that immutable GitHub asset at the exact desktop version. The tarball is built
from the same source SHA and includes native resource monitors from the matrix.

## What's New ownership

The release gate dynamically loads the established Scient release-note catalog
and calls `validateScientReleaseNotesCatalog`; it does not define a second
schema. The exact version normally requires an approved entry, and the
publisher renders that same approved entry as the GitHub release body rather
than generating a noisy changelog from inherited T3 history.
`allow_note_free=true` is an explicit product decision, not a missing-work
fallback.

## Required manual acceptance

The historical non-destructive old-app-to-new-app rehearsal is documented in
the [v0.6.0 migration rehearsal](./v060-migration-rehearsal.md). Current
releases require current-to-new update and clean-install evidence; they do not
authorize copying or deleting an old SQLite database.

- macOS Apple Silicon and Intel install, launch, sign, notarize, and update;
- Windows x64 install, SmartScreen/signature, launch, and update;
- Linux AppImage launch and update behavior;
- provider setup and a real Codex/Claude turn on every claimed platform;
- current installed app updates without relocating its data;
- retired-app data remains intact unless separately archived or deleted;
- website downloads target the new release and retain a rollback path.

No workflow run substitutes for these product acceptance gates.
