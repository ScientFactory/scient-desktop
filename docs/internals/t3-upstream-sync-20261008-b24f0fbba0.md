# T3 alignment through b24f0fbba0

This receipt records the bounded official alignment and its qualification. It
does not authorize a release, publication, mobile activation or merge to main.
The maintained procedure remains [the alignment protocol](./upstream-alignment-protocol.md).

## Exact history

- Owned base: `3498143f7221634d9dd6b38e95f84839dc4d2bfe`.
- Previous official boundary: `468ade30495c450ae4e731483187f77bc3c5e42b`.
- Frozen official target: `b24f0fbba09d8623c896081b4ff70aa7190c8fda`.
- Range: all 27 first-parent official commits after the previous boundary; 156
  rename-aware changed paths, 61 overlapping paths and 18 textual conflicts.
- Branch: `codex/t3-sync-b24f0fbba0-20261008`.
- Literal upstream merge: `71015aa7484971d7c84101b2294c88988bee2203`, with the
  owned base and frozen official target as its exact first and second parents.
- No exact target tag and no owned-main catch-up merge. A fresh origin/main
  fetch before delivery still identifies the owned base above.
- Qualified runtime source: `e6ae62d09efd8b834dc44572f5330fa80e93e9ea`; tree
  `09011e332f4b483524a6238f41265978212a22bd`. Later maintainer receipt and cursor
  edits do not change this runtime source.
- Official upstream remains fetch-only, with push URL `DISABLED`.

The source diff from the owned base is 173 paths, +12,398/-4,810 lines before
the final receipt/cursor edits. Incoming commits remain literal ancestry;
composition and independently reviewed corrections are ordinary narrow follow-ups.

## Integrated behavior and Scient composition

The entire range integrates server command-replay and long-thread responsiveness,
Codex idle-thread unloading, desktop Browser child-frame/worker continuation,
rich Markdown composition and type-to-focus repairs, latest available reasoning
summaries in activity rows, multi-file diff search, current-title thread references,
provider maintenance progress, PR/workspace/file-icon presentation, plain-HTTP MCP
URL copying, mobile cached-shell and Android picker repairs, and GitHub API/quota
consolidation. Reasoning summaries display provider-supplied text; they do not
expose otherwise hidden model reasoning.

Meaningful compositions and semantic repairs:

- Snapshot-window indexes append as Scient migration 064. Existing migrations 1–63
  and retired ID 50 retain their identities, SQL and order. The 56-to-current and
  63-to-64 upgrade proofs use independent SQLite layers; the development slice
  proof names Scient's V2 migration 059 rather than upstream 055.
- Per-thread Codex idle unload retains Scient logical/physical process ownership,
  captured policy, background-work, attachment and event consumers. Resume and
  direct start cancel pending unloads before acquiring the attachment lock;
  an unload already running holds that same lock through physical unsubscribe.
  Controlled gates and measured scheduler interleavings prove that neither
  native follow-up overlaps unsubscribe. Restoring only the original merge's
  ordering makes both deciding cases fail; the fixed source was restored exactly.
- The rich composer preserves Scient controlled drafts, citation/skill payloads,
  queue/send controls, caret and focus. Accepted citations remain removable after
  their insertion popover closes; fresh cancellation removes only its recorded
  insertion spaces. Headings, lists, fences, language selection and indentation
  serialize as Markdown. Composer fences reuse the existing Scient presentation
  frame and quiet theme tokens, including named themes.
- The Pierre 1.5.2 patch retains Scient reciprocal external-history mappings,
  first-beforeinput caret ownership and StrictMode cleanup while adopting native
  multi-item search, folded/unchanged-line reveal and shadow-root highlighting.
  Search covers loaded files; large lazy diffs do not promise unloaded-file search.
- New thread links carry an ID and resolve current titles in the message's own
  environment. A narrow shared reader preserves stored environment-qualified
  links and copied identities. Literal IDs resolve before percent-decoded
  fallback; mobile native Markdown and its actual press handler follow the same
  owner and collision rules, with no second decode of historical identities.
  MCP list/read no longer returns a baked link. Scient tool names, project scope,
  sender provenance, snooze visibility and captured authority remain owned.
- Shared shell/cache decoding retains unknown/malformed-command rejection,
  historical project-icon compatibility, one-refresh HTTP authentication and
  DPoP handling. Cached mobile shell and parallel favicon hydration compose with
  the existing client owners; deferred PR/badge decoding stays explicit.
- The intermediate GitHubCli service retires after every Scient CLI/server/asset
  consumer moves to GitHubApi. Credential, HTTP, source-control and configuration
  owners remain intact. Native variable-based GraphQL paging and response-header
  quota tracking reserve interactive capacity.
- Provider update output is sampled approximately once per second and reports
  checking/installing/verifying outcomes. Scient managed/system paths, Pi/vendor
  advisory behavior and explicit update actions remain intact. This alignment
  does not install or activate another provider runtime.
- Plain-HTTP/LAN MCP URL copying adopts native availability without broadening
  the existing HTTP(S)-only URL boundary or authentication authority.
- Desktop Browser continuation resumes announced child frames/workers without
  removing the existing epoch/session ownership boundary. PR panels, icons and
  workspace rows adopt native mechanics while Scient reader/streaming and
  scientific presentation remain composed.
- CodeRabbit's existing Approvability guard remains. Upstream's removal is an
  unapproved Scient review-policy proposal. Settings, onboarding and Settings
  search continue withholding the unapproved privacy-policy link.

No second execution authority, blanket dead-code/test ignore, new test skip,
credential copy or live-data migration is introduced. Identity/storage/format
compatibility, license notices and existing release/cloud/telemetry/service/
signing/mobile-publication holds remain unchanged.

## Independent review and automated qualification

Two separate reviewers covered server/orchestration/MCP/session/workspace/
migration/authority and clients/shared contracts/composer/diff patch/scientific
presentation/packaging, including all conflicts, clean overlaps and untouched
consumers. Idle-unload ordering, stored mobile links, encoded-ID navigation and
citation removal findings were repaired and independently rechecked. The quiet
code-card correction and parameterized test declarations were also independently
accepted. Neither reviewer reports an outstanding source blocker at the qualified
runtime revision. Source acceptance is distinct from root-run qualification.

Local qualification uses macOS 26.7 arm64, Node 24.19.0, pnpm 11.10.0 and the committed
lockfile. Heavy checks are serialized. Full workspace graphs are partitioned
into server, web and the other 29 graphs rather than competing heavy runs.

| Graph or applicable scope           | Result                                                                 |
| ----------------------------------- | ---------------------------------------------------------------------- |
| Server, complete final suite        | 956 files / 12,200 cases passed; existing 56 files / 188 cases skipped |
| Web                                 | 926 files / 11,336 cases passed                                        |
| Actual Chromium layout              | 30 files / 263 cases passed; one worker, no file parallelism           |
| Desktop                             | 135 files / 1,634 cases passed; existing 4 files / 43 cases skipped    |
| Mobile                              | 241 files / 2,212 cases passed                                         |
| Relay                               | 34 files / 417 cases passed                                            |
| Scripts                             | 46 files / 651 cases passed; existing 1 file/case skipped              |
| Provider runtime                    | 23 files / 180 cases passed; existing 1 file / 2 cases skipped         |
| Contracts / shared / client-runtime | 926 / 1,292 / 2,449 cases passed                                       |
| Remaining workspace graphs          | Passed; itemized in external qualification evidence                    |
| Native mobile lint discovery        | 15 Swift / 27 Kotlin files discovered; analyzers unavailable locally   |

Formatting, lint, all 32 uncached typechecks, both Knip phases, branding and all
five strict seam manifests pass. The full build passes all six tasks with zero
task-cache hits; preload verification passes. Native desktop smoke passes
uninstrumented on a fresh private profile with the existing 8-second survival and
shutdown observation bounds. Final maintainer-only documentation is checked
separately for formatting, local links, whitespace, provenance and seam integrity.

The complete server command exits successfully after 1,880.81 seconds.
The final server manager scope passes 22 cases. Original-order mutation is an
expected failure demonstrating both deciding assertions, not a candidate failure.
Initial migration-fixture ordering, stale ledger expectation, composer selector,
new test fixture/declaration and incorrect check-invocation failures are retained
as failed attempts. Corrected focused/full reruns provide acceptance; no deciding
assertion, existing skip or runtime guard was weakened to obtain a pass.

## Actual app and evidence limits

The isolated candidate is `Scient (Dev) · scient-t3-sync-b24f0fbba0`, bundle
`com.scientfactory.scient.next.dev.scientt3syncb24f0fbba020261008`, with private
`.scient-next`, backend 16421 and web 8381. Its trace, endpoint, listener and
process-persistence checks pass. Unrelated candidates and profiles remain intact.

Root exercised actual rich-composer headings/lists/fences, language switching,
indentation and undo/redo. Actual composer and separately mounted production
reply frames have identical computed border/background styles in default and
ocean light/dark palettes; these controlled palette fixtures do not claim theme-
picker interaction. Native Changes diff search navigated 292 matches, including
initially folded files, with painted shadow-root highlights. Its existing
environment-cwd fallback compared this candidate to origin/main; it did not diff
external synthetic files. Two real Codex GPT-6-Luna/High/Supervised turns rendered
math/code and new/stored thread links. Native rename relabeled both link formats;
clicks preserved their owner and an unsent draft. The draft survived navigation
and reload. Mounted onboarding and Settings retain privacy-link withholding.

Eight inspected screenshots, exact commands/revisions/logs, computed styles,
independent reports and failed attempts are retained in the parent workspace's
`reviews/upstream-alignment-20261008-b24f0fbba0`. They are external qualification
evidence, not repository-owned PR assets. The actual app remains available for
owner review; automated/source/root visual acceptance is not substituted for
the user's acceptance of this new candidate.

Local evidence does not establish physical Android/iOS gestures, all live
providers, external sign-in/CAPTCHA, remote SSH combinations, Linux delegated-
cgroup reader release or signed/packaged distribution. SwiftLint, ktlint and
detekt are not installed locally; their discovery command is not a completed
native-analysis gate. Hosted CI must qualify the exact pushed revision in its
own applicable environments. No merge, auto-merge or release follows from opening
the requested draft PR.

## Retained enforcement debt and follow-up

GitHub checkout remote matching currently compares owner/name without requiring
the API host. The independently reviewed omission already exists in the owned
base; it is not introduced by API consolidation. A separate bounded repair
should match normalized API host plus owner/name, retain approved SSH aliases and
primary-remote fallback, and prove same-name repositories on different hosts.
This receipt does not claim that pre-existing cross-host ambiguity was repaired.

Existing presentation-lint exceptions, portable HTML omission, disabled-provider
passive probes and platform/provider qualification limits remain as recorded in
the [previous receipt](./t3-upstream-sync-20261008-468ade3049.md). Their configured
scope is not evidence of runtime violations or automatic enforcement. No new
blanket ignore or publication authority is added by this range.
