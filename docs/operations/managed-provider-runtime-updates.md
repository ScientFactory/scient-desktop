# Managed provider runtime updates

This runbook owns release discovery and publication for the qualified provider
runtimes that Scient can install privately. It does not own provider login,
runtime selection, download/extraction policy, local install/update/repair/remove
transactions, or system/custom installations. Those remain in the
[provider lifecycle architecture](../internals/provider-lifecycle.md) and
`@scientfactory/provider-runtime`.

## What is published

`automation/managed-runtime-catalog-v1` is a generated data branch. Its
`apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json` file is
the remote last-known-good catalog read by released apps. `main` keeps the
catalog bundled with each app release as the offline and minimum fallback.

The generated branch may change only immutable release facts for an existing
app-approved provider and target: version, artifact name, HTTPS URL, checksum,
and byte size. The app and CI both re-apply policy compiled on `main`; the branch
cannot introduce a provider or target, change extraction or smoke behavior,
widen an allowed host or path family, or increase a support tier.

## Automated path

`managed-provider-runtime-updates.yml` runs every two hours and may also be
started manually. It invokes `managed-provider-runtime-update-provider.yml`
once for each of Codex, Claude, legacy Antigravity, official Antigravity ACP, Cursor, Droid, and
Grok. The seven release-family runs are intentionally independent:

1. Read the latest generated catalog, or the bundled catalog before the branch
   exists.
2. Read only that provider's official stable pointer.
3. If the version is newer, collect complete immutable metadata for every
   app-approved target.
4. Exercise the normal managed-runtime engine on hosted macOS Apple-silicon,
   macOS Intel, Linux x64, and Windows x64 runners. Each runner downloads,
   verifies, materializes, checks package contents, smoke-tests, activates, and
   removes its native artifact in a temporary private root.
   Official Antigravity ACP uses T3's paired-executable installer instead of the generic
   runtime engine. Its five runners cover Apple-silicon macOS, Linux x64/ARM64, and Windows
   x64/ARM64; no ACP artifact exists for Intel macOS. Its qualification initializes the
   actual agent without authentication, then checks activation and removal.
5. Serialize publication, re-read the latest generated catalog, validate both
   inputs against policy on the immutable discovery commit, and merge only the
   provider that passed.
6. Confirm that current `main` still descends from the discovery commit and that
   managed-runtime policy, discovery, qualification, and publication code did
   not change while the candidate was running. Unrelated `main` changes do not
   block publication; relevant changes require a fresh run.
7. Publish with a normal fast-forward push using the release GitHub App.

A failed provider is red in its own matrix entry and does not stop other
providers. Failed discovery, incomplete metadata, a failed native check, a
downgrade, a same-version repack, or a publication race leaves the current
catalog untouched. The workflow never force-pushes and never opens a catalog PR,
so an unrelated monorepo test cannot suppress a qualified provider update.

Before a Scient app release, snapshot the latest generated catalog into the
bundled catalog on `main` and run its focused policy tests. Live update
availability does not wait for this snapshot, but it keeps a newly installed app
close to the current qualified floor before its first network refresh.

## App behavior

Released apps start a non-blocking catalog refresh with the server, use ETags,
and revalidate at most hourly after a successful fetch. A failed attempt is
eligible for retry after five minutes. The atomic disk cache and bundled catalog
keep the provider screens available while offline. Disabling **Provider update
checks** prevents network refresh; re-enabling it asks for an immediate refresh.

When one provider entry changes, Scient recomputes only that provider's managed
runtime summary. It does not reload provider processes, interrupt sessions,
change credentials, switch runtime sources, or install anything. If the active
source is an older healthy Scient-managed runtime, the existing **Update** action
appears. The user still opens the plan and confirms the transaction, and the
local machine independently repeats integrity, package, smoke, and atomic
activation checks.

## Credentials and branch authority

The existing release GitHub App needs only repository **Contents: read and
write** for publication. The scheduler's default token remains read-only. Do
not add pull-request, Actions, administration, or secrets permissions for this
workflow.

Treat the generated branch as automation-owned during normal operation. Do not
hand-edit or force-push it. A routine correction must first be encoded in
discovery, policy, or validation on `main`, then qualified through the same
workflow. If the branch is deleted, the next successful provider run recreates
it from its immutable `main` source and the bundled catalog; until every provider
runs again, previously published releases may remain unavailable to fresh apps.

## Operating and recovery

- Open **Actions > Promote managed provider runtime updates** to inspect the seven
  release-family results or start a manual run.
- Open the failed provider's reusable-workflow run to identify whether stable
  discovery, metadata collection, a native runner, or publication failed.
- A transient provider or runner failure needs no rollback; retry that workflow
  after the external condition clears.
- If an official stable endpoint or artifact layout changed, update only that
  provider's discovery and app-owned manifest policy, add focused fixtures, and
  re-run every approved native family before publication.
- If an incorrect entry was somehow published, disable provider update checks
  only as temporary client-side containment. The break-glass withdrawal is a
  reviewed, normal (non-force) commit that restores only the affected provider's
  last qualified entry on the generated branch. Then fix discovery or policy on
  `main` before re-enabling automation. Never replace bytes under an existing
  version.
- After this replacement workflow lands and its first generated-branch
  publication succeeds, close the superseded
  `automation/managed-runtime-catalog` PR/branch. It is not an input to the app.

## Local qualification

Before merging runtime-policy changes, run **Promote managed provider runtime
updates** on the feature branch, choose the affected `provider`, and enable
`qualify_only`. Branch runs always prohibit publication, even if that checkbox
is left off. They qualify the caller's immutable commit, never current `main`,
and do not mint a publication token. Qualification-only runs include repair and
repeat the Windows install/repair/remove cycle five times; every attempt must
pass (these are not retries that hide a failure).

```sh
gh workflow run managed-provider-runtime-updates.yml \
  --ref <feature-branch> -f provider=cursor -F qualify_only=true
```

Cursor's complete 2026.09.02 Unix packages expand to 511–570 MiB, so its
app-owned tar budget is 768 MiB. Windows retains its 384 MiB ZIP budget; both
remain capped at 768 entries. Do not remove bundled executables to fit an older
budget or increase the shared defaults. The extractor permits an explicitly
reviewed budget up to 768 MiB independently of its unchanged 512 MiB download
ceiling and default expansion budget. Native probes must finish closing
before activation or failure cleanup moves the payload.

The v0.6.9 production app still reads the catalog from `main` and has the older
Cursor extraction budget. Keep that legacy Cursor entry unchanged until a
separately reviewed compatibility transition; qualify newer Cursor packages on
the generated branch for builds containing the new reader and budget. A release
snapshot into `main` must not advertise an incompatible package to older apps.

Use temporary files; do not edit the bundled catalog merely to test discovery:

```sh
node scripts/update-managed-runtime-catalog.ts \
  --provider claudeAgent \
  --input apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json \
  --output /tmp/managed-runtime-candidate.json

node scripts/qualify-managed-runtime-catalog.ts \
  --provider claudeAgent \
  --catalog /tmp/managed-runtime-candidate.json

node scripts/promote-managed-runtime-catalog.ts \
  --provider claudeAgent \
  --current apps/server/src/scient/providerLifecycle/managed-runtime-catalog.json \
  --candidate /tmp/managed-runtime-candidate.json \
  --output /tmp/managed-runtime-promoted.json
```

For official ACP, discover with `--provider antigravityAcp`, then qualify with:

```sh
node apps/server/scripts/qualify-antigravity-acp-catalog.ts \
  --catalog /tmp/managed-runtime-candidate.json
```

This proves discovery, current-host qualification, and merge behavior. It does
not replace the provider's complete hosted runner matrix, and it does not publish.
