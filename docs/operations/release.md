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
- Publication additionally requires the protected `production` environment and
  repository variable `SCIENT_DESKTOP_RELEASES_ENABLED=true`.
- Never publish from an arbitrary branch, an unreviewed commit, or a dirty local
  build.
- Release preflight requires the selected source SHA and the checked-out
  `release/stable` SHA to be identical, not merely tree-equivalent.
- Never rerun the full source test suite merely to reproduce evidence already
  green on the exact source SHA. Release jobs verify that exact CI provenance,
  then perform native build, signing, manifest, checksum, and distribution work.

The first intended migrated release is `v0.6.0`. Selecting that version does
not imply proximity to `v1.0.0`; semantic versions permit any number of patch
and minor releases before the product earns the `1.0.0` contract.

## Production identity and data safety

Production artifacts use product name `Scient`, bundle/application ID
`com.scientfactory.scient`, protocol `scient://`, and the `Scient` artifact
prefix. Those values preserve the legacy updater's ability to replace the
installed application.

The T3-derived app intentionally continues to use its separate `scient-next`
application data directory. Cutover must therefore include an explicit
import/archive/rollback decision; sharing the old directory is not an
acceptable shortcut. `Scient (Dev)` retains its separate identity, protocol,
state, ports, and lifecycle and is never a publication source.

## Release graph

1. Select the exact current `main` SHA after its CI workflow is successful.
2. Manually run **Promote main to release/stable** with that full SHA. Promotion
   fails unless the SHA is current `origin/main`, has successful CI, and can
   fast-forward `release/stable`.
3. Manually run **Scient stable release** from `release/stable` with the exact
   version and promoted SHA. Keep `publish_release=false` for proof and
   `allow_note_free=false` unless Yaacov explicitly accepts a note-free release.
4. Inspect `scient-release-v<version>`. It contains macOS arm64/x64, Linux x64,
   Windows x64, updater manifests, the exact server tarball,
   `SHA256SUMS.txt`, and `scient-release-handoff.json`. Assembly fails unless
   every manifest-referenced payload exists and matches its declared size and
   SHA-512, every required architecture is present, and no unattested file is
   included.
5. Resolve artifact, signing, updater, migration, website, and rollback gates.
   A green build-only run is not a release.
6. Only after explicit approval, rerun the exact source with
   `publish_release=true`. Publication fails closed if macOS or Windows is
   unsigned or the repository release gate is disabled. The workflow stages a
   draft, downloads it again, verifies every uploaded byte against the assembled
   release, and only then makes the release public and Latest. Existing tags or
   releases are never overwritten.
7. In the legacy repository, run **Mirror new Scient release for legacy
   updaters** first with `publish_mirror=false`, inspect the byte-identical
   proof, then explicitly publish it. The old repository never rebuilds the new
   app.
8. Verify the release, fresh downloads, signatures, updater manifests, an
   installed legacy-to-new update, a new-to-new update, and rollback before
   describing the release as accepted.

## Signing configuration

macOS publication requires secrets `CSC_LINK`, `CSC_KEY_PASSWORD`,
`APPLE_API_KEY`, `APPLE_API_KEY_ID`, and `APPLE_API_ISSUER`. The current
cloud-disabled product does not request T3's passkey Associated Domains
entitlement or require its provisioning profile. If Scient later enables that
cloud capability, the profile and relying-party domains become a separate
explicit release requirement.

Windows publication requires Azure Trusted Signing secrets
`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, and
`AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`.

Build-only proof may produce unsigned artifacts when credentials are absent.
It labels them unsigned and cannot publish them.

Release jobs expose Apple credentials only to macOS packaging and Azure
credentials only to Windows packaging. Publication additionally verifies the
final Windows Authenticode signature and the final macOS app signatures,
Gatekeeper assessment, and notarization ticket before the signing attestations
can authorize publication. Release-owned third-party actions and native build
tooling are pinned to reviewed revisions.

## Updater and remote-server distribution

Electron Builder embeds `ScientFactory/scient-desktop-next`. Stable releases
publish `latest*.yml` and their installers/blockmaps. The old compatibility
mirror adds byte-identical `scient*.yml` aliases for installed legacy clients.

Scient does not publish T3's npm package. Each release instead contains
`scient-server-<version>.tgz`. SSH launches and background-service updates use
that immutable GitHub asset at the exact desktop version. The tarball is built
from the same source SHA and includes native resource monitors from the matrix.

## What's New ownership

The release gate dynamically loads the established Scient release-note catalog
and calls `validateScientReleaseNotesCatalog`; it does not define a second
schema. The exact version normally requires an approved entry.
`allow_note_free=true` is an explicit product decision, not a missing-work
fallback.

## Required manual acceptance before first cutover

- macOS Apple Silicon and Intel install, launch, sign, notarize, and update;
- Windows x64 install, SmartScreen/signature, launch, and update;
- Linux AppImage launch and update behavior;
- provider setup and a real Codex/Claude turn on every claimed platform;
- legacy app remains reinstallable and its old data remains intact;
- new-app import behavior is intentional and understood;
- website downloads target the new release and retain a rollback path.

No workflow run substitutes for these product acceptance gates.
