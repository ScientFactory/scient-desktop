# T3 alignment through 50ff4c37

Status: automated qualification passed; owner manual review pending. This is one full,
history-preserving alignment from the previously integrated official boundary through the exact
official target below. It is not a split, cherry-pick, or replay.

## Frozen history

- Owned base: `fc5134619e183b95d29008db286566c03091aa59`.
- Previous official integration: `01e05c15268dedb76da95f442fbf5201cd8e7a44`.
- Official target: `50ff4c371eab927a9650c114975241999f4cd7b1`.
- Official range: 49 first-parent commits.
- Target tag: `v0.0.41-nightly.20260915.1752`.
- Branch: `codex/t3-sync-50ff4c37-20260915`.
- History-preserving merge: `6f5593ec52e78a066ddf1f0aee9a9bdbdbebda33`; its first parent is the exact
  owned base and its second parent is the exact official target.
- `upstream` remains fetch-only (`https://github.com/pingdotgg/t3code.git`, push `DISABLED`).

## Adopted behavior

- Repository cloning now runs in the background on web and mobile. The chooser can close
  immediately, clone progress remains visible, and a new-task draft is gated until its project is
  ready. Git fetch, checkout, and status work also use bounded concurrency and fewer round trips so
  one repository cannot make the server unresponsive.
- Worktree creation persists the initiating send and setup progress on the thread. Inline setup and
  setup-script rows survive navigation and reopening; asynchronous setup scripts can continue after
  the provider starts while their state remains visible and cancellable.
- Thread state updates render before remote acknowledgements. Custom snooze dates and durations,
  per-thread panel widths, consistent pull-request toggles, project monogram fallbacks, and
  discoverable composer, pull-request, and copy-link shortcuts are included.
- Mobile gains a hardware-keyboard command palette and task shortcuts, safer native-client
  compatibility checks, pointer-only row hover treatment, Dynamic Type-aware inline pills, and the
  redesigned Android agent activity notification card.
- Title generation remains tied to the user's intent, can refine weak initial titles without
  overwriting manual renames, and resolves linked pull-request context through the shared source
  control provider boundary. The same refinement result is preserved for Scient-only Pi, Droid,
  and legacy Antigravity providers.
- Paragraph streaming handles tightly packed list items correctly. Terminal output avoids redundant
  round trips, large image previews no longer stall composer typing, and video thumbnails open in
  the shared viewer while retaining Scient's expand behavior.
- Desktop startup is protected against duplicate initialization. Preview changelogs exclude preview
  releases, semantic CLI versions may include a leading `v`, npm-managed service updates are
  preserved, and the secure fork-preview staging and publication split is adopted without exposing
  signing secrets to untrusted pull-request code.
- OTLP header and protocol parsing are inherited for compatibility. Scient's safety envelope still
  disables every outbound OTLP destination, so these additions do not enable telemetry.
- Dependency and package-layout updates are aligned, including Clerk, mobile native modules,
  Tailwind WASM support, and npm-service packaging. Scient's generated third-party notices now
  account for two MIT dependencies whose nested packages omit license files.

## Deliberately retained Scient architecture

- Upstream's browser-local queued-composer store was reverted after the merge. Scient already owns
  one durable, server-authoritative queue protocol shared by desktop and mobile; retaining both
  would create two competing queue authorities. The official commit remains in ancestry and the
  explicit revert documents this product decision.
- Scient's signed npm-pinned server runtime remains authoritative. The WSL environment therefore
  keeps Scient's Node and `node-pty` readiness path instead of adopting tests for the upstream
  standalone-runtime probe. OTLP environment forwarding and compatible WSL improvements are still
  adopted.
- T3 Connect and hosted-cloud machinery remain inactive under Scient's existing cloud-disabled
  product policy. Compatible contracts and inherited implementation stay upstream-shaped so a
  future product decision does not require a forked protocol.
- Scient's project-first conversations, provider lifecycle, scientific surfaces, state roots,
  analytics consent, updater, signing, notarization, mobile publication, and stable-release
  authority remain unchanged.

## Conflict composition and review findings

The merge presented 45 textual conflicts plus auto-merged overlap. The resolutions use current
upstream mechanics and keep Scient policy at narrow, named seams:

- Project clone contracts, RPC authorization, trackers, and client state use the upstream structure;
  mobile command-palette targets explicitly skip tolerated legacy rows without a project ID.
- Worktree setup uses upstream persistence and timeline mechanics while preserving Scient fork
  provisioning, project ownership, durable queue protocol 2, and restored-draft behavior.
- The model picker combines upstream keyboard navigation with Scient's ability to enter setup for an
  unready provider. Its tests distinguish native disabled state from Base UI's explicit
  `aria-disabled="false"` output.
- Timeline composition retains Scient's prior fix that keeps active thinking status after existing
  commentary. A failed setup row is authoritative over a stale working flag, matching the setup
  lifecycle rather than rendering contradictory placeholders.
- The new workspace shortcut shares `mod+shift+x` with Markdown strikethrough only by focus scope:
  the editor handles and stops the Markdown command; the workspace command applies outside it. The
  collision invariant now records that intentional scope.
- Release CI adopts preview-bundle validation, but the orphaned upstream nightly-test step was
  removed because Scient intentionally does not carry that separate nightly helper. Scient's own
  release smoke and workflows remain authoritative.

Review and qualification found and corrected four semantic defects that textual resolution alone
did not expose: one setup-script test omitted Scient's required queue-protocol marker; one detailed
thread query decoded title state without selecting its new column; migration compatibility
expectations stopped before the appended migration; and the merged CI referenced a deliberately
absent upstream nightly test. It also corrected two inherited public-brand strings and added the
missing nested WASM license notices without suppressing dependency analysis.

## Persistence and compatibility

Upstream's title-state migration is registered as Scient migration `55`, after immutable Scient
IDs `51` through `54`; retired migration `50` is not reused. Existing rows decode a null title state,
and new writes persist the JSON state. Compatibility tests prove upgrades from histories ending at
49, the historical retired-50 state, and 52, as well as fresh installs. Existing migration history
and session data remain unchanged.

## Qualification

- The complete recursive workspace test command passed every package. Web passed 680 files and
  7,713 tests. Server passed 490 files and 6,716 tests, with 15 files and 63 tests skipped by their
  declared platform or environment conditions. Desktop passed 1,412 tests and mobile passed 1,570.
- Formatting, lint, typecheck, production build, dependency/export analysis, desktop smoke, release
  smoke, brand, and generated-license checks passed. Lint reports only existing non-blocking React
  and Effect suggestions.
- Preview-bundle validation passed six Python tests. The scientific-compute bridge passed 85 Python
  tests. Mobile native source discovery passed; SwiftLint, ktlint, and detekt were unavailable on
  this host and were reported as skipped.
- Analysis, onboarding, Skills, and LaTeX seam checks passed. Provenance, exact merge-parent
  ancestry, upstream push protection, migration compatibility, lockfile supply-chain policy, and
  repository diff integrity passed.
- The local icon determinism check reports the same 25 stale generated files on unchanged current
  `main` and on this candidate under Icon Composer 27.0. No icon source changed in this alignment,
  so local renderer drift was recorded rather than generating an unrelated asset rewrite.
- No computer use, visual acceptance, live-provider qualification, Windows execution, or native
  iOS/Android visual review was performed.

## Owner manual review

1. Clone a repository from the command palette. Confirm the palette closes immediately, progress is
   visible, the project appears without blocking the rest of the app, and a draft cannot start until
   cloning succeeds. Exercise cancel, failure, retry, and project removal if practical.
2. Send the first message in a new worktree with a setup script. Navigate away and back while setup
   runs; confirm the setup card and stages persist, Details/terminal access work, and an asynchronous
   script can continue after the provider starts without contradictory working rows.
3. Open the model picker with the keyboard. Move across provider categories, return focus to search,
   and select an unready but supported provider to enter setup. Unsupported providers must remain
   genuinely disabled.
4. In Markdown, verify strikethrough still handles its shortcut. Outside the editor, verify the new
   workspace/composer and pull-request number shortcuts operate only in their intended scope.
5. Check custom snooze, pointer hover on mobile/iPad, Android agent activity presentation, and
   Dynamic Type pill sizing where those platforms are available.
6. Open a video attachment from its thumbnail and expand it. Attach a large image and confirm typing
   remains responsive while processing occurs.
7. Rename a thread manually, then continue it and link or update a pull request. Confirm automatic
   refinement uses the task's intent and source-control context but never overwrites the manual name.
8. Recheck Scient-specific fork creation, provider setup, durable queued sends, scientific pages,
   and release/update presentation around the touched shared surfaces.

Manual acceptance, pull-request creation, merge, cleanup, and release publication are separate owner
decisions and remain outside this receipt.
