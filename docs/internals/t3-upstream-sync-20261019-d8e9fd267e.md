# T3 upstream alignment — 2026-10-19 (through d8e9fd267e)

## Boundaries and status

Generated with `pnpm alignment:facts --merge e0e4158af1`:

- Owned base: `2be0d794d09273a338aeaad74eae7fa733d6bf97`, the public-main merge of
  Scient PR #586.
- Previous official boundary: `a7025639c0e16aad3081106c935bf3025f601a1e`.
- Frozen official target: `d8e9fd267e26b7680f035edc0b40db09d2685dbb`, no tag at the
  target (nearest reachable: `v0.1.1-nightly.20261018.3331`).
- Range: 575 official commits, 1262 incoming paths, 438 same-path overlaps with
  Scient, 186 initially unmerged paths.
- Literal integration merge: `e0e4158af17cacba28c2abc9e39457b194a964c8`, tree
  `b787487cc4aae278d942ecb3280483689a724ce8`; parents are the owned base and the
  frozen official target.
- Owned-main catch-up: `7e3d8f0a5804ec67b1addc0c7b2f40e80a822f59` merges owned main
  `a8a3cae71adfa9d747c57a83be4279589c6f6a81` (Scient PRs #585 sidebar update
  controls, #587 compute test wait, #590 release notes without the Windows notice),
  and `bf92e81eb1d52188e7faca8c994a57996f42524f` merges owned main
  `9fa9b7e21d423ac42fc8dc1c2a08e2122ed81385` (Scient PR #588, sidebar sections
  placement). Neither changes the official merge.
- Branch: `codex/t3-sync-d8e9fd267e-20261019`; upstream push URL: `DISABLED`.
- Scient PR: #593.

## Integrated behavior and composition

The range is dominated by upstream's React Compiler adoption (about 250 commits that
drop manual memoization) and its move of every web React test into headless
Chromium. It also brings render-count reductions across chat, sidebar and settings;
faster startup on large databases; V1 transcript import and checkpoint fixes; Claude
workflow members that stream into their own threads; workspace write authorization;
database recovery guidance; and many provider, composer, mobile and desktop fixes.

Meaningful compositions:

- **React Compiler for every web file (#20791).** Upstream lints every
  `apps/web/src` file with the compiler's bailout rules and bans manual memoization;
  `reactCompilerCoverage.test.ts` fails on any file the compiler skips. Scient web
  code is converted rather than exempted: 212 Scient files across five areas
  (chat and reader policy, providers and settings, files and documents, compute and
  visualizations, sidebar/sections/voice). Lint and compiler coverage pass for all
  1,661 web files. Conversions that changed behavior were caught by tests and fixed:
  the conversation-import attempt was recreated each render (uploads restarted), and
  the PDF document host recreated its request consumer when the server URL changed
  (a cached request replayed). `useChatContentDirection` moves its held streaming
  direction from a render-time ref to state; after completion the held direction now
  stays the fallback for text without a strong script on every render, not only the
  first (a new browser test pins it).
- **Web tests in Chromium (#20797, #20944).** Upstream removed jsdom and
  `react-test-renderer` from the web package and its hook-mocking helpers
  (`src/test/reactHookHarness`, `reactElementTree`). Scient's separate `layout`
  project and `test:layout` script are retired: upstream's `browser` project now
  runs every `*.browser.test.tsx`, and the `Test Web layout` CI job is removed (not a
  required check). 38 Scient suites that used the removed renderer or helpers are
  ported to browser tests; no Scient case is dropped. Upstream browser cases are
  adapted, inside markers, where they meet Scient policy: "Local previews" and
  thread-owned server relevance, the mini-player's `content`, stage art without SVG
  ids, remote-image consent, message-boundary forks. Scient-only happy-dom tests
  (about 124) stay in the unit project; moving them is follow-up work.
- **Migration 63 → Scient 67, narrowed (#20947).** Upstream drops six V1 projection
  tables after the V2 upgrade. Scient's legacy history import and repair still read
  thread activities, pending approvals and proposed plans (`LegacyScientHistory`,
  refreshed at every start by `refreshLegacyV1Snapshot`), and Scient V2 migration
  016 reads turns on databases still upgrading. Scient's 067 drops only
  `projection_state` and `checkpoint_diff_blobs`, following upstream's own rule of
  keeping what the transcript import reads.
- **`doctor` keeps the original database (#20948 gated).** Upstream's repair that
  deletes the database from before 0.1.0 is kept as machinery but not offered:
  `DatabaseMaintenance.inspect` never reports it and `removeLegacyDatabase` refuses.
  Scient's history import still reads `state.sqlite`; a later run of an older Scient
  can add conversations the current database has not copied; and the deletion fails
  on Windows while SQLite holds the file (review R1). Enabling it needs a staleness
  check under the deletion lock and Windows-safe removal.
- **Database durability.** Scient keeps `synchronous = FULL`. Upstream's
  no-planner-statistics change (#21122) is adopted; stats are cleared on start.
- **Workspace write authorization (#20449).** `KnownWorkspaces` and the Git-folder
  write denial are adopted and apply to Scient's file mutations too (save, create,
  rename, write-target inspection). Because Scient's mutations resolve their target
  again, the Git-folder denial also runs on that resolution, including the one under
  the write lock (review R1). Scient's writers (Word export, file exchange, compute, Markdown) write
  under the thread's project or worktree; managed worktrees default to Scient's home.
- **Chat visits.** Upstream moved its visit watermark into a `ThreadVisitWatermark` leaf
  (#20860). Scient already removed upstream's writer: `useAcknowledgeAnswer` marks a
  thread visited only for a loaded completed answer in a visible, focused window. The
  leaf is not mounted (review R2-1), and a seam test keeps a second writer out of
  `ChatView`.
- **Atomic writes on Windows (#21062).** Upstream's bounded lock retry replaces
  Scient's; Scient keeps durable flush, mode and directory sync in markers. Scient's two
  retry tests for the replaced loop are removed; upstream's tests cover a lock that
  clears and one that does not.
- **Claude workflow members (#20856, #20786).** Upstream's member-thread projection
  is the single live path; Scient's separate member store, fingerprints and emitter
  are removed, keeping coordinator ownership, idle/native-process delivery, sparse
  labels and counters. Scient's runtime integration test now expects each member's own
  thread, listed by the coordinator.
- **Revert dialog.** Upstream moved the rewind confirmation into
  `ChatOverlayHosts` (#20859). Scient keeps its own dialog, which stays open while
  reverting, keeps failures and shows file-history diagnostics; upstream's host is
  not mounted. Porting Scient's behavior into the shared host is follow-up work.
- **Markdown editor timing in CI.** Each web shard now runs headless Chromium beside the
  unit project, and every Markdown editor measurement there was about three times
  main's. The suite skips in the shard on CI and runs alone in shard 1 (a marked
  `ci.yml` step) with unchanged budgets.
- **Sidebar placement (#588 catch-up).** #588's frozen-environment handling is
  carried into the React Compiler conversion of the placement hook: the reducer's
  snapshot and manual placement reconcile with `isFrozen`, and derived values stay
  plain.
- **Mobile under the React Compiler (#21137).** Upstream now compiles mobile too.
  The compiler cannot compile a `??` inside a `try`, so Scient's attachment-limit
  fallback in the paste composer is a module helper.
- **Updater and release.** Upstream's configurable desktop release repository
  (#21210) falls back to Scient's repositories, never T3's. Scient's release
  workflow keeps its structure (no test steps there, so upstream's Chromium step does
  not apply). A lane-added publication-feed guard in `build-desktop-artifact` was
  reverted as outside alignment scope; upstream's explicit `publish: null` is adopted.
- **Branding.** Upstream's database recovery messages (#20748) and the
  `schedule_task` tool description say Scient.
- **Windows link fix.** Chromium on Windows parses a one-letter scheme such as
  `d:alert(…)` as a drive file URL; `rewriteMarkdownFileUriHref` now treats only
  explicit `file:` links as file URLs (worth offering upstream).
- **Mermaid.** Upstream's math labels (#16198) are already on in Scient's isolated
  renderer (`htmlLabels`, `forceLegacyMathML`); upstream's test for the replaced
  component is removed.

Clean merges that broke Scient consumers and were fixed: test harnesses missing the
new `KnownWorkspaces` service (one Scient testkit allows every folder;
`WorkspaceFileSystem.test.ts` covers rejection), settings mocks missing
`committedCustomModels`, registry fixtures missing Scient's `rebuildInstance`,
Scient's flat invocation scope in a new preview test, the `EnvironmentServerConfig`
map (providers now come from `useEnvironmentProviders`), removed `threadTimeLabel`
and `useUpdateClientSettings`, and seam locators that followed upstream row
extraction.

## Review and qualification evidence

Four independent Codex (gpt-6.1-sol, high) review rounds, each given the earlier
findings:

- R1: upstream's `doctor` repair could delete `state.sqlite`, which Scient's history
  import still reads, and fails on Windows while SQLite holds it; it is gated off.
  Upstream's Git-folder write denial did not cover Scient's own target re-resolution;
  it does now. A workflow test selected members by the wrong field.
- R2: upstream's `ThreadVisitWatermark` was mounted beside Scient's
  `useAcknowledgeAnswer` and marked answers read without focus, visibility or a
  loaded answer; it is not mounted.
- R3: no runtime blocker. A source-text guard added in R2 was retired (protocol:
  permanent tests exercise behavior); the Markdown timing suite skips only where the
  CI shard says it shares the runner; markers paired and stale comments marked.
- R4 (the #588 catch-up, the server and mobile fixes): no blocker; the #588
  resolution keeps frozen-environment placement and no server adaptation weakens an
  assertion. The mobile helper's two call sites gained paired markers. `docs/user`
  carries no markers anywhere, so #588's sidebar copy there stays unmarked.

Hosted CI found what Windows could not run. All are fixed and green at
`95a8b858408d36f5b94c5948003066a1769d3253`
([run](https://github.com/ScientFactory/scient-desktop/actions/runs/39208789717)):

- 27 server cases. Two needed production changes: upstream's duplicate-thread error
  (#19704) keeps Scient's "This conversation already exists. Start a new conversation
  instead."; voice correction passed `--effort low` to Claude models that do not
  advertise effort, which upstream's #20849 now preserves and the CLI rejects. The
  rest followed intended upstream changes: numbered orchestration sections (#18415),
  completed-discovery rules in the registry, members projected into the coordinator's
  thread (#20856), `--` before worktree paths (#20440), a seeded project for
  Scient's runtime policy, prompt keys with Scient's skill-scope marker, and test
  harnesses that checkpointed the server checkout instead of their own folder.
- Scient's Windows-lock retry tests exercised the loop upstream #21062 replaced;
  upstream's tests cover a lock that clears and one that does not.
- Web shards now run headless Chromium beside the unit project, and every Markdown
  editor measurement there was about three times main's; the suite runs alone in
  shard 1 with unchanged budgets.
- Mobile: the compiler bailout above, and the upload test's mocks gained
  upstream's `composerDraftUploadSourcesAtom` (#21261) and `settlePromise` (#21101).
- The brand check caught upstream's T3 Code wording in the repair Scient never offers.
- One run each failed an upstream pull-request summary filter test and a Scient
  port-scanner case; both passed every local repeat and the next hosted run, and
  nothing they exercise changed in this alignment.

Local (Windows 11, Node 24.21.0, candidate `95a8b85840`):

| Gate                                             | Result                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Typecheck (45 packages)                          | pass                                                                                                                          |
| Lint                                             | pass (0 errors)                                                                                                               |
| Format                                           | pass                                                                                                                          |
| knip                                             | pass                                                                                                                          |
| React Compiler coverage                          | 1,661/1,661 (web); mobile passes                                                                                              |
| Web unit + browser                               | first full run 14,383/14,463; all 80 failures triaged and fixed; later changes verified per area (sections 1,884, mobile 886) |
| Server tests                                     | aggregate not a Windows lane; every failing file run alone after its fix                                                      |
| Seams (onboarding, skills, analysis, latex, omp) | pass                                                                                                                          |
| Brand check                                      | pass                                                                                                                          |
| `git diff --check`                               | pass                                                                                                                          |

Hosted CI: all 13 required checks and every other workflow passed at `95a8b85840`.

Install note: pnpm 11.10 on this machine hangs at the final linking step; the
candidate's `node_modules` was produced by `--lockfile-only` then a frozen install,
with the approved build scripts, root `prepare` and seven unapplied patches run by
hand.

## Follow-up

- Move the remaining Scient happy-dom tests to browser tests.
- Port Scient's revert-dialog behavior into upstream's `ChatOverlayHosts` host.
- Offer the Windows drive-letter link fix upstream.
- Enabling `doctor`'s original-database deletion needs a staleness check under the
  deletion lock and Windows-safe removal.
- Watch the pull-request summary filter test and the port-scanner case for repeats.

## Publication boundary

This alignment does not authorize a release, publication or a change to cloud,
telemetry, updater, signing or mobile release holds. Merging #593 is a separate
owner decision.
