# Native V2 Agents and workflow parity

This receipt describes the Agents lane on the dirty alignment candidate based on
`b8fbae4ffa84414b02461cf42a0afa4b10a03fcc`, during its catchup merge of owned main
`33ab8e307afbabda3e155c439d89bc788148d379`. It does not claim an immutable final
candidate, a live-provider session, or visual/manual acceptance.

## Preserved behavior and authority

Optional `OrchestrationV2Subagent.presentation` stores observed role, effort,
workflow identity/phases/member position/attempt, usage, last tool, output path,
first observation and display handles. Ordinary old V2 entities remain readable.
These fields do not allocate provider sessions, grant capabilities, or authorize
continuations. Workflow member slots have no child thread or native task reference,
use `runId: null`, and their nodes have `countsForRun: false`.

Claude's native task progress produces bounded, deduplicated workflow phases and
slots. Sparse settlement retains identity, usage fields, and first observation;
terminal propagation settles only unfinished members of the same workflow. Native
session updates require an explicit authoritative reopen marker to reactivate a
settled task; late running progress is ignored. OMP has no proven generation marker,
so its existing terminal barrier remains intact.

Usage retains any observed nonnegative integer count, including tool counts without
a token total. Empty or invalid observations do not create usage. Sparse cumulative
frames merge fieldwise by maximum within one activation; an authoritative activation
clears its prior counters. The panel sums observed token totals only, preserves a real
observed zero, and displays `— tok` when no member has observed token totals. Idle
authoritative starts advance the coordinator generation before buffering; their queued
progress drains with that generation instead of the old terminal context.

The Agents panel consumes native entities. The pending approval/input model remains
separate. A single workflow coordinator now opens the rich roster from the timeline;
existing child-thread navigation remains available. The inactive Agents tab counts
working members without counting a coordinator twice.

Imported V1 activity records contribute namespaced historical display rows only.
The decoder requires migration-owned activity identities and null runtime/node/native
bindings. Unfinished imported running, pending, and waiting tasks become interrupted, contribute no
live count, and create no approval or execution response. Observed historical idle
status remains visible with neutral Idle copy and no resumable or phase-liveness authority. Historical script paths remain visible
metadata but cannot fetch current workspace bytes. Historical approvals remain inert.
Older historical roster entries are recovered as their timeline pages are loaded.

Claude's MCP server namespace and exact read-only allowlist use canonical Scient
names. `scient_thread_read` is allowed in the read-only sandbox while retaining its
separate host `threads:read` capability requirement. `scient_thread_inspect` remains
excluded because it acknowledges child results.

Native workflow ingestion requires an accepted strong coordinator identity from the exact
provider session, instance, driver, root thread, and owning run. Runless member rows and
nodes are accepted only under that coordinator, with null native/control bindings.
Unowned, sibling, mismatched-instance, or mismatched-native references are rejected.
Root completion retains its background subscription; idle progress and final member/node
receipts reach SQLite. Claude settles members before its coordinator clears the last
owned background item. Query failure, cancellation, and interruption settle only the
same native process's owned workflows. Late progress cannot reopen a terminal
coordinator; an authoritative coordinator activation can reopen its member generation.

Accepted member linkage outlives the member row's terminal receipt, so interruption
between that receipt and its node receipt still cleans the node. Coordinator transfer
revokes the old subscriber's member/node snapshots, exact turn-item IDs, child-thread
routing, and lifetime linkage. Routing, persistence, and tracking run in one sequential
stream step so a chunk cannot apply a later transfer before tracking earlier rows.

## Executed evidence

Evidence files are in
`/Users/yaacov/REPOs/ScientFactory/reviews/orchestration-v2-alignment-20261003/`.
All checks used the root Vite Plus configuration and one serialized worker.

- `workflow-counts-tests-round2.txt`: 26 selected producer/codec/mapper/UI/routing
  cases passed across six files, with 213 filtered out. Count-only first observations,
  sparse counter updates, exact-owner idle start/progress drain, terminal protection,
  and null checkpoint authority rejection are covered. The first run reproduced a
  stale activation count that retained completed member status; the authoritative
  idle pre-open now advances its presentation generation once, and the regression passes.
- `workflow-counts-consumers-round1.txt`: all 62 cases passed across six complete
  codec, client mapper, historical decoder, rendered panel, presentation merger, and
  actual scripted SDK → SQLite integration files. Unknown and observed-zero totals,
  invalid counts, sparse/late counters, and historical authority remain qualified.
- `workflow-counts-server-compiler-round1.txt` and
  `workflow-counts-web-compiler-round1.txt`: both canonical package compilers exited
  zero with no errors or warnings; Effect suggestions remain visible. Scoped formatter
  exited zero in `workflow-counts-fmt-round1.txt` / `round2.txt`. Scoped lint exited zero
  in `workflow-counts-lint-round1.txt` / `round2.txt`; the included MessagesTimeline file
  retains existing React reader hook/ref/memo advisories, none suppressed.
- `workflow-runtime-tests-round6.txt`: 14 selected cases passed across five files.
  Includes actual scripted Claude SDK → session manager → RunExecution → event ingestion
  → SQLite preservation after root settlement, idle usage updates, and member/node
  completion; late coordinator progress, authoritative activation, query failure/
  interruption, exact identity rejection, terminal-row/node races, transfer release,
  and historical idle model/rendering authority. The other 172 cases were filtered out.
  Initial proof failed because coordinator completion closed ingestion before trailing
  member receipts; source ordering was repaired and the actual pipeline now converges.
  Initial startup timeout was three seconds while real Git checkpoint preparation took
  about seven seconds; the test uses bounded ten-second durable event observation.
- `workflow-runtime-fmt-round3.txt` / `workflow-runtime-lint-round3.txt`: scoped formatter
  and lint exited zero for the affected runtime, adapter, test, and historical UI files.
- `agents-native-parity-round2.txt`: 195 native producer/codec/mapper/history cases
  passed across six files. The additional timeline file had one failing attachment
  fixture at that checkpoint; its final rerun below closes that failure.
- `agents-ui-final-round2.txt`: 109 cases passed across timeline, Agents panel, and
  right-panel attention/badge tests. Includes native workflow CTA, status/timers,
  anchor/disclosure behavior, phases/member role, and historical script isolation.
- `agents-workflow-transport-round4.txt`: one actual SQL → HTTP bounded snapshot →
  websocket snapshot/replay case passed. The other 234 server cases were filtered
  out. Exact metadata equality and grouping survive transport; member authority and
  runtime request absence are asserted. The fixture includes the native coordinator's
  timeline item, which anchors its completed members in the bounded cohort.
- `agents-badge-readonly-round1.txt`: badge behavior and the actual toolkit read-only
  annotation invariant passed; 127 unrelated cases were filtered out.
- `agents-historical-script-round1.txt`: native script control remains available;
  historical script control is absent. Later UI rerun strengthens member display.
- `agents-parity-fmt-round2.txt` and `agents-parity-fmt-round3.txt`: scoped formatting
  passed. `agents-parity-lint-round2.txt`: lint exited zero, with no unused declaration
  or inline schema compilation warnings in this lane. Existing React memo/effect/ref
  advisories remain visible for whole-candidate review; none was suppressed.

The initial 94/105 timeline checkpoint was repaired without enabling arbitrary
LegendList end pinning: stale autonomous-follow expectations were migrated to the
bounded reader policy; compact paths preserve expanded details; task fixtures carry
their actual run identity; attachment assertions now supply bound records/bytes and
unique row IDs. No test was deleted, and new native UI coverage exposed and repaired
the single-coordinator consumer defect.

## Reproduction

```sh
node_modules/.bin/vp test run packages/contracts/src/orchestrationV2SubagentPresentation.test.ts packages/client-runtime/src/state/historicalSubagentRuntime.test.ts packages/client-runtime/src/state/subagentRuntime.test.ts apps/server/src/orchestration-v2/Adapters/SubagentPresentation.test.ts apps/server/src/orchestration-v2/Adapters/NativeSessionAdapterV2.test.ts apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts --maxWorkers 1
node_modules/.bin/vp test run apps/web/src/components/chat/MessagesTimeline.test.tsx apps/web/src/components/AgentsPanel.test.tsx apps/web/src/components/RightPanelTabs.attention.test.tsx --maxWorkers 1
node_modules/.bin/vp test run apps/server/src/orchestration-v2/RunExecutionService.test.ts apps/server/src/orchestration-v2/testkit/ClaudeWorkflowRuntime.integration.test.ts apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts packages/client-runtime/src/state/historicalSubagentRuntime.test.ts apps/web/src/components/AgentsPanel.test.tsx --maxWorkers 1 --testTimeout 30000 -t 'workflow|routes inert'
node_modules/.bin/vp test run apps/server/src/server.test.ts --maxWorkers 1 -t 'preserves native workflow phases'
```

Compiler requalification and integrated visual/manual acceptance belong to the final
alignment candidate. No staging or commit was performed for this lane beyond the
three explicitly authorized timeline conflict resolutions.
