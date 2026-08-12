# Scient analysis runtime foundation

Status: local implementation candidate for review. This is not a release record and does not
claim licensed MATLAB acceptance. The implementation is based on Scient Desktop main at
`f2742c81b855faee7e2a81e91f0babfd508423d0`, which contains the PDF foundation commit
`a8de151b798219abaddacf8867a0c4d0283ca3d7`.

## Decision

The first vertical slice runs a saved, project-owned `.m` file with a user-installed MATLAB and
shows local streaming output, Stop, terminal state, and per-file history. It also establishes the
runtime-neutral contracts needed by later Python, R, notebook, typesetting, and agent-triggered
execution without pretending those integrations already exist.

The candidate follows the Scientific Computing and Data Analysis roadmap owned in the Scient
documentation repository. The user explicitly selected MATLAB as the first analysis proof. That
changes adapter sequencing, not the shared architecture or the later Python/R parity gate.

## Owned boundaries

| Boundary                   | Owner                                           | Responsibility                                                                                                                                      |
| -------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Execution vocabulary       | `packages/scient-execution`                     | Run IDs, statuses, transition rules, bounded output records, receipt base, process port, and deterministic simulator                                |
| Analysis specialization    | `packages/scient-analysis`                      | Runtime profiles, adapter contract/registry fields, source revisions, run actions, analysis receipts, stream events, and simulator                  |
| Host execution             | `apps/server/src/scient/execution`              | No-shell process spawn, stdout/stderr transport, exit observation, and owned process-tree cancellation                                              |
| Analysis coordination      | `apps/server/src/scient/analysis`               | Adapter inspection, source/revision checks, lifecycle, cancellation race handling, output bounds, local journal, recovery, history, and RPC service |
| Client projection          | `packages/client-runtime/src/state/analysis.ts` | Summary/snapshot/delta folding and bounded query/subscription lifetime                                                                              |
| Scient file extension seam | `apps/web/src/scient/fileSurfaces`              | Routes format-specific auxiliary surfaces without teaching the inherited viewer about MATLAB or future runtimes                                     |
| Shared file truth          | workspace read/write RPC                        | Content revision, conditional save, atomic replacement, truncated-save refusal, and permission preservation                                         |

The inherited `FilePreviewPanel` receives one Scient auxiliary-surface hook and the existing
Scient language override. Runtime matching, MATLAB UI, and future additions stay below
`apps/web/src/scient`. This is the intentional T3 conflict-containment boundary.

The generic file-truth changes are protected upstream seams: `WorkspaceFileSystem`, the project
read/write contract, `FileSaveCoordinator`, and the single `FilePreviewPanel` auxiliary mount.
Every T3 refresh that touches those files must preserve conditional-write/truncation behavior and
rerun the static viewer-seam audit; MATLAB names, commands, and routing must not move into the
inherited panel.

## Run flow

1. Opening `.m` source remains independent of MATLAB discovery. Missing or invalid MATLAB never
   blocks viewing or editing.
2. A read returns a SHA-256 content revision. Autosave writes conditionally against the last
   confirmed revision and returns the new revision after atomic replacement.
   A per-resolved-file mutex closes in-process compare/write races without serializing unrelated
   project files.
3. Run is disabled while a save is pending. Start also rereads the file and rejects a stale,
   truncated, non-text, outside-project, unsupported, or already-active source.
4. The registry resolves the requested adapter. The MATLAB adapter discovers an explicit path,
   `PATH`, or conventional installation without launching MATLAB.
5. The host spawns the exact executable directly, never through a shell. MATLAB receives the
   static `-batch` expression `run(getenv('SCIENT_MATLAB_ENTRYPOINT'))`; the absolute source path
   travels in the environment so spaces, quotes, and shell metacharacters do not alter the
   command.
6. The server streams bounded stdout/stderr deltas, journals output before publication, persists
   lifecycle summaries atomically, and records the exact runtime profile, source revision, and a
   terminal SHA-256 over canonical captured output (ordered stream identity plus text).
7. Stop handles queued/starting/running races and asks the host adapter to terminate the owned
   process tree. App shutdown closes the server execution scope; an unfinished persisted run is
   recovered as `lost` on the next start.

## Performance and reliability budgets

- Captured process output is capped at 4 MiB per run. The truncation is explicit in the receipt
  and output, and terminal state is still preserved.
- One transport chunk is at most 256 KiB and respects UTF-8 boundaries.
- Adjacent process output is coalesced for at most 25 ms or 64 events, limiting state copies,
  journal writes, and websocket frames without making interactive output feel delayed.
- The server publication queue is bounded to 256 events. A slow subscriber applies backpressure
  instead of causing unbounded memory growth.
- List and lifecycle messages contain summaries, not accumulated output. Live streams send one
  active snapshot followed by summary updates and output deltas.
- Completed output is evicted from server memory. Full output is loaded from the append-only
  journal only for `analysis.getRun`; client detail atoms expire after one minute idle.
- The default history query returns 20 runs; callers may request at most 100. The file panel asks
  for 30.
- A start lock makes the source check and active-run registration atomic. Only one active run is
  allowed per project file, while unrelated files can run independently.
- Output journal decoding recovers valid records and adds an explicit system warning if records
  are unreadable. A corrupt journal cannot retain a misleading output hash. Interrupted-run
  recovery reconstructs output size and hash before writing the `lost` receipt.
- Runtime inspection is cached and invalidated after configuration or a launch failure. Discovery
  performs bounded conventional-directory reads and never scans an entire disk.

Per-run growth is bounded, but this first candidate does not silently delete old run directories.
Before general release, history needs an indexed/paginated store plus an explicit user-visible
retention and cleanup policy; the current directory-wide metadata load is an acceptance boundary,
not the intended shape for unbounded multi-year history. A hard “keep N and delete the rest” rule
is not an acceptable substitute until the product distinguishes disposable local logs from run
receipts retained as scientific provenance.

Run metadata and NDJSON output live under the environment's derived
`<state>/analysis` directory. Runtime settings are environment-owned, while run records are keyed
by durable Scient project identity. Standard project source remains the authority; hidden state is
not a replacement for `.m` files.

## PDF and artifact alignment

This slice consumes the same project identity, workspace file truth, server state derivation, and
Scient-owned package pattern as the PDF foundation. It does not create a second PDF source or
viewer. Later generated MATLAB figures, tables, HTML, SVG, and PDF outputs should register through
the document/artifact contracts introduced by the PDF lane and open through the shared file/surface
registry. Output-file discovery and artifact provenance are intentionally a later slice, not an
implicit directory diff in this one.

## Platform behavior

- macOS discovery checks `PATH` and `/Applications/MATLAB_R20xx.app/bin/matlab` candidates.
- Windows discovery checks both Program Files roots and uses `matlab.exe`; process-tree behavior
  still requires native Windows acceptance.
- Linux discovery checks `PATH` and `/usr/local/MATLAB/<release>/bin/matlab` candidates.
- A release such as `R2025b` is recorded when it can be derived honestly from the executable path.
  Unknown versions remain `null`; the candidate does not launch MATLAB merely to decorate the UI.
- GUI shell environment differences are handled by conventional discovery and an explicit path
  setting.
  WSL, remote runtimes, environment modules, license state, and toolbox state need later adapters
  and acceptance fixtures.

## Current boundary

This candidate includes Run file, Stop, stdout/stderr, missing/invalid setup, durable terminal
history, crash recovery, and revision-safe source execution. It does not yet include Run selection
or section, variables, figures, rich MIME output, diagnostics, tests, debugging, `.mlx`/`.mat`
viewers, MATLAB MCP, Jupyter attachment, license/toolbox inspection, agent initiation, artifact
registration, indexed history retention, or a real-MATLAB licensed acceptance result.

The shared execution package is intentionally an execution kernel rather than a speculative
all-domain service. An execution-only typesetting contract test proves that a fake
`DocumentBuild` adapter can consume its state machine, process port, cancellation, and simulator
without importing analysis contracts. When the second real consumer exposes genuinely shared
server orchestration, lift that behavior into an `ExecutionCoordinator`; do not make
`DocumentBuild` depend on `AnalysisService`, and do not force either specialized receipt into a
generic task record.

Actor identity is deliberately not represented as a nullable execution-receipt placeholder. Before
agent- or automation-triggered runs land, the accepted Scient operation envelope must supply the
host-resolved actor, project scope, capabilities, authority generation, and operation lineage; the
result receipt then binds to that envelope rather than trusting an analysis-RPC payload.

## Verification contract

The focused suite covers:

- legal and illegal execution state transitions;
- runtime-neutral process and analysis adapter simulators, plus an analysis-free fake typesetting
  consumer;
- MATLAB explicit/PATH/missing discovery, release parsing, and no-shell command preparation;
- real host cancellation of a parent and its spawned child process on the current macOS test host;
- revision-conflict refusal, atomic replacement, and executable-mode preservation;
- local settings, metadata-only history, on-demand output, and append-only persistence;
- summary/snapshot/output-delta client folding;
- source-language correction, inherited-viewer seam containment, uninitialized-project Run state,
  and autosave revision coordination;
- websocket success, stdout/stderr, metadata-only list plus on-demand detail, stale-source refusal,
  duplicate-run refusal, terminal output hashing, bounded/truncated output, and startup-race
  cancellation.

Before review-ready handoff, the repository-wide format, lint, typecheck, test, build, desktop
smoke, brand, diff, and current-main/upstream conflict gates must also pass or be reported exactly.
