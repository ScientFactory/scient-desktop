# T3 upstream alignment, 2026-10-24 (fef851bee0)

## Summary

This alignment brings Scient from official `52628d863e` to the frozen official
target `fef851bee09102641061aeb78a3092c2ba2c72ab`: 26 official commits in one literal merge. It builds on the
previous alignment's committed head (Scient PR #640, `c7b630d5d4`) before that PR
merges, as the owner authorized; owned main is caught up after #640 lands. The
owner's authorization ends at ready to merge: no merge, release or publication
is part of it.

## Generated boundaries

Generated with `pnpm alignment:facts --merge 4eea0c3f2b630ad16cfff2e5152eea5713466f46`:

- Owned base: `c7b630d5d4e839646654f13f610e6bf551771968`.
- Previous official boundary: `52628d863e977e1a8b16644141fd00ba96640b16`.
- Frozen official target: `fef851bee09102641061aeb78a3092c2ba2c72ab`, no tag at the target (nearest reachable: `v0.1.3-nightly.20261023.3592`).
- Range: 26 official commits, 143 incoming paths, 51 same-path overlaps with Scient, 17 initially unmerged paths.
- Literal integration merge: `4eea0c3f2b630ad16cfff2e5152eea5713466f46`, tree `05fd0234a28ba43c4a5838f61cce79475d92b08f`; parents are the owned base and the frozen official target.

The merge used `--no-ff --no-commit --no-rerere-autoupdate`; no donor was
cherry-picked, replayed or dropped. The 17 conflicts' three-way stages were saved
before composition.

## Composition

- **MCP analytics:** Scient maps `scient_*` tool names to upstream's metric names
  first, then upstream records only failed calls of tools that hand off no work.
  Upstream's test runs against `scient_thread_organize`.
- **Stop:** Scient keeps delegated-task cleanup on; upstream's
  `stopDelegatedTasks: false` stays removed, and `reason` passes conditionally.
- **Fork `/compact`:** Scient's frozen-history check (`scient_fork_history`) and
  upstream's `inheritsForkConversation` both count toward a fork's conversation.
  Scient forks set `forkedFrom: null`, so upstream's helper does not apply to
  them. Upstream's test is adapted: Scient forks natively only with exact native
  boundary evidence, which its fixture lacks, so the same-provider fork is
  portable; its history is retained by reference rather than within the 16k
  inline budget, and the first `/compact` compacts it. The fixture now records the
  source user message, as a sent message always has.
- **Browser recordings:** the reporter sends upstream's frame rate alongside
  Scient's browser defaults.
- **Muse usage:** Scient's driver factory carries upstream's usage requirements
  (`Path`, `MuseUsageHome`).
- **Mobile:** upstream's Duo, iPad and navigation changes with Scient's name and
  compact-iPad compose; Usage moves from Settings to workspace navigation. Scient's
  compact-iPad toolbar test mocks the toolbar's new imports; its compact-tabs mock
  follows the real hook, so a phone's compose stays with the compact tab picker.
- **react-native-screens** moves to the PixPMusic fork's `5.0.0-t3.43`. It still
  lacks Scient's collapsed-column removal guard, so the patch is re-keyed to the
  new version; it applies without changes and is present in the installed package.
- **Relay previews:** the two new workflows' four jobs are held with `if: ${{ false }}`,
  like `deploy-relay.yml`; no preview stage or sweep runs in Scient's repository.
- **Brand:** the new pairing-protocol and SSH version messages name Scient and
  `scient pair` (Scient's CLI is not published to npm).
- **Lockfile:** regenerated from Scient's lockfile: only upstream's screens
  change, and all 126 `hasBin` markers are kept.
- Observability resource-attribute renames change only exported names; no export
  is enabled.

## Qualification

On `4eea0c3f2b630ad16cfff2e5152eea5713466f46`, with Node 26.12.1 and pnpm 12.14.0 and a synthetic home for every test
command:

| Check                                            | Result                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Typecheck                                        | All 49 workspace packages.                                                                                                                                                                                                                             |
| Format and lint (`vp check`), Knip, brand, icons | Pass; 0 lint errors.                                                                                                                                                                                                                                   |
| Seams                                            | All six seam checks pass.                                                                                                                                                                                                                              |
| Affected suites                                  | Every suite upstream changed in the range and every suite beside a conflicted or edited file: server 812 (1 skip), client runtime 123, contracts 91, Muse 25, web 17, relay 8, desktop 6, shared 2; the whole mobile suite, 221 files and 2,462 cases. |
| `alignment:checks --base HEAD --run`             | Shared, server (all boundaries), web unit and web browser groups pass.                                                                                                                                                                                 |
| Build, desktop and release smoke                 | All six build tasks; synthetic-state Electron smoke; release smoke. Not visual acceptance.                                                                                                                                                             |

`lint:mobile` needs ktlint and detekt, which CI installs; it was not run locally.
The full workspace suite is qualified by hosted CI on the exact PR head.

## Found, not fixed here

- **Cross-provider fork `/compact`:** a Codex fork of a Claude thread does not
  reach session open on its first `/compact`, before this merge as well. It is a
  separate Scient defect and is excluded from the adapted fork test.

## Acceptance and publication boundary

Hosted CI on the exact head and the merge queue remain required, after PR #640
merges and owned main is caught up. Native-device, authenticated live-provider
and human visual acceptance remain separate. Native V2, scientific capabilities,
immutable migrations, database durability and all cloud, telemetry, relay,
updater, mobile publication and release holds remain.
