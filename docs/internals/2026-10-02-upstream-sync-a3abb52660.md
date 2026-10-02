# Upstream alignment through a3abb52660

Date: 2026-10-02. Status: alignment qualification receipt, not release authorization.

## Frozen history

- Owned base: `299a8f8f7273fc06d1b99781dd8912dc21d6ad52` (`main`, the merge of pull request #428).
- Previous official integration: `5cc99e1c23980d7995a13c47f969b47cb68ed1be`.
- Official target: `a3abb5266080c15b2a675d7f92b517b567c427e2`.
- Range: 15 first-parent official commits, 135 official paths, 19 overlapping with Sciant.
- Nearest official tag: `v0.0.45-nightly.20260930.2493`.
- Branch: `codex/t3-sync-a3abb52660-20261002`.
- Upstream merge: the merge commit whose second parent is the exact official target.
- Upstream push URL: `DISABLED`.

This range is dominated by the mobile Expo SDK 58 and React Native 0.88.0-rc.3
upgrade. 87 of 129 changed files are under `apps/mobile`, plus 14 `patches/` files.

## Advancements and alignment work

| Official commit | Advancement                                                | Classification                                                                                                                     |
| --------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `8dc07f199c`    | Expo SDK 58 and React Native 0.88 RC                       | Upstream-owned mechanics, adopted. See the thread-safety finding below.                                                            |
| `1e9c36023c`    | Expo Modules 2.0 for function-only native members          | Adopted.                                                                                                                           |
| `9962e6986d`    | Android display scale and width read from the view's scene | Adopted.                                                                                                                           |
| `bed69f6ea4`    | Android suppresses only the on-screen thread's alert       | Adopted, with `docs/operations/android-notifications.md` updated to match shipped behaviour.                                       |
| `438af295fe`    | Stack agent alerts by thread on both platforms             | Adopted. Relay and APNs/FCM delivery stay inert under Scient's `cloudEnabled: false` gate.                                         |
| `09388bf2da`    | Degrade the agent Live Activity once its content is stale  | Adopted.                                                                                                                           |
| `e41755cf8a`    | Android subscription widget through expo-widgets           | Adopted. Mobile publication remains held.                                                                                          |
| `ce920f2ac8`    | Drive dev-menu suppression from the dev-client launch URL  | Adopted.                                                                                                                           |
| `6ea01f8d24`    | Cloned projects show their favicon instead of a monogram   | Adopted. Touches `Sidebar.logic.ts`, `state/assets.ts`, `state/projectClones.ts`, and `AssetAccess.ts`.                            |
| `5a574a77d1`    | Remove duplicate sidebar ordering tests                    | Adopted.                                                                                                                           |
| `a3abb52660`    | Pin eas-cli so mobile PR previews deploy again             | Adopted. `eas-version` moves from `latest` to `21.8.0`. Scient's `if: ${{ false }}` mobile hold and its permissions are unchanged. |
| `094fb230e9`    | Server features are services, handlers stay thin           | Adopted as guidance only; see the `AGENTS.md` composition below.                                                                   |
| `a97a4a9d18`    | Marketing stats update                                     | Adopted; non-product.                                                                                                              |
| `b91e4668fa`    | Marketing social card                                      | Adopted; non-product.                                                                                                              |
| `a3fb5392e3`    | AGENTS.md user-count update                                | Rejected with the rest of upstream's AGENTS.md rewrite.                                                                            |

## Conflict composition

Seven paths needed resolution.

- `AGENTS.md` keeps Scient's repository boundary and code map. Upstream replaced the
  file with its own product manifesto and team authority, which does not apply here.
  Upstream's one applicable technical rule was adopted as a Sciant architectural
  boundary: a `ws.ts` handler, HTTP route, MCP tool, scheduled task, or CLI entry
  decodes input, calls one service method, and maps errors, with
  `docs/internals/effect-services.md` as the reference.
- `apps/server/src/assets/AssetAccess.ts` unions Scient's `generatedDocument`,
  `generatedDocumentExpiresAtEpochMs`, `analysisArtifact`, and `computeOutput`
  options with upstream's `projectCheckoutPending`. The producer at `ws.ts` and the
  consumer in this file auto-merged coherently.
- `pnpm-workspace.yaml` takes upstream's Expo 58 patch map and keeps Scient's
  `@ff-labs/fff-node@0.10.3`, because `apps/server` declares that version.
  `node-pty` stays on `^1.1.0`, so upstream's `node-pty@1.2.0-beta.15` patch entry is
  deliberately not mapped; the patch file stays in the repository so adopting the
  newer version needs no new artifact. This remains an open owner decision.
- `pnpm-lock.yaml` is regenerated from the composed sources rather than hand-merged.
- `apps/web/package.json` keeps Sciant's `@types/plotly.js` and takes upstream's
  `@types/react ~19.3.0`. See the repair below for why.
- `docs/user/usage.md` keeps Scient's Android 12L requirement and gains upstream's
  background-launch fact.
- `third-party-licenses.config.json` keeps Scient's curated notices and restores
  upstream's nine `noxcturnal` entries. See the repair below.

## Two repairs found during verification

**Duplicate React type identities.** Holding `apps/web` at `@types/react ~19.2`
while mobile moved to `~19.3` left the lockfile carrying both. `apps/web` compiled
against two React type identities and 14 icon assignments failed with mutually
unrelated `Ref` and `VoidOrUndefinedOnly` types. Taking upstream's `~19.3.0` gives
one identity. Sciant's `@types/plotly.js` is unaffected.

**Missing `noxcturnal` license notices.** The Expo 58 upgrade pulls in `noxcturnal`,
whose notices were dropped with upstream's config side. `apps/mobile/metro.config.js`
then threw on 7 invalid notices, which also made `knip` report 47 unused mobile
files it could no longer resolve. Restoring the nine notices fixed both.

## Finding: Expo SDK 58 removes thread-safety locks from expo-modules-core

This is the significant result of this alignment and it is inherited, not composed.

`apps/mobile/scripts/permissions-service.test.ts` and
`notification-center-manager.test.ts` compile the iOS service sources straight out
of the installed `expo-modules-core` package under `clang -fsanitize=thread`. They
pass on `main` and fail on this branch.

The cause is a change between `expo-modules-core@57.0.14` and `@58.0.9`:

```objc
// 57.0.14
@synchronized (self) {
  [_requesters setObject:requester forKey:permissionType];
  [_requestersByClass setObject:requester forKey:[requester class]];
}

// 58.0.9
[_requesters setObject:requester forKey:[[requester class] permissionType]];
[_requestersByClass setObject:requester forKey:[requester class]];
```

Across the whole `ios/` tree of `expo-modules-core`, the `@synchronized` count goes
from **6 on 57.0.14 to 0 on 58.0.9**. ThreadSanitizer reports the resulting races on
`-[__NSDictionaryM setObject:forKey:]` from `-[EXPermissionsService registerRequesters:]`
and on the notification centre manager.

This is real shared mutable state reachable at runtime on iOS, in exactly the two
areas the repository already wrote regression harnesses for. It is not caused by any
conflict resolution in this branch: the sources come from the installed package, and
`main` passes the same two tests four times out of four.

CI is unaffected. Both tests are `skipIf(platform !== "darwin")`, the `Test` job runs
on Ubuntu, and the `Mobile Native Static Analysis` job runs only
`node scripts/mobile-native-static-check.ts`. So hosted CI is green while a macOS
checkout fails locally.

Options, all of them an owner decision:

1. Add a `patches/expo-modules-core@58.0.9.patch` restoring the locks. The repository
   already patches several Expo packages. This fixes the race properly but means
   Scient carries a native patch of an upstream defect.
2. Hold the Expo 58 bump and take the rest of the range, leaving mobile on SDK 57.
   This gives up per-thread alert stacking, the Android widget, Expo Modules 2.0, and
   the Android alert-suppression fix.
3. Accept the upgrade and record the two failures as a known upstream regression.
   This silences the two tests that exist specifically to catch it, so it needs an
   explicit exception rather than a silent skip.

## Verification

macOS arm64, Node 24.19.0, pnpm 11.10.0, against the merge commit on
`codex/t3-sync-a3abb52660-20261002`.

| Check                                                                                | Result                                                                            |
| ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| `pnpm exec vp fmt --check`                                                           | pass                                                                              |
| `pnpm exec vp lint --report-unused-disable-directives`                               | pass, 0 errors                                                                    |
| `pnpm run typecheck`                                                                 | pass, 0 errors                                                                    |
| `pnpm run knip:check`                                                                | pass, no unused files                                                             |
| `pnpm run test` (all non-mobile workspaces)                                          | pass                                                                              |
| `pnpm run test` (`@t3tools/mobile`)                                                  | 190 files passed, 2 failed: the expo-modules-core thread-safety regressions above |
| `pnpm run build`                                                                     | pass                                                                              |
| `pnpm run test:desktop-smoke`                                                        | pass                                                                              |
| `pnpm run brand:check`                                                               | pass across 2,503 product-surface files                                           |
| `pnpm run upstream:provenance:check`                                                 | pass                                                                              |
| `pnpm alignment:seams:check --base 299a8f8f72 --upstream-ref a3abb52660 --head HEAD` | onboarding, skills, analysis, latex, omp all passed                               |

Not established here: Windows and native mobile build evidence, hosted CI on this
revision, and visual acceptance in the desktop app.

## Open items for the owner

1. **The `expo-modules-core` thread-safety regression.** Decide between patching the
   locks, holding the Expo 58 bump, or recording an explicit exception.
2. **`node-pty`.** `^1.1.0` versus `^1.2.0-beta.15` is still undecided, and this range
   carried upstream's patch for the newer version.
3. **`@ff-labs/fff-node`.** Scient is on `0.10.3` while upstream is on `0.9.4`; the
   composed tree keeps Scient's version and its patch.
4. **Pre-existing and still open:** `main` lacks `.github/workflows/release-desktop.yml`
   while `desktop-macos-preview-publish.yml:287` still calls it, so that workflow fails
   on every run. Restoring upstream's file would restore the packaging path this
   repository replaced, so it still needs an explicit release decision.
