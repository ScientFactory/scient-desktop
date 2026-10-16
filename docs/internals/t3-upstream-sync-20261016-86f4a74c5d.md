# T3 upstream alignment — 2026-10-16 (through 86f4a74c5d)

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
- Branch: `codex/t3-sync-86f4a74c5d-20261016`; upstream push URL: `DISABLED`.

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

## Publication boundary

This candidate integrates source only. Merge, release and mobile publication are
separate authorizations.
