# Orchestration V2 server verification handoff

Recorded 2026-10-04 for the shared alignment worktree
`scient-t3-sync-ca7df394ed-20261003`. The merge was still pending:
HEAD `ad215fd9157e86252a2ee1187e746b65c8b003be`, MERGE_HEAD
`ca7df394ed8151fa77f856beefa90bc60a785d60`. These identify the merge inputs,
not an immutable final patch. Requalify changed paths against the final candidate.

## Executed qualification

Evidence files are under
`/Users/yaacov/REPOs/ScientFactory/reviews/orchestration-v2-alignment-20261003/`.
Counts below overlap; do not add scoped runs to the complete suite count.

| Path                                                       | Executed result                              | Evidence                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Complete `server.test.ts`                                  | 233/233 passed, no skips, 36.37 seconds      | `server-full-round5.txt`                                                                       |
| Startup, CLI, runtime-layer suites                         | 97/97 passed across three files              | `startup-bin-runtime-round2.txt`                                                               |
| Active/deleted identity rejection and exact CORS contracts | 7/7 passed                                   | `server-identity-cors-round1.txt`; also included in the complete suite                         |
| Actual HTTP legacy/compact snapshot equivalence            | 1/1 passed after final schema compiler hoist | `server-http-equivalence-round2.txt`; substantive assertions also passed in the complete suite |
| Durable cleanup completion and settlement protections      | 71/71 passed across three files              | `server-cleanup-round2.txt`                                                                    |
| Production MCP inventory and ownership                     | 2/2 passed                                   | `server-mcp-ownership-round1.txt`                                                              |
| Server test formatting/lint                                | Exit 0; final lint output empty              | `server-owned-format-round11.txt`, `server-owned-lint-round11.txt`                             |
| Startup/CLI scoped lint                                    | Exit 0; output empty                         | `startup-bin-lint-round1.txt`                                                                  |

Run from the worktree root with the default root Vite Plus configuration:

```sh
./node_modules/.bin/vp test run apps/server/src/server.test.ts --maxWorkers 1 --testTimeout 10000 --bail 8
./node_modules/.bin/vp test run apps/server/src/serverRuntimeStartup.test.ts apps/server/src/bin.test.ts apps/server/src/orchestration-v2/runtimeLayer.test.ts --maxWorkers 1 --testTimeout 10000
```

The final complete server run supplied `T3CODE_TRANSFER_BUDGET_REPORT_PATH`
and `T3CODE_TRANSFER_BUDGET_RESULT_PATH`, producing
`server-transfer-final-round3.md` and `.json`. All original budgets passed:

| Measurement                           |  Codex | Claude | Budget |
| ------------------------------------- | -----: | -----: | -----: |
| Cold bounded HTTP snapshot wire bytes |  4,463 |  4,473 |  5,000 |
| Measured turn WS wire bytes           |  1,312 |  1,353 |  2,000 |
| Measured turn WS decoded bytes        | 26,333 | 26,758 | 30,000 |
| Measured turn WS frames               |      1 |      2 |      8 |
| Total thread wire bytes               |  5,775 |  5,826 |  7,000 |

The fixture retains ten historical turns with five command tools and one
900,000-byte MCP result per turn; the measured turn has twenty command tools
and one 1,100,000-byte result. No threshold, retained count, payload entropy,
projection array, or production compression level was weakened. Startup uses
the shared client's bounded HTTP window and negotiated compact codec. Earlier
pages reconstruct complete history. The prior unbounded full-endpoint
measurement (5,871/5,882 bytes) remains evidence of the earlier failing path;
it was not relabeled as a passing measurement.

## Preserved behavior and intentional native semantics

- The server test fixture uses actual V2 EventSink, projection, orchestrator,
  manager, worker/outbox, project, and native launch services. Provider/OS seams
  are controlled where the scenario requires them; the V1 execution engine and
  V1 read model are not fixture authority.
- Streaming tests cover a held live RPC ACK with producer detachment and
  authoritative recovery, snapshot races, coalesced tools without crossing
  message/terminal ordering boundaries, concurrent commits beyond replay
  high-water, unrelated-thread fairness, same-connection transient projection
  retry, large output/detail retention, reasoning, and deleted tombstone
  convergence. SQL retains tombstones; clients retire the deleted route/cache.
- Actual shared WS RPC tests cover V2 creation, section assignment, exact clicked
  boundary fork, rejected running-fork baseline capture, and preserved history
  pagination. Provisioning runs through the actual native worker.
- A fresh public `thread.create` cannot overwrite an existing UUID, including
  a deleted tombstone. The old behavior was reproduced retaining the old
  authored transcript. The narrow admission guard preserves command-receipt
  retries. Actual WS acceptance verifies a fresh replacement starts empty and
  the old setup completion cannot mutate it or resurrect the deleted thread.
  Defensive raw-event cache recreation remains separately tested.
- Launch acceptance is asynchronous and durable. A later launch failure keeps
  the authored message and failed run. Explicit worktree failure does not fall
  back to the project root. A synchronous setup script is a required gate;
  asynchronous setup may release provider work and later report tracker failure.
  An actual SQLite trigger proves a successful script cannot mask failed durable
  run release.
- Cancellation cleanup clears binding only after successful owned-worktree
  removal. Removal failure retains the path/branch, actual folder, authored
  history, and tracker error.
- Archive/settlement tests use actual native sessions and outbox transitions.
  Native detachment removes the projected session binding. Stable blocked
  settlement prose remains a typed native rejection with unchanged history.
- Cleanup completion hints are bounded and coalesced, installed before the
  initial sweep, and emitted after durable success/cancellation. Cleanup rereads
  SQL authority and retains hourly missed-hint/crash recovery. Dirty, ignored,
  shared, and moved-head worktrees stay protected.
- One composed production MCP toolkit supplies registration and host ownership
  inventory. Scient's import-aware native `t3_thread_read` is the sole production
  owner; generic upstream read remains available only to its scoped consumers.
  Production capability and read-only filtering are preserved.
- Actual HTTP equivalence verifies both declared codecs restore identical full
  snapshots, including cursor/history metadata. Exact canonical local records
  use references preserving position/visibility/source IDs. Noncanonical
  inherited records remain inline. The legacy endpoint shape is unmarked and
  contains inline records without reference fields.

Startup fixtures now merge independent layers in one provision while retaining
the same captured native ThreadManagement instance. A model-switch fixture now
seeds its actual ProjectStore owner; missing projects are not silently supplied
with a fallback workspace.

## Scope limits

These are local synthetic-provider/persistence/network tests, not live-provider,
Electron startup, remote SSH, native mobile UI, or manual visual acceptance.
They do not independently qualify the external agent's entire legacy migration
slice. Complete repository gates, final immutable patch review, and manual app
review remain integration-owner responsibilities. The complete server run
preceded an equivalent module-scope schema compiler hoist; the final focused
HTTP test and empty lint output qualify that last test-only change.
