# T3 upstream alignment — 2026-10-16 (through 86f4a74c5d, extended to a7025639c0)

## Boundaries and status

Generated with `pnpm alignment:facts --merge 36f8115586`:

- Owned base: `958267ce1e8984d90301b9a32915e6e4ef466704`, the public-main merge of
  Scient PR #572.
- Previous official boundary: `7ac952c630ef8a60d14ca8f6a0c7adce33db4bae`.
- Frozen official target: `86f4a74c5d789f2b4973616775a6adf19525bf4d`, no tag at the
  target (nearest reachable: `v0.0.46-nightly.20261015.3171`).
- Range: 86 official commits, 762 incoming paths, 184 same-path overlaps with
  Scient, 62 initially unmerged paths.
- Literal integration merge: `36f81155864a8dec205da90b94f25fc205066360`, tree
  `2246dfbca24a182d3bf244f98b7fa99a94d3f756`; parents are the owned base and the
  frozen official target.
- Owned-main catch-up: merge `9b8c5e56779b321c4810160a209864a297452025` of owned
  main `7b07058031f75807cfb09327d90f0670c5849a78` (Scient PR #573, alignment
  tooling and the onboarding seam signal). It does not change the official merge.
- Branch: `codex/t3-sync-86f4a74c5d-20261016`; upstream push URL: `DISABLED`.
- Scient PR: #574.

## Integrated behavior and composition

The range brings settled-worktree cleanup, pull-request branch deletion and
GitHub links, update-everything progress, delegated-task question and steering
fixes, runs that fail when their provider stream ends without a terminal event,
Windows install and port-polling fixes, HTML render caching, a mobile design
system, OTLP machine/build attributes, GitHub REST/GraphQL on one request policy,
Effect 4.0.5 and undici.

Meaningful compositions:

- **Run lifecycle.** Upstream's stream-end failure (#19131) is adopted. A start
  that Scient's Stop already cancelled and finalized returns quietly instead of
  logging an ingestion failure. Upstream's workspace lease wraps provider startup;
  Scient's startup reservation covers the lease and the root run. Command reads
  omit settled leaf nodes; Scient's readers do not need them.
- **Steering (#19210).** Upstream no longer restarts a turn for a model change when
  the provider can restart. Scient still restarts a steer whose runtime or
  interaction modes changed, because a running native turn cannot change its
  permission mode; continuing would run under the old authority.
- **Session release.** Upstream's subscriber interruption and shutdown interrupt
  cause run through Scient's session retirement. `isLive` also reports a closing
  session, so storage cleanup does not remove a worktree under a running process.
- **Storage cleanup (#15208).** Settled-worktree cleanup, its grace period and the
  live-session check are adopted; archived-thread and queued-run protection stay
  in both the sweep and the per-worktree recheck.
- **Delegated tasks.** Question wake text and the `hasPendingQuestion` contract
  name Scient's `scient_pending_request_*` tools.
- **Providers.** Codex "Always allow this session" (#19635) now answers later
  approvals of that kind for the thread, session and runtime mode, matching its
  label; a mode change ends it. Upstream's Windows Codex install is adopted behind
  Scient's subscription-sharing gate. Claude keeps Scient's turn-start identity
  checks. ACP drops one malformed `session/update` instead of ending the session;
  an invalid session identity still ends it.
- **Pull requests (#19257).** Branch deletion is an explicit, confirmed menu
  action gated by the host's write permission.
- **Clients.** ChatView, composer and sidebar adopt upstream's stable callbacks for
  upstream-owned handlers while Scient keeps one reader scroll owner. Upstream's
  Mermaid toggle (#19601) does not apply: Scient's Mermaid card owns that toggle.
  Full-screen HTML replies keep the marked "Open in panel" action.
- **Update everything (#19837).** The progress capsule is adopted during a run and
  restarts through Scient's single installer; outside a run the label-sized Scient
  pill remains. A server that is no longer eligible when its step starts is settled
  as failed and cannot be retried with a stale target.
- **Branding.** Upstream's Alpha-to-Beta product rename (#20032) is not adopted on
  web, mobile or desktop; Scient keeps its labels, `Scient` product name and its
  Stable/Beta release channels. New pull-request-link copy says Scient.
- **Mobile.** The shared component system is adopted with Scient skills,
  provider-instance selection, queued-row Send, request errors, prompt-link identity
  and canonical clipboard behavior carried into the new hosts.
- **Dependencies.** Effect 4.0.5 throughout, including Scient's Bun packages. The
  Scient enriched-Markdown native patch applies unchanged to upstream's `t3.12`
  tarball; the lockfile resolves the same patch hash. The server bundles undici.
- **Docs.** Settled retention and update-everything progress are documented in
  Scient's words; upstream's npm-publication note and "Beta is only a label" note do
  not apply to Scient.

Clean merges that broke Scient consumers and were fixed: tests that imported the
removed `GitHubApi` module, a server test harness missing the new environment
identity service, Effect 4.0.5's `bigint` file identity, upstream's Windows
process-name lookup over Scient's explicit-URL listener policy, Scient's
`any-local-files` cleanup default and bundled undici in upstream tests, the
onboarding seam matching a documentation URL in upstream's generated GitHub schema
(the signal is tightened in the tooling PR), and upstream tests asserting T3 copy.
An upstream test dropped by the previous alignment ("refuses to cancel a task whose
child now runs above the parent's modes") is restored in Scient's test setup.

## Review and qualification evidence

Two independent Codex (gpt-6.1-sol, extra-high) reviews covered the merge:
server/persistence/orchestration/providers and clients/contracts/docs. Each assessed
every listed composition. Their findings were composed in `f15394f236` and a second
round found no blocking issue:

- The server loads undici through `createRequire` to keep fetch on HTTP/1.1 under
  Node 26, so undici stays a staged runtime external; a test change during
  resolution had wrongly expected it to be bundled.
- Clients released before this alignment decode pull-request actions with a
  closed list, so `delete-branch` would break their pull-request views against an
  upgraded server. Branch deletion is gated: GitHub neither advertises nor accepts
  it, and the action lists now decode forward-compatibly. The gate can be lifted
  once clients older than this alignment are no longer supported.
- A Retry in update everything rechecks current eligibility and keeps the
  confirmed version and mechanism; its test suite was repaired for the handoff API.
- The orchestrator MCP documentation names Scient's pending-request tools.

The first hosted run found that upstream's server configuration now reads
`apps/server/package.json`; the managed-runtime publication guard for the Scient
Agent and OMP runtimes now covers it, so a version change on main voids a stale
qualification. That workflow test cannot run on Windows (it compares
backslash paths), which is why the local checks did not report it.

Later hosted runs found three more composition issues and one timing-sensitive
test, all corrected and reviewed:

- Upstream fails a run whose provider stream ends cleanly without a terminal
  event (#19131). OMP's interrupt ends its process that way, so a background
  Stop that arrived before a wake run's native start failed the run. A run with
  an unanswered Stop now leaves its outcome to the Stop, which records it
  interrupted as before; provider errors and unexpected endings still fail it.
- Server shutdown interrupts native subscriptions instead of ending them
  normally; a normal end would now fail every running run, while an interrupt
  leaves them to restart recovery. The Pi shutdown case asserts that.
- Codex receives upstream's 65-minute MCP tool timeout, above Scient's one-hour
  wait cap.
- Two reader layout cases waited the default second for an eased reveal that
  can take longer on a loaded runner; they now wait up to five seconds with the
  same 23–25 px bound. Under 12–20× CPU throttling the old wait failed every time
  and the new one passed, always settling at 24 px.

Follow-ups, not changed here: storage cleanup filters stopped sessions before its
liveness check, so a session whose physical close timed out can be missed (this
predates the range); a withdrawn update target loses Retry for the rest of the pass,
even when it was only offline.

Local evidence on Windows 11, Node 24.21.0, pnpm 11.10.0, run with
`pnpm alignment:gates` (host profile variables removed, one temporary home per gate):

| Check                       | Result                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| Typecheck (all packages)    | Passed in one collect-all run, 118–184 s                                |
| `vp fmt --check`, `vp lint` | Passed                                                                  |
| Build                       | Passed, 181 s (direct filters; this branch predates the script fix)     |
| Desktop smoke               | Passed, synthetic home used                                             |
| `brand:check`               | Passed after rebranding new pull-request-link copy                      |
| Seams                       | Onboarding flagged upstream's GitHub schema; tooling PR tightens signal |
| `git diff --check`          | Passed (index and worktree)                                             |
| Test aggregate              | Not run: not a supported Windows lane; hosted qualification pending     |

`pnpm alignment:checks --base 958267ce1e --run` ran every boundary on Windows:
shared (107) and web unit (257) passed; the server group passed 624 of 656, and the
30 failures (settings symlinks, queue-hold temporary directory names containing
`:`, two Stop timeouts) fail identically on unmodified main. The Chromium layout
group could not connect to its browser in this worktree (it runs in the previous
alignment's worktree); hosted CI qualifies it. Focused suites for every resolved
area passed, including the restored cancel test, PortScanner, packaging
externals, settings contracts and pull-request provider/service suites.

## Extension through a7025639c0 — 2026-10-17

The owner chose to extend this alignment in place rather than open a second one.

Generated with `pnpm alignment:facts --merge 0ebeec9e50`:

- Owned base: `e983657a24a7e75db5920dd1ce8950d1b028ec19`, the head of Scient PR #574.
- Previous official boundary: `86f4a74c5d789f2b4973616775a6adf19525bf4d`.
- Frozen official target: `a7025639c0e16aad3081106c935bf3025f601a1e`, no tag at the
  target (nearest reachable: `v0.1.1-nightly.20261017.3238`).
- Range: 176 official commits, 3323 incoming paths, 1074 same-path overlaps with
  Scient, 420 initially unmerged paths.
- Literal integration merge: `0ebeec9e509336fc22bb107148dbecf64d9e9163`, tree
  `fdb087fc39a00dd5614925bd4e9ca884c212b83c`; parents are the owned base and the
  frozen official target.
- Owned-main catch-up: merge `a48eb408ffc3e5aa196ec9ac21c82cd12cb901d2` of owned
  main `5c94afd2385c390346efdef2158dc01590c73293` (Scient PR #575, sidebar section
  placement). It does not change the official merge.

### Integrated behavior and composition

The range brings upstream's React Compiler adoption across the web client, a
comment prune across the repository (#19559), live command output (#15094),
subagent fixes (resumed Claude subagents, renamed worktree branches, shared and
orphaned worktree cleanup, restart wakes), background compaction and `t3 doctor`
database reclaim, queued follow-ups during compaction, host-folder browsing in the
file panel, Expo SDK updates, CI speedups, and upstream's npm launcher (#20148).

Meaningful compositions:

- **Comment prune.** 400 of the 420 conflicts came from #19559. Every hunk whose
  upstream side differed from the base only in comments was resolved to Scient's
  code, with upstream's deleted comment lines removed where they appeared verbatim;
  the oxc parser confirmed the comment-free code equals Scient's side. 290 files
  resolved fully this way and 54 partially.
- **React Compiler policy.** Upstream's listed files must compile without bailouts
  and without manual memoization. Scient code in those files (ChatView, the
  timeline, composer, Tiptap editor, sidebar, command palette, queue control and
  others) follows the same rules; `try/finally` became `settlePromise` and
  render-time ref writes moved to layout effects. Two list entries name files
  Scient had already replaced (`useDirectoryEntries.ts`, `useQueuedRunEdit.ts`)
  and were removed with them. ChatView's timeline inputs moved into the compiled
  `useThreadTimelineEntries` hook after review found an uncached derivation that
  re-rendered without end.
- **Reader and queue.** The timeline keeps Scient's single reading-position owner
  on upstream's list-state snapshot. Queue keyboard decisions live in
  `scient/threadQueue/queueShortcuts.ts`, mounted from ChatView's shortcut map.
- **Server.** Live command output and the git driver for renamed subagent branches
  are composed into Scient's session manager and event ingestor; resumed-subagent
  adoption feeds Scient's workflow routing; storage cleanup's shared-worktree
  recheck uses Scient's archived-thread snapshot. SQLite adopts incremental
  auto-vacuum for new databases and keeps `synchronous = FULL`.
- **Database reclaim.** The storage notice shows the command for this
  installation (Scient's resolved CLI command); doctor errors name Scient.
- **Pairing (#20432).** Adopted by owner decision: pairing and issued sessions
  grant access and relay management by default. Relay remains switched off.
- **Background subagents (#19751).** Adopted by owner decision: a background
  subagent keeps its MCP tools after the parent's turn ends. Scient's write
  authority still comes from the credential's live native session; with no open
  run, its own provider thread must report a subagent on the caller's instance,
  and writes use the runtime and interaction modes captured by the run that
  started it.
- **Publication.** Scient publishes no npm package: upstream's npm launcher
  sources are not carried and `cli.ts publish` is not called by any Scient
  workflow. `release.yml` is unchanged from #574. Mobile workflows keep the
  publication hold.
- **CI.** Scient's job structure, names and GitHub-hosted runners are kept.
  Adopted: the cached `setup-ci-deps` action, the vendored-binary sparse
  exclusion and the server-shard Chromium cache. Upstream's per-change job gating
  is not adopted; its clean-merged references assumed jobs Scient does not have.
- **Dependencies.** Scient's Expo patches apply unchanged to `expo-modules-core`
  58.0.22 and `expo-notifications` 58.1.5. The enriched-Markdown native patch is
  ported to tarball t3.15; its control-character hunk is dropped because t3.15
  decodes numeric character references itself. A marked override pins
  `@types/hast` to 3.0.4: `@pierre/diffs` ships hast 3.0.4 declarations, and a
  mixed resolution broke the web typecheck.
- **Lint.** Upstream's `no-low-value-comments` rule now applies to Scient files;
  their section dividers were removed. One explained disable covers a YAML format
  example.
- **Docs.** Pairing defaults, database reclaim and the release note are in
  Scient's words; upstream's mobile app-store row and its T3 links are not adopted.

Upstream-owned leftovers left as upstream has them: the sidebar change-request
snapshot atom in `ThreadStatusIndicators.tsx` lost its consumer upstream (#20396);
the files are identical to upstream.

### Separation

Measured with the protocol's host-line command and the divergence inventory
(upstream `a7025639c0` for the candidate, `86f4a74c5d` for the base `e983657a24`):

| Measure                            | Before              | After               |
| ---------------------------------- | ------------------- | ------------------- |
| Scient lines inside upstream files | 49,994 in 869 files | 50,010 in 880 files |
| Marked regions                     | 1,364               | 1,548               |
| Unmarked divergence (`new-debt`)   | 12,622              | 12,296              |

New Scient-owned modules: `apps/server/scripts/scientServerAssets.ts`,
`apps/web/src/scient/math/scientMathText.ts`,
`apps/web/src/scient/threadQueue/rememberedComposerCursor.ts`,
`apps/web/src/scient/threadQueue/queueShortcuts.ts`,
`apps/web/src/scient/fileSurfaces/scientFilePanelProps.ts` and the server test
helper `orchestration-v2/testkit/ProviderRuntimeTestServices.ts`. Dead Scient
code removed: unused composer chip class names (the file now matches upstream)
and a stale module header.

### Review and qualification evidence

Two independent Codex (gpt-6.1-sol, extra-high) reviews covered server/runtime and
clients/CI/dependencies. Findings and responses:

- ChatView's compiled timeline inputs re-rendered without end (P1): fixed in
  `af81eac823` with a regression test that fails without memoization.
- Two new upstream recovery tests assumed restart continuation, which Scient ships
  off (P2): they opt in through a marked fixture (`ec8d77f19b`).
- Dead upstream snapshot code (P3): left as upstream has it, see above.
- The integrator found that the merge had deleted the only test for Scient's
  queue shortcuts; restored with the logic as a Scient module (`18ff6fdff9`).

A second Codex round on `a48eb408ff..af81eac823` found nothing blocking: the
timeline inputs stay stable and invalidate on change, the queue shortcut module
preserves the previous behavior, and the recovery opt-in leaves the product
default unchanged.

Local evidence on Windows 11, Node 24.21.0, pnpm 11.10.0:

| Check                     | Result                                                                  |
| ------------------------- | ----------------------------------------------------------------------- |
| `pnpm alignment:gates`    | fmt, lint, typecheck (160 s), build (174 s), smoke, brand, diffs passed |
| Test aggregate            | Not run: not a supported Windows lane; hosted qualification pending     |
| `knip:check`              | Passed                                                                  |
| Seams                     | All five groups passed against `e983657a24` and `a7025639c0`            |
| Boundary checks (`--run`) | Shared 107, web unit 294, Chromium reader layout 61: all passed         |
| Boundary checks, server   | 635 of 665 passed; 30 failures are the Windows host failures below      |

The server failures are the same Windows host classes recorded above: settings
symlink creation (EPERM), queue-hold temporary directory names containing `:`, and
two Stop timeouts whose fake process has no Windows SIGTERM handler. Lanes and
reviewers also ran focused suites for every resolved area; their remaining failures
are in the same classes or path-separator assertions that predate this range.
The full gate ran on `af81eac823`; later commits change only this receipt,
`UPSTREAM.md` and `upstream-state.json`.

The first hosted run on `eacfe4d162` failed five server tests that no Windows lane
had run; all are test-side composition, fixed together:

- Upstream's compaction (#19435) now keeps each entity's first event and lets a
  visit supersede only other read-state events. Two Scient tests relied on the old
  deletions: the legacy citation repair now removes the original event itself, as
  earlier releases' compaction did, and the workspace-authority test adds a
  superseded metadata update.
- The compute-bridge location tests read `cli.ts` source; they now compare the
  runtime layout with the asset list `scientServerAssets.ts` exports.
- Codex's provider probe waits 20 s (#15945); the Scient timeout test advanced 11 s.
- Upstream's new node-pty console-list test exercises upstream's node-pty patch.
  Scient stays on node-pty ^1.1.0 without that patch, so the suite is skipped
  (marked) and #18519's Windows helper fix is not active in Scient until the
  node-pty decision is made.

Process notes for the next alignment: concurrent `pnpm install`s in one worktree
(started implicitly by `pnpm exec` while dependencies were stale) and a stalled
in-place install cost about two hours; the fresh install took 26 minutes. Lanes
now run tools from `node_modules/.bin` and wait for one integrator install.

## Publication boundary

This candidate integrates source only. Merge, release and mobile publication are
separate authorizations.
