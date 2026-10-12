# Scient Beta releases

Stable and Beta share source, signing identity, installed app identity and saved
data. Users choose their update track in Settings. Existing Stable users remain
on Stable. Beta installers default to Beta. Returning to Stable waits until its
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

## Triggering a Beta

In GitHub Actions, open **Scient desktop release**, choose **Run workflow** from
`main`, select `channel=beta`, and run it. The trigger authorizes the whole Beta
build and publication. There is no later approval or manual publish step.

Leave `version` and `source_sha` blank for the normal path. The workflow pins the
exact `main` commit at dispatch and requires successful CI for that exact commit.
It generates `x.y.z-beta.YYYYMMDD.N` using the UTC date and the next stable patch
core, retaining a higher existing Beta core if one exists. It advances beyond
all existing Beta release versions, including reserved drafts, and increments N
for another candidate on the same date. Beta runs are serialized. An explicit
version or source SHA is permitted, but the version must be newer than Stable
and every existing Beta, and the SHA must equal the dispatched commit.

Beta always publishes, even when `publish_release` is left at its default
`false`; that checkbox controls Stable only. Beta has no What's New catalog
requirement and omits release notes. `allow_note_free` also controls Stable only.
The owner-approved unsigned-Windows exception applies automatically to Beta,
with the Windows signing notice retained in its GitHub release body. macOS
signing and notarization remain mandatory. Stable's publication, notes, signing
exception inputs and protected `production` approval remain unchanged.

Beta is manual rather than scheduled. Release the stable bridge containing the
selector before the first Beta. A Beta must target a core ahead of current
Stable (for example, Stable 0.6.23 then Beta 0.6.24-beta.YYYYMMDD.N). The publisher
rechecks current Stable immediately before uploading, refusing a candidate that
became obsolete during the build. Never replace an existing tag or artifact.

## Environment setup

Configure the source repository's `beta` environment to allow only `main`, with
no required reviewers or wait timer. Keep administrator bypass disabled. Set
`SCIENT_DESKTOP_BETA_RELEASES_ENABLED=true` to enable the automatic lane; set it
to `false` to stop publication. Stable's `production` environment is separate.

Configure secret `SCIENT_BETA_RELEASE_TOKEN` in the `beta` environment with
Contents read/write access to **only** `ScientFactory/scient-desktop-beta`.
The source repository's ordinary `GITHUB_TOKEN` cannot publish into another
repository. Do not reuse the general CLI credential or grant the Beta token
write access to the stable repository. Beta uses the existing repository macOS
signing secrets; no new signing identity is needed. A short Beta-only inventory
job uses this credential before packaging so version generation includes draft
reservations, which GitHub hides from public readers. Stable skips that job.
The old
`SCIENT_DESKTOP_BETA_QUALIFICATION` variable is no longer consumed.

## Automatic checks and acceptance

The release run builds and signs the exact source, validates the complete
updater/server asset set, and runs
`apps/desktop/scripts/qualify-update-channels.cjs` against the locked updater.
That rehearsal checks GitHub channel discovery for all platforms, loopback
download/cache events, checksum rejection and feed switching with synthetic data.
It executes no installer and verifies no native signature. Native signing is
checked separately during packaging; the approved Windows exception remains.

The run retains an immutable candidate for 30 days. Publication verifies its
run, artifact digest, source/tree, distribution identity and all asset hashes.
It stages a draft in the isolated Beta repository, downloads and compares every
uploaded byte, then automatically makes it public as a prerelease with
`latest=false`. It verifies that canonical Stable Latest did not change.
Missing CI, signing failures, invalid assets, failed updater rehearsals, missing
credentials, a disabled publication gate or reused release identities fail the
run instead of publishing. No manual per-candidate receipt is required.

Automatic qualification is not native installation acceptance. For the first
Beta, updater changes, and before promotion to Stable, use disposable machines
and synthetic profiles to exercise stable-to-beta, beta-to-beta,
beta-to-stable and stable isolation on macOS arm64/x64, Windows x64 and Linux
x64 AppImage. Verify signatures/notarization, restart, the local server version,
settings/data preservation, download retry and modified-payload rejection.
Use an isolated test feed for unpublished artifacts and verify final public
manifests and artifact URLs after publication. Do not operate production
profiles to obtain test evidence.

## Promotion and recovery

Beta publication is not authority to release Stable. Use the stable
promotion/release workflow and production approval. The optional `beta_version`
promotion input selects a published Beta's exact source when `main` has advanced:
it verifies the immutable handoff, successful source CI and main ancestry before
the existing fast-forward-only promotion. Without that input, promotion still
requires current main. The stable version must match the tested Beta core and
still needs the normal stable release notes and manual acceptance.

If a Beta is faulty, disable further Beta publication and produce a
higher-version fix from reviewed source. Do not replace a release, move a
published tag, mirror Beta into Stable, or force a downgrade. Users can select
Stable and wait for its forward release. Stable/Beta saved data are shared, so
test migrations forward and use synthetic profiles for rollback experiments.
