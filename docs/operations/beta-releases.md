# Scient Beta releases

Stable and Beta share source, signing identity, installed app identity and saved
data. Users choose their update track in Settings. Existing Stable users remain
on Stable; the next stable release carrying this implementation exposes the
selector. Beta installers default to Beta. Returning to Stable waits until its
version is at least as new as the installed Beta; automatic downgrades are off.
Legacy Nightly preferences migrate to Stable, preserving unrelated settings.

## Distribution boundaries

| Channel | Workflow branch  | Artifact repository                 | Manifests     | Publication environment |
| ------- | ---------------- | ----------------------------------- | ------------- | ----------------------- |
| Stable  | `release/stable` | `ScientFactory/scient-desktop`      | `latest*.yml` | `production`            |
| Beta    | `main`           | `ScientFactory/scient-desktop-beta` | `beta*.yml`   | `beta`                  |

Never put Beta tags or releases in the stable repository. Previously installed
CLI/mobile clients can classify an unfamiliar prerelease as stable. A separate
repository protects those clients as well as the desktop updater. New clients
also reject all prereleases from Stable discovery. Beta server packages and
release-note links resolve to the Beta repository.

The artifact repository has no source checkout or build workflow. Its tag points
at its own default branch. `scient-release-handoff.json` records the canonical
source repository, exact source commit/tree, distribution channel/repository and
asset hashes. Never substitute the artifact repository's tag SHA for source
provenance. Stable tags continue to point at their exact source SHA.

## Preparing a candidate

Release the stable bridge containing the selector first. The first Beta then
uses a higher target core than that bridge release (for example, bridge 0.6.23
then Beta 0.6.24-beta.YYYYMMDD.N). The publisher rechecks current Stable after
approval, so a candidate that became obsolete while awaiting review is refused.

Start with a reviewed `main` commit with successful exact-commit CI. Dispatch
`release.yml` from `main`, select `channel=beta`, and supply that exact commit.
Use a target stable version greater than current Stable, followed by
`-beta.YYYYMMDD.N`, for example `0.6.24-beta.20261010.1`. Increment N for another
candidate; each Beta must also be newer than the last published Beta. Never
replace an existing tag or uploaded artifact.

The channel is independent of cadence. Beta is manual initially, allowing a
candidate when testing is useful. The existing stable scheduler is unchanged.

The default `publish_release=false` assembles an unsigned build proof without
creating a release. A publishable run (`publish_release=true`) builds signed
macOS candidates and applies the existing explicit Windows signing exception.
It retains the immutable candidate for 30 days and waits for environment
approval. Download and test that exact artifact; never rebuild it after testing.
Beta uses the approved catalog entry for its target stable core. Release notes
still need explicit approval through the release catalog or the
existing `allow_note_free` decision.

The `beta` environment must allow only `main`, require the accountable owner's
review and disallow administrator bypass. Keep
`SCIENT_DESKTOP_BETA_RELEASES_ENABLED=false` until qualification is complete.
Configure `SCIENT_BETA_RELEASE_TOKEN` there with Contents read/write access to
**only** the Beta artifact repository. The source repository's ordinary
`GITHUB_TOKEN` cannot publish into another repository. Do not reuse the general
CLI credential or grant the Beta token write access to the stable repository.
Beta uses the existing repository signing secrets; no new signing identity is
needed.

## Update qualification before publication

Run the local full gate from `AGENTS.md`. The desktop test suite runs
`apps/desktop/scripts/qualify-update-channels.cjs` against the locked updater.
That rehearsal exercises GitHub channel selection for all three platforms,
loopback download/cache events, checksum rejection and feed switching using
synthetic data. It executes no installer and verifies no native signature.

Before approving publication, use disposable machines/profiles and the exact
retained candidate to verify:

1. **stable-to-beta:** the stable bridge release exposes the selector; choosing
   Beta checks its isolated feed, downloads the candidate and restarts into the
   expected Beta version. The persisted channel survives restart.
2. **beta-to-beta:** an enrolled Beta receives a newer Beta, downloads and
   restarts; a current Beta has no update and never regresses to an older Beta.
3. **beta-to-stable:** selecting Stable while it is older offers no downgrade;
   publishing the matching stable core offers the stable upgrade and preserves
   the user's Stable choice after restart.
4. **stable-isolation:** an unenrolled bridge installation and an older stable
   installation continue to resolve only Stable while Beta is available. The
   canonical latest release and stable download page remain unchanged.

Exercise installation/restart on macOS arm64, macOS x64, Windows x64 and Linux
x64 AppImage. Confirm native signature/notarization requirements, updated local
server version, data and settings preservation, retry after failed download,
and rejection of a modified payload. Use approved synthetic fixtures and an
isolated test feed for unpublished artifacts. The generic mock server can serve
`beta*.yml` and `latest*.yml`; pass the existing mock-update configuration only
to disposable packaged test copies. Keep this native rehearsal distinct from
the GitHub-provider integration test and verify final artifact URLs after
publication. Do not operate a production profile to obtain these receipts.

Save evidence URLs for every path and platform, then set the environment
variable `SCIENT_DESKTOP_BETA_QUALIFICATION` to the following JSON shape. Each
receipt must identify the source, artifact digest, fixture/feed and observed
installed versions. Do not mark a path passed based on mocked events.

```json
{
  "sourceSha": "<exact source SHA>",
  "version": "0.6.24-beta.20261010.1",
  "artifactDigest": "sha256:<GitHub candidate digest>",
  "paths": [
    { "name": "stable-to-beta", "passed": true, "receipt": "https://<evidence>" },
    { "name": "beta-to-beta", "passed": true, "receipt": "https://<evidence>" },
    { "name": "beta-to-stable", "passed": true, "receipt": "https://<evidence>" },
    { "name": "stable-isolation", "passed": true, "receipt": "https://<evidence>" }
  ],
  "platforms": [
    { "name": "mac-arm64", "passed": true, "receipt": "https://<evidence>" },
    { "name": "mac-x64", "passed": true, "receipt": "https://<evidence>" },
    { "name": "windows-x64", "passed": true, "receipt": "https://<evidence>" },
    { "name": "linux-x64", "passed": true, "receipt": "https://<evidence>" }
  ]
}
```

The publisher checks the receipt identity against this run's immutable artifact
digest and refuses missing, stale or incomplete qualification. Set the Beta
enable variable to `true` only after review, then approve that same pending run.
Beta is published as a prerelease with `latest=false`; the publisher downloads
the staged draft and compares every byte before making it public, then verifies
that canonical Stable Latest did not change. Verify public manifests, asset
downloads and the updater against the published feed afterward.

## Promotion and recovery

Beta acceptance is evidence for a stable source, not authority to release it.
Use the stable promotion/release workflow and production approval. The optional
`beta_version` promotion input permits the exact published Beta source when
`main` has advanced: it verifies Beta's immutable handoff, successful source CI
and main ancestry before the existing fast-forward-only promotion. Without that
input, promotion still requires current main. The stable version must match the
tested Beta's core; source release notes still need normal stable approval.

If a Beta is faulty, stop further Beta publication and produce a higher-version
fix from reviewed source. Do not replace a release, move a published tag, mirror
Beta into Stable, or force a downgrade. Users can select Stable and wait for its
forward release. Stable/Beta saved data are shared, so test migrations forward
and use synthetic profiles for rollback experiments.
