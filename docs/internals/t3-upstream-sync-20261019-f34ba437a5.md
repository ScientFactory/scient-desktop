# T3 upstream alignment, 2026-10-19 (through f34ba437a5)

## Boundaries

Generated with `pnpm alignment:facts --merge 9ef3f49f0d`:

- Owned base: `129f4af07bc3b78cab506086fcad0c5f12d7105f`.
- Previous official boundary: `d8e9fd267e26b7680f035edc0b40db09d2685dbb`.
- Frozen official target: `f34ba437a5dec23a205ef5f670f7b10439ae98eb`, no tag at the
  target (nearest reachable: `v0.0.46-nightly.20261009.2861`).
- Range: 84 official commits, 292 incoming paths, 146 same-path overlaps with
  Scient, 49 initially unmerged paths.
- Literal integration merge: `9ef3f49f0de3d380389e2e26d0ff9753ef37ff11`, tree
  `bb5edd3202698291f4deacc217ad227ea98cb6c2`; parents are the owned base and the
  frozen official target.
- Owned-main catch-up: `667f48d7916020076ac97190ef84748566aaf06a` of
  `7d6bd586a47220c44c880077fb64cf47e8fa9a78`, carrying landed replay-workspace
  safety, provider-runtime reconnect work and approved release notes.
- Qualification-fixture follow-up: `0ad0b7dde69723273861d00f8f20aa0d85c3a142`.
- Image-refresh composition follow-up: `479dfd46d17cf22f8a33eadfdf2323b675e7803f`.
- Branch: `codex/t3-sync-f34ba437a5-20261019`; upstream push URL: `DISABLED`.
- Scient PR: [#607](https://github.com/ScientFactory/scient-desktop/pull/607).

## Integrated behavior and composition

All commits in the frozen official range are in ancestry. This pass brings native
queue and delegated-task repairs, browser PDF navigation, large changed-file-tree
virtualization, palette navigation, browser search settings, model-selection fixes,
terminal and remote reliability, provider fixes, and shared React/native-PDF
dependencies.

- **Queue and Stop.** Native V2 remains the only execution authority.
  `scient-fork/QueuedRunSend.ts` remains the only direct-Send release policy:
  an ordinary direct user Send must actually start its own nonqueued run.
  Queue, Steer fallback, Restart, continuations and non-user work do not release it.
  Queue-row Send uses native resume ordering, automatic priority then the chosen
  row then the remainder. `TerminalQueueHold.ts` keeps current-attempt and release
  receipt fences, before promotion. Shared Stop lookup uses the pure current-root,
  active-attempt and native-thread/turn predicate in `RunStartDecisions.ts`;
  historical interrupts do not block a later execution.
- **Delegated children.** Adopt upstream queued-task status synchronization before
  result readiness checks. A failed Codex root may end without cancelling its live
  native children. Scient still withholds its app-owned task result until those
  children settle. `DelegatedChildSettlements.ts` subscribes to filtered native
  settlement events and calls the existing parent-locked finalizer, not another
  result owner. Both tagged and older untagged runs retain the readiness gate and
  transfer deduplication.
- **PDF contexts.** Workspace/environment documents retain Scient's local pinned
  PDF.js 6.2.108 reader, authorized revision-scoped ranges and per-conversation
  reading state. Attachments retain their embedded document surface; browser tabs
  remain a third context. Upstream's browser PDF fallback is retained, but Scient's
  HTML-print command rejects PDF assets before printing or publishing a placeholder,
  and the UI disables that export for streamed PDF tabs. This is not attachment
  unification or a second PDF reader.
- **Palette and settings.** Keep upstream navigation and reducer structure.
  Delayed browse resolution commits through a functional currentness check so it
  cannot replace later typing. Adopt partial model-identity selection, clearing
  the previous model's options. Keep one settings-restore hook and Scient's
  in-app browser default.
- **Providers and presentation.** Preserve request-bound MCP registration and
  Scient's actual tool names, OpenCode capability-aware injection, model-picker
  behavior, project-action terminal separation, preview refresh, content direction
  and scientific renderers. Removed Mermaid tests targeted an unmounted renderer;
  live isolated-renderer coverage now also checks generated MathML, spaced-math
  PNG export and unsafe MathML label attributes/resources.
- **Image refresh.** Scient standalone image cards share
  `images/useWorkspaceImageRefresh.ts` with upstream's inline media path.
  Workspace edits coalesce while a request waits, then refresh the latest
  revision; unversioned ordinary chat stays cached. File previews retain decoded
  pixels through mere capability refresh/failure, but not across an explicit
  workspace revision. A still-waiting asset cannot be retained as that new revision.
- **Persistence and dependencies.** Incoming pull-request-link canonicalization
  becomes migration 068; existing migration identities and retained V1 readers
  remain intact. Rebuild tests initialize Scient's projection schema too.
  Compose the React catalog, native PDF patch and license configuration, regenerate
  the lockfile and synchronize configured license notices.

## Protected boundaries

Scient identity and compatibility-sensitive package, protocol and storage names
remain. SQLite stays FULL; `doctor` still cannot delete the original database.
Workspace authorization and re-resolution, document leases and publication
currentness remain authoritative. There is one actual-answer acknowledgement
writer, not an incoming second visit-watermark mount.

The existing Scient analytics adapter, destination, consent and bounded allowlist
remain unchanged. Recognized release builds keep available/default-on diagnostic
analytics and honor saved Off or narrower levels; development remains off without
explicit configuration. Incoming `mcp.tool.invoked`, `mcp.delegated_task.finished`
and generic feature counters are not added to Scient's contract. Unknown events
are dropped by its existing normalizer. `ScientMcpAnalytics.ts` only maps live tool
names to inherited metric identifiers and observes Effect's JSON-text result
truthfully; it does not change transport encoding or authorize collection.

Cloud, relay, OTLP, mobile publication, updater repositories, signing and release
authority are not activated. The donor-only release workflow remains absent;
Scient's release workflow is retained. Preview build telemetry metadata stays
development-only outside the official repository.

## Separation evidence

This is structural evidence for the **literal integration interval**, not a claim
that the receiving tree has no ownership debt or that counts prove behavior.
Use the protocol's host-line command and the existing advisory inventory with:

```text
official = f34ba437a5dec23a205ef5f670f7b10439ae98eb
base = 129f4af07bc3b78cab506086fcad0c5f12d7105f
candidate = 9ef3f49f0de3d380389e2e26d0ff9753ef37ff11
candidate tree = bb5edd3202698291f4deacc217ad227ea98cb6c2
```

Same official snapshot, paths and exclusions on both sides:

| Measure                                                        |   Base | Literal merge |
| -------------------------------------------------------------- | -----: | ------------: |
| Added non-test lines in official `apps/` and `packages/` hosts | 52,115 |        50,778 |
| Official hosts with such added lines                           |    918 |           857 |
| Advisory new-debt findings, full inventory                     | 13,341 |        12,485 |
| Unresolved findings, full inventory                            |    128 |           124 |

The declared policy-host scope is `Orchestrator.ts`, `CommandPalette.tsx` and
`settings/scopedSettings.ts`. Added host lines fall from 2,534 to 2,420;
scoped new-debt findings fall from 369 to 325. Existing Scient owners stay outside
those hosts; shared Stop policy replaces a duplicated host predicate, upstream
palette mechanics stay upstream, and model-identity merge behavior converges.
Full-inventory marked findings are 1,699 then 1,710. No baseline, format exception,
source-count test or automatic ratchet is introduced. Substantial pre-existing
unmarked and unsupported-format debt remains advisory.

The receiving source `479dfd46d17cf22f8a33eadfdf2323b675e7803f`, tree
`355e467e20bf5023b6a6fdc57fc88c4e9a9a9517`, was measured again against the same
official target, base, paths and exclusions: 50,794 added host lines in 857
hosts, versus the base's 52,115 in 918. The three declared policy hosts are
byte-identical to the literal merge, so their 2,420 host lines and 325 advisory
new-debt findings carry forward unchanged. Full-inventory numbers above describe
the literal merge only. Host-line counts exclude candidate-only Scient modules;
they are not total product-code size.

## Qualification

Source candidate: `479dfd46d17cf22f8a33eadfdf2323b675e7803f`, tree
`355e467e20bf5023b6a6fdc57fc88c4e9a9a9517`; macOS 25.6.0, Node 24.19.0,
pnpm 11.10.0.

- Independent queue/PDF follow-up review found no remaining findings in the
  inspected repairs. Synthetic regressions do not establish real-provider behavior.
- Focused runs passed: 195 queue tests; 366 repaired mixed tests; 83 browser tests;
  34 live Mermaid Chromium tests. Later tagged/untagged settlement and SQLite
  regressions passed 53 tests; Linux icon fixtures passed 17.
- Image follow-up: 1,892 tests in nine files passed, including React Compiler
  coverage, real-registry image refresh across inline/standalone/file presentation,
  retained-pixel lifecycle, permissions, mini-player, palette and timeline fixtures.
  Web types and scoped lint passed (one existing unused test constant warning).
- Independent review of the exact image follow-up found no actionable findings.
  It traced both mounts, pending-request coalescing, authorization and retained
  revision boundaries; it did not rerun tests or establish visual acceptance.
- Five alignment seam checks, provenance against exact owned main and official
  target, mobile native static checks and synthetic release smoke passed.
- Complete serial gate at `0ad0b7dde6`: formatting, lint, knip, all package
  typechecks, build, desktop smoke, brand and both diff checks passed. Tests failed
  only in web: 14,679 passed, eight failed.
- Complete serial gate at `479dfd46d1`: the same nine non-test gates passed.
  The aggregate test command reported one failed workspace, web: 14,696 passed
  and three dynamic-import timeouts. All three affected suites then passed
  unchanged in isolation, 13 tests in 994 ms. The complete web workspace then
  passed with `pnpm --filter @t3tools/web test --maxWorkers=4` and a synthetic
  home: **14,699 tests, 1,087 files, 166.34 seconds**. No timeout, assertion or
  source change accompanied that bounded-load rerun. The failed aggregate remains
  recorded as failed; local qualification combines its passing other workspaces
  and non-test gates with this complete passing web rerun on the same source tree.
  Only maintainer documentation was uncommitted during these checks.

Earlier full-gate attempts failed and are not counted as passes: first, the raw
`ArrayBuffer` SQLite fixture was unsupported by Node 24.19; then Effect test
registration/types and Linux icon fixtures assumed case-sensitive host storage.
The follow-up uses native blob views and parameterized tests, detects actual
filesystem semantics and preserves distinct-icon assertions on case-sensitive
filesystems. Product SQLite and Linux icon behavior were not changed. Later web
failures exposed the missing standalone-card refresh composition, an incomplete
mini-player navigation mock, a Ctrl-only shortcut fixture on macOS and an
exactly-once measurement assumption invalid for a real decoded image. These were
repaired without replacing the actual browser-layout assertions. The generated
attachment fixture now uses decodable local pixels rather than an unreachable URL.

Hosted CI was first read at `0ad0b7dde6`: queued. Upstream provenance, Check and
Web 3 jobs passed; the run remained in progress, with Windows Python 3.10 failing
during runner setup before checkout. This is not final-head qualification. Native
Windows/Linux/mobile and live-provider checks remain separate from macOS static,
mocked and headless-browser evidence. Per owner instruction, isolated exact-head
development-app review is last. Any agent turn exercised inside it must use Codex
with Luna 6.

## Publication boundary

Draft-PR delivery does not authorize merging, merge queue, auto-merge, a desktop
release, publication or changes to cloud, telemetry, signing or mobile holds.
After literal ancestry/provenance and local qualification, the recorded cursor
advances to the exact frozen target with `9ef3f49f0d` as `lastRefreshMerge`, not
the owned-main catch-up. Hosted final-head CI and isolated app review remain
distinct qualification and acceptance boundaries.
