# T3 upstream alignment — 2026-10-14

## Boundaries and status

Source integration and independent composition review are complete. Qualification
is in progress. Yaacov explicitly requested that tests covered by hosted CI run
there instead of being duplicated locally for this pass. Local uncovered native,
macOS and visual checks remain separate obligations. This instruction does not
change the repository's general qualification policy.

The current integration pointer remains at the preceding qualified target until
this candidate's applicable gate passes. A draft PR, green focused check or source
review is not delivery. No merge, queue admission, release or publication has
been authorized for this new candidate.

- Owned base: `f1f2c0a214314c0a4ae2506a9a43ce28b749cfaa`, the actual public-main
  merge of Scient PR #534.
- Previous official boundary: `b03534fa7b847e8403322e416189c6293e6846e0`.
- Frozen official target: `85272eeeae53c5baa1cba1a36d84bbec81a3a0b5`.
- Literal integration merge: `62d67b9db546917f452b5e1b67bfa9587260aa35`, tree
  `365bdfc372964f1917e19fcab2816b5f335ca312`. Exact parents are the owned base
  and frozen official target; all 49 ordinary donor commits are ancestors.
- Inventory: 185 incoming paths, 112 same-path overlaps, 44 initially unmerged
  paths. The 68 clean overlaps and untouched Scient consumers were included in
  source review, rather than treating textual conflict removal as acceptance.
- Branch: `codex/t3-sync-85272eeeae-20261014`; upstream push URL: `DISABLED`.
- No later owned-main catch-up is present. Public main was reverified at the
  owned base immediately before committing the integration. Future owned-main
  movement must preserve this upstream merge.

## Integrated behavior and composition

The complete donor range retains native Claude subagent outcome confirmation,
Pi atomic start-or-queue and completion-gateway schema activation, delegated
worktree preparation, pending model-handoff previews, question context/link
interaction, HTML link routing, settings-drop diagnostics, immutable mobile
image cache identities, connected-repository PR fallback, replay of unknown
newer-build events, failed-item lookup indexes and planner statistics. Git path
whitespace, Bitbucket review-head resolution, branch PR caching, device startup
errors, editor selection, onboarding labels, route currentness, work-log titles,
desktop diagnostics/autofill and small control-layout fixes remain included.

Meaningful compositions and clean-merge corrections:

- Native Stop separates a confirmed provider outcome from physical session
  release. Both carry captured task/session identities. Worker and serialized
  command handling retain exact run, attempt, provider, native owner and resumed
  activation checks. Void, failed live control and absent proof cannot authorize
  projection repair. The confirmed path does not settle the parent, siblings,
  application-created children or held queue.
- Claude retains coordinator observation, reserved native start/query ownership,
  genuine EOF handling and once-only terminal publication. The adapter checks
  start identity, query and turn owner after the native Stop wait. Native receipt
  waiting remains real; no timeout was shortened to claim speed.
- Delegated worktree preparation retains recorded retry identity and failure
  cleanup. After successful release, cancellation retains the checkout and
  checkpoint baseline. Failed removal retains the durable binding. Existing
  Scient invocation authority remains independent of workspace preparation.
- Pi keeps guarded native prompt dispatch, complete Scient guidance and scoped
  MCP transport. One prompt hook composes guidance per credential branch.
  Schema preloading uses the same model tool-name projection as registration;
  canonical Scient tools do not acquire callable T3 aliases. All eight replay
  recordings preserve their original immutable digests; an exact, reviewed
  queued-start expectation overlay is reversed before original-byte verification.
  Synthetic selection supplements are not advertised as new native recordings.
- Optional command lookup now returns `null`. Four untouched Scient runtime and
  OMP process consumers map it to their existing configured-command fallback
  before executable identity, probing or lease admission. Filtered environment,
  bypass-cache and process ownership decisions remain intact.
- Incoming unshipped migration 62 is registered as owned 66 because Scient's
  shipped 62 already exists. All shipped IDs/names/bodies through 65 remain
  unchanged, including retired 50 compatibility. The donor DDL is unchanged.
  Full-ledger validation still refuses gaps, foreign shipped names and newer
  ledgers before migration, including for partial requests. The retired 055 test
  stays retired; its new assertions are composed into owned 059 coverage.
- SQLite retains Scient's existing FULL commit durability. The donor NORMAL
  tradeoff is held by that product decision, rather than silently weakening it.
  Planner optimization is adopted. The independent Scient ledger and retired
  filesystem cleanup preserve their own identities and ordering.
- Attachment content hashing is applied in the actual extracted persistence
  owner, not only the upstream helper. Equal-byte retry is stable; replaced
  bytes obtain a new identity. Exclusive synchronized publication and refusal
  to overwrite corrupt existing identity remain intact.
- Pending-question failure feedback, rich per-question context, Scient trace
  icon precedence, provider skills and keyboard/pointer project selection remain
  preserved. Existing reader, save, queue and fork/PDF owners remain separate.
  Retired T3 npm-release polling stays retired. Scient review enforcement,
  branding, provider order, storage identity, privacy and activation holds remain
  owned rather than replaced by incoming defaults.

The incoming Codex background-text MCP-list failure fallback retains user MCP
servers when discovery fails. Successful discovery disables named servers and
plugins/apps. This improves the previous always-enabled behavior, but it is not
strict isolation on every failure path; this receipt makes no such claim.

## Separation and simplicity

`persistence/scientMigrationLedger.ts` now owns the existing strict ledger policy.
`Migrations.ts` mounts it after preview reconciliation and before any migration
execution, with paired Scient markers and the complete manifest. No execution
service, generic extension bag or second persistence authority was introduced.

The host shrank from 334 to 265 lines. Excluding the two donor migration
import/manifest lines, host plus new helper is 333 lines versus 334 before the
extraction. This is a bounded reduction in owned host coupling, not a measured
prediction of future conflicts or end-to-end speedup. The divergence map names
the owner and exact ordering boundary. Larger lifecycle extractions were deferred
because moving suspending ownership checks would add risk to this range.

## Review and qualification evidence

Three completed independent source reviews covered provider/platform consumers,
server authority/lifecycle composition, and persistence/client composition.
Their cross-review reports found no remaining actionable source blocker in the
reviewed tree. Reports, input hashes and command receipts are retained under
`reviews/upstream-sync-85272eeeae-20261014` in the umbrella workspace. Source
acceptance is separate from test, platform or visual qualification.

Local evidence uses repository Node/pnpm, a fresh synthetic home and public
runtime caches, one coordinated heavy slot, exact inputs, timestamps and logs:

| Check                              | Observed result                   | Scope                                                                                                 |
| ---------------------------------- | --------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Affected server typecheck          | Passed, 4.486s                    | After three narrow service/identity fixture compositions                                              |
| Real Pi native suite               | 5 passed, 15.360s                 | Actual Pi 0.85.1 RPC, instructions/model input, scoped MCP, repeated turns, resume and question Stop  |
| macOS desktop build                | Passed, 38.689s                   | Exact composed production inputs                                                                      |
| macOS desktop smoke                | Passed, 13.927s                   | Actual Electron/native desktop pipeline                                                               |
| New Claude Stop owner witness      | 1 passed, 5.953s                  | Public adapter plus controlled SDK/native receipt; other 257 cases excluded                           |
| Exact weakened Stop counterfactual | Expected deciding failure, 7.010s | Only post-wait query/owner equality omitted by a test transform; product bytes/index/bundle unchanged |
| Five seam registries               | Passed                            | Staged diff classification/locators, not behavior or ancestry proof                                   |

The first affected compile exposed three incomplete fixture/service compositions;
they were corrected before its passing run. The first counterfactual configuration
failed to load as ESM; that setup failure is preserved and is not regression
proof. The successful counterfactual fails because a stale Stop returns a
completed outcome after task turn ownership changed, where the witness requires
`undefined`. It isolates owner-context replacement, not query-only replacement
or authenticated Claude service quality.

The maintained six-boundary early selector was exercised as an impact plan. Its
unknown-path fallback conservatively selected all boundaries. Covered default
suites will execute in hosted CI, while the local opt-in Pi group ran here.
The selector is feedback/coverage mapping, not an exhaustive dependency graph or
a substitute for the final applicable matrix.

Pending at this receipt revision: final pushed-head hosted static/type/build,
workspace/server/web/browser tests and applicable mobile/native/packaging/release
smoke checks; exact-candidate isolated app and proportional visual interaction;
final receipt/cursor advancement. No full local aggregate was run by design under
the explicit per-pass instruction. Device inventory currently reports required
AgentDevice 0.21.24 unavailable; native mobile interaction is not established.

No universal enabled-provider, Windows, mobile-publication, physical power-loss,
OAuth or microphone acceptance is inferred from the above evidence. Public main
delivery and release/publication remain separate from this candidate.
