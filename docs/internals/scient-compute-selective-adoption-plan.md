# Compute Selective Adoption Plan

Status: Local implementation candidate; focused automated qualification complete; owner visual review pending

Owner: Yaacov

Created: 2026-09-14

Purpose: Records which Compute simplification concepts are being adopted, the architecture required to make them reliable, and the evidence needed before this work can replace the current PR #287 candidate.
Authority: This is an implementation ledger subordinate to `scient-compute-session-foundation.md` and `scient-compute-toolkit-foundation.md`. Those ADRs remain authoritative when this plan is incomplete or ambiguous.

## Outcome

Preserve the independent Compute-tab and managed-runtime foundations already qualified on
PR #287, while adopting the useful file-first and compact-settings direction explored on
PR #288. Visual simplification is accepted only when lifecycle ownership remains explicit,
errors remain actionable, user-owned runtimes stay untouched, and ordinary file behavior is
not weakened.

This is not a request to merge PR #288 wholesale. Its branch is source material. The
implementation is rebuilt and reviewed on the exact green PR #287 head so each retained
concept can be justified independently.

## First principles

1. Opening, viewing, or switching files never installs software or starts code.
2. A user action starts an operation exactly once; render and mount are observation only.
3. Server state is authoritative. Immediate command receipts may improve feedback but must
   yield when the server observation advances.
4. Scient may install, repair, update, or remove only Scient-owned generations. A broken
   system, project, or configured runtime offers selection or verification—not repair.
5. Settings inventory is lightweight metadata. Run and Test retain the real native/session
   verification boundaries.
6. Healthy screens stay quiet. Failure summaries are short; complete diagnostic text remains
   available behind Details and Copy.
7. One shared semantic action must not be reimplemented from button wording. File and Settings
   controls derive setup intent from the same typed managed-runtime status.
8. Existing file editing, comments, annotations, save conflict handling, source provenance,
   session ownership, and retained history are preserved.
9. A new abstraction must remove a demonstrated ambiguity or duplicate policy. Moving code
   merely to make it look general is not an improvement.
10. The plan is evidence-driven. If implementation or qualification disproves a decision, amend
    this document and the owning ADR rather than forcing the code to match stale prose.

## Selective adoption decisions

| Area                                  | Decision              | Required correction or boundary                                                                                                                                                                                                                  |
| ------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| MATLAB helper packaging               | Adopt                 | Package the nested locked helper specification and derive build/publish paths from one purpose descriptor shared with runtime resolution.                                                                                                        |
| Managed-environment removal race      | Adopt                 | Treat the atomic rename-to-tombstone window as temporary absence during inspection; prove it with a deterministic barrier, not timing loops.                                                                                                     |
| Purpose-aware managed roots           | Adopt                 | Keep Python and MATLAB-helper roots, receipts, messages, and specifications independent while sharing only the transactional Python-environment mechanism.                                                                                       |
| Real Test semantics                   | Adopt                 | Passive inventory reports detected; Test creates, verifies, and closes a temporary session without project history.                                                                                                                              |
| File-first setup and connection       | Adopt with correction | Keep the contextual entry in the file toolbar, but open the correct server's compact Scientific Computing settings for the mutation. Derive Install/Connect/Repair/Use helper from typed status and ownership; never infer it from visible copy. |
| Compact Scientific Computing settings | Adopt                 | One current-runtime row per language and a collapsed Change runtime recovery area. No inventory dashboard or explanatory card stack.                                                                                                             |
| Runtime picker labels                 | Adopt with correction | Hide paths by default; append a short, clipped path suffix only when version and provenance labels collide. Explicit path entry remains available; the file status never expands into a raw-path card.                                           |
| Managed failure presentation          | Adopt with correction | Add a structured failure contract (`reason`, retry action, summary, detail). Keep the legacy message for compatibility; remove frontend prose parsing.                                                                                           |
| Refresh after managed operations      | Adopt with correction | Keep the immediate operation receipt, then one operation-completion rediscovery. Remove duplicate install-detection refresh effects and immediate competing refreshes.                                                                           |
| Test passed state                     | Adopt with correction | Bind the result to the exact runtime fingerprint and observed server snapshot. Clear it when executable, version, problem, generation, selection, refresh, or server observation changes; returning to old values must not revive stale proof.   |
| Runtime repair                        | Narrow                | Repair only a broken selected Scient-managed generation. A broken user-owned runtime opens Change runtime and remains user-owned.                                                                                                                |
| MATLAB one-shot entry                 | Adopt with correction | Keep it secondary and explicit under Run. Its visibility is owned by the active file surface; no module-global path map or cross-tab listeners.                                                                                                  |
| Hover-only cell action                | Adopt with correction | Scope hover-only gutter chrome to Compute. Preserve file annotations and an explicit comment action instead of disabling comments for all Compute files.                                                                                         |
| Additional session entry              | Adopt with correction | Keep it secondary but directly reachable as New compute session, not hidden in an Advanced submenu. It reuses the existing context/session system.                                                                                               |
| Variables as a sibling view           | Already in PR #287    | Do not duplicate or restack the already-qualified implementation.                                                                                                                                                                                |
| CI/provenance stabilization           | Already in PR #287    | Do not transplant duplicate workflow-only fixes from PR #288.                                                                                                                                                                                    |

## Architecture

### Managed runtime status

`ComputeManagedRuntimeStatus` remains the one transport object for installation ownership,
selection, update, operation, and failure state. Current servers additionally return a bounded
structured failure:

```text
reason + action + short summary + full bounded detail
```

`failureMessage` remains during compatibility transition. Current clients prefer the structured
failure and fall back to the legacy field for older servers. A command result is an optimistic
snapshot only. The client displays it while the watched query is unchanged; once that query
advances, the query wins even when it differs from the command receipt. Superseded receipts
are retired permanently, including when cancellation/removal returns the server to its earlier
state. Authoritative absence is not replaced with stale inventory.

Managed-operation failures are not execution readiness. A healthy system runtime or live
session remains runnable while an unrelated managed operation is pending or failed. Recovery
options and error details stay reachable in that state.

### Shared setup intent

One pure resolver maps managed status to the primary action:

- absent generation → install;
- failed managed generation/operation → repair;
- healthy installed generation not yet selected or language not yet enabled → use managed.

Language-specific labels remain at the presentation edge: Set up Python versus Connect MATLAB.
Maintenance actions remain explicit. Selecting a user-owned runtime saves the exact preference
before releasing managed precedence, so a failed save cannot silently switch defaults.

### Packaging and purpose isolation

The purpose descriptor lists the root specification and MATLAB connection specification. It is
used by source-tree lookup, staged lookup, build copying, and publish validation. This prevents a
release from passing with only one lockfile while avoiding a generic package-manager registry.
Each purpose retains its own lock, generation root, activation receipt, repair/removal lifecycle,
and product wording.

### File and auxiliary surface ownership

The ordinary `.py`/`.m` editor remains the owner of Code/Split/Results and its independent
Compute context. The optional MATLAB fresh-process panel is local view state initiated by that
file's Run menu. It is not durable compute state, a global registry, or a reason to change
ordinary file opening.

The inherited editor keeps comments and annotations enabled. Compute supplies a scoped gutter
presentation policy and a run-cell action. Where that action occupies the shared gutter slot, the
slot also exposes the ordinary comment action rather than deleting the capability.

## Implementation sequence

1. **Backend correctness**
   - Package both locked specifications from one descriptor.
   - Make managed filesystem inspection purpose-aware and tombstone-safe.
   - Return structured managed failures while preserving legacy decoding.
   - Keep explicit verification real and temporary for both languages.
2. **Managed client lifecycle**
   - Reconcile optimistic command snapshots with advancing server truth.
   - Derive primary actions from typed status.
   - Use one post-operation rediscovery path.
   - Bind transient Test results to the selected runtime fingerprint.
3. **Settings and file UI**
   - Use file-first setup and compact language rows.
   - Preserve lightweight Refresh and direct Scientific Computing navigation.
   - Disambiguate duplicate runtime labels only when necessary.
   - Keep short failure summaries with Details and Copy.
4. **Secondary surfaces and editor capabilities**
   - Scope MATLAB one-shot state to the active file surface.
   - Keep Compute gutter actions hover-only without removing comments.
   - Expose New compute session directly from the add-surface menu.
5. **Documentation and qualification**
   - Update the owning ADR and user guides to match the implemented behavior.
   - Run deterministic filesystem/controller/adapter/service tests.
   - Run settings, file-surface, context, results, and seam tests.
   - Build server, web, and desktop/release staging paths.
   - Launch a separately named, separately persisted dev app beside the unchanged PR #287
     reference candidate for owner comparison.

## Qualification matrix

Automated acceptance must cover:

- source and staged resolution of both specification pairs;
- missing nested lockfiles failing build/publish validation;
- install, cancellation, failed provision, failed verification, rollback, repair, update, removal,
  and inspection during tombstone deletion;
- structured failure compatibility with older status payloads;
- exactly one effective rediscovery after an operation settles;
- command receipt yielding to later success and later failure observations;
- no repair action for configured, project, path, or conventional installations;
- failed settings save preserving managed selection;
- duplicate runtime labels remaining distinguishable;
- Test passed clearing on Refresh, runtime/helper generation or selection changes, and managed
  operations; stale completion or returning to an earlier runtime must not restore an old pass;
- one-shot state not crossing file tabs, projects, or environments;
- ordinary file comments/annotations and save conflict behavior on Compute files;
- direct secondary-session discovery without changing its ownership or close semantics; and
- existing independent Python/MATLAB session, stop, restart, interrupt, close, history, variables,
  figure, and source-provenance suites remaining green.

Manual comparison should focus on the delta, not requalify every foundation feature:

1. Open the same unrun Python and MATLAB files in the reference and selective candidates.
2. Compare file-first setup, toolbar wrapping, Code/Split/Results, empty Results Run, and failures.
3. Compare Settings initial paint, current-runtime rows, Change runtime, duplicate choices, Test,
   Refresh, Repair/Remove ownership, and MATLAB helper retargeting.
4. Confirm Run as one-shot appears only after explicit selection and does not appear in another
   file or app candidate.
5. Confirm cell Run and Add comment are both reachable on hover.
6. Confirm New compute session is directly reachable and independent file tabs still run in
   parallel.

## Non-goals and remaining release gates

This pass does not add arbitrary package installation, agent package authority, notebooks,
interactive widgets, a MATLAB replacement/fallback, or a new scheduler. It does not retire the
older fresh-process AnalysisRun domain. It does not claim Windows/Linux packaging, packaged-app
native MATLAB, owner visual acceptance, security approval, or release readiness merely because
local tests pass.

One existing conservative boundary remains: managed-runtime removal waits for all live sessions
and explicit verification of the same language, including sessions using user-owned installations.
Narrowing this safely requires proving each session's managed-generation/helper ownership; it
must not be weakened merely by checking the executable's display name or source label. This is
a follow-up lifecycle improvement, not a prerequisite for comparing the current UI candidate.

Before a PR is ready to replace PR #287, record exact-head automated results, before/after visual
evidence, owner acceptance, and the remaining platform/release gates in the parent PR. Keep the
reference candidate available until the comparison is complete.
