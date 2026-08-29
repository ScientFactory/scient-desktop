# T3 upstream sync through c8aba2587d

Status: locally verified integration candidate. This record does not authorize
a release, enable cloud or mobile publication, or modify `release/stable`.

## Exact boundaries

- Owned base: `aa23f1d3b96f6904dcc1a114cc33415fa267315a`
- Previous literal T3 boundary:
  `082e6ea521861fff37b90fcd789b5eaa5ef5d6a6`
- Integrated T3 target:
  `c8aba2587d56edbf3b7872987719a12b42031f48`
- Official tag at the target: none (nearest description:
  `v0.0.36-nightly.20260828.1208-5-gc8aba2587d`)
- Exact donor range: `082e6ea521..c8aba2587d`, 25 commits
- History-preserving merge:
  `c01a0f324c28784b288ee2a795eb3b929641478b`
- Integration branch: `codex/t3-sync-c8aba258-20260828`
- Donor write boundary: the `upstream` push URL remains `DISABLED`

The merge commit has the exact owned base and official target as its parents.
No donor commit was replayed, squashed, or cherry-picked. `integrationBase`
advances to the merged target; `reviewedThrough` remains the separate
product-review cursor.

## Adopted behavior

- Provider model freshness is classified through a bundled, cached manifest.
  Scient fetches only its reviewed copy on `ScientFactory/scient-desktop` and
  honors the existing provider-update-check opt-out; a failed fetch never
  blocks provider readiness.
- Grok gains discovered skills, plan-mode completion handling, reasoning
  controls, usage parsing, and stronger turn-liveness behavior. Usage scans
  only Grok's `updates.jsonl` files and sends the existing aggregated usage
  contract, never raw transcripts.
- Codex gains multi-agent event handling, current account-plan metadata, and
  recovery from stale approval requests.
- Provider Settings adopts T3's simpler provider list/editor structure while
  retaining Scient's assisted install, connection, repair, removal, runtime
  diagnostics, account redaction, and enabled-state controls.
- Threads that re-enter the active list return to the top without ordinary
  message activity causing list jitter. Projection bootstrap now replays the
  complete event range instead of stopping after 1,000 events.
- Publishing a newly created branch no longer risks pushing feature commits to
  a differently named base branch; the branch keeps a recorded merge base and
  publishes under its own name.
- Same-repository preview builds can expose an anonymous rolling DMG download.
  PR code still builds with a read-only token; a separate job publishes the
  artifact, rechecks PR eligibility, and removes it when the label or PR goes
  away.
- Mobile receives the current Android icon treatment, compact header behavior,
  git-operation feedback, and the same thread/usage behavior as the web client.
- Ordinary failed tool calls no longer look like a failed turn. Runtime and
  orchestration failures retain the severe error treatment.
- Stable Clerk fixes, generated API schema updates, dependency maintenance,
  release-build performance improvements, and upstream duplicate-test cleanup
  remain ordinary inherited maintenance.

T3's `v0.0.34` and `v0.0.35` history and package versions are present as
literal ancestry. They do not create a Scient release or change Scient's
manual exact-commit release authority.

## Conflict composition

The donor range touched 127 paths; the resulting merge changes 125 paths
relative to the owned base after conflict composition. It produced 19 textual
conflicts. Each was resolved against both parents rather than by choosing a
complete side.

- The release workflow remains entirely Scient-owned. T3's automatic
  tag/cloud/npm publication graph was not activated.
- The ACP mock agent composes Scient elicitation behavior with T3's xAI plan
  and exit-mode events, and now models Grok's short-lived `inspect --json`
  command separately from its long-running ACP server.
- Migration ordering remains immutable: Scient keeps migrations 41 through 44
  and registers T3's unsettled-thread projection as migration 45.
- Projection queries and mappings retain Scient's fork, project, and provider
  fields while carrying `unsettledAt` through every shell, detail, command, and
  snapshot path.
- Claude retains Scient's managed runtime, assisted authentication, connection,
  and voice composition while adopting the model manifest.
- Grok retains Scient's awareness rules, cancellation hooks, explicit safe
  probe gate, assisted authentication, and managed runtime behavior while
  adopting current runtime modes, reasoning, plan completion, skills, and
  liveness semantics. Passive status checks still cannot open a browser.
- Provider registry tests retain Scient's six managed providers and add only a
  test-scoped PTY dependency required by the current inherited driver graph.
- Provider Settings keeps Scient lifecycle actions and runtime maintenance on
  top of the new inherited master/detail structure. The existing assisted
  dialog remains the single behavior owner.
- Sidebar width remains Scient's compact exported value and contract test.
- Provider and install documentation keeps Scient's assisted lifecycle,
  awareness, Droid, and Antigravity guidance while adding the inherited model
  manifest and Grok reasoning behavior.

The complete gate caught two additional stale integration seams:

- Grok skill discovery invoked Scient's ACP test executable as
  `inspect --json`; the test double previously started another ACP server and
  never exited. It now implements the real short-lived CLI contract.
- Scient's Grok text-generation wrapper still asserted the retired
  `agent --no-leader stdio` invocation. It now verifies the current
  `agent stdio` contract used by the aligned runtime.

The focused projection gate also caught missing `unsettledAt` selections in
Scient-added query branches. Those branches now follow the same schema and
mapping contract as inherited snapshot queries.

## Protected-boundary audit

- Scient identity, `scient-next` storage compatibility, protocols, preview
  partitions, client persistence, and migration policy remain intact.
- Managed and system-installed provider paths remain available. Assisted
  install, sign-in, repair, removal, update, diagnostics, and provider-specific
  policy remain under Scient's lifecycle infrastructure.
- Passive provider status checks remain side-effect safe. In particular,
  checking Grok cannot launch its browser login flow.
- Analysis, LaTeX, local voice, onboarding, browser-PDF export, scientific
  sources, durable forks, project skills, and provider lifecycle mounts remain
  present and pass their seam guards.
- Raw provider transcripts stay server-local; usage clients receive only the
  existing aggregate contract and source diagnostics.
- Telemetry, OTLP, cloud, relay, service activation, updater authority,
  signing credentials, release promotion, and stable publication gates remain
  unchanged. PR preview publication is separately label-scoped and removable.

## Verification

Local non-visual verification used Node `v24.19.0` and pnpm `11.10.0`:

- Focused projection, provider Settings, provider registry, Grok runtime,
  Grok skills, and Grok text-generation suites passed after conflict
  composition.
- `pnpm run test` passed all 25 workspace test lanes. The complete server lane
  passed 349 files and 3,810 tests, with 6 files and 31 tests skipped.
- `pnpm run typecheck`, `pnpm exec vp fmt --check`, and
  `pnpm exec vp lint --report-unused-disable-directives` passed. Lint and
  Effect diagnostics reported advisory warnings but no errors.
- `pnpm run build`, `pnpm run test:desktop-smoke`, and
  `pnpm run release:smoke` passed.
- `pnpm run lint:mobile` completed its repository checks; optional local
  SwiftLint, ktlint, and detekt executables were not installed, so those three
  external checks remain hosted-CI/platform gates.
- Scient brand, onboarding, LaTeX, analysis, skills, exact ancestry, conflict
  marker, and `git diff --check` gates passed. The upstream provenance gate
  passed against this record and the updated machine state.

No browser automation, screenshots, visual acceptance, live provider action,
release publication, signing, notarization, or platform packaging was
performed.

## Publication boundary

This merge does not publish artifacts, modify `release/stable`, or enable T3
relay, cloud, hosted web, mobile store, signing, updater, npm, tag, nightly, or
release authority. Those remain explicit Scient gates.
