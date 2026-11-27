# T3 upstream alignment through d838e95660

Scient PR #1166 integrates the 248 official commits after `ca1680bec69`. It keeps
the two histories in one literal merge and uses the normal main queue.

## Git boundary

- Owned base: `39efbc951404481454862963e51cde55591b1da7`.
- Previous official boundary: `ca1680bec6923c9488d8533570e5320b1ef1dba7`.
- Frozen official target: `d838e95660cb0d9f6784796385d636f4719cfabd`, no tag at the target (nearest reachable: `v0.1.14-nightly.20261127.5345`).
- Range: 248 official commits, 883 incoming paths, 290 same-path overlaps with Scient, 104 initially unmerged paths.
- Literal integration merge: `e5f7bd6168d0e6a570bb1978e3a95faf9aee96ae`, tree `4b109be792712f3460aa48c5459cdae404f17c2b`; parents are the owned base and the frozen official target.
- Branch `codex/t3-sync-ca1680bec69-20261127`. The `upstream` push URL is `DISABLED`.

## User-visible changes

- Files can be downloaded from the Files panel and chat links with the same authorized
  workspace-file access used to open them. Paste and thread switching no longer interrupt
  an attachment download.
- Scient's file reader opens password-protected Word, Writer and EPUB files. The PDF
  reader retains its existing password flow. Passwords go to the active local preview
  worker and the unlocked data stays in that preview.
- EPUBs gain captions and narration when supplied by the book. Notebooks, spreadsheets,
  and code and log files restore each tab's reading position. Markdown follows explicitly
  authored text direction.
- Jira Cloud can be configured as a standalone issue tracker. Jira Service Management
  can post an internal note or a customer reply. The existing issue integration and
  credential controls still apply.
- The existing Simlock Labs integration can list eligible physical phones and tablets.
  The pool still requires a configured gateway and agent token. The UI and agent guidance
  explain what remains on a physical device after a lease.
- Codex rollback retries anchor to a kept turn. Context handoff fixes cover interrupted
  starts, native owner replacement and compaction without a destination history.
- Mobile incorporates attachment and terminal fixes and improves commit review and
  HTML image opening.

## Conflict resolution

- Retained Scient's provider catalog, account policy, workspace and draft identities,
  immutable handoff history, native identity ownership, and compaction limits. Integrated
  retry, staged handoff, provider retirement and lifecycle changes with those owners.
- Composed upstream's ACP deferred search and proxy execution with the existing Scient
  grants, tool schemas and tool presentation. Kept Pi's single canonical tool identity.
- Kept the Scient editor, PDF/workbook viewer, Overleaf route, pending-save protection,
  browser origin and credential controls, and read-only external-file viewer. Integrated
  file downloads, per-thread position keys, Office decryption, and split-panel behavior.
- Adopted Effect 4.1.6 and the proxy process, refreshed the shared lockfile and preserved
  the exact donor reference snapshot. No migration ledger or release workflow changed.
- Managed runtime qualification now watches the two newly imported MCP exposure files.
- Kept the existing browser controller authorization and secret masking while adopting
  upstream's server-side authentication handling. The workspace reader still separates
  its contained read operation from read-only viewing of linked external files.
- Kept Scient's file-save and attachment ownership, durable queue hold, handoff source
  resolution, user-selected model scope, and native prompt fingerprints. The Codex
  rollback replay now supplies the actual kept and newer turns returned by the paged API.
- Matched dynamic and fixed-list MCP discovery to the existing provider grants and
  project scope. Both return Scient's descriptions and schemas. Proxy labels in the work
  log never grant automatic approval on their own.
- Kept the repository's user help and combined all 20 conflicting mobile and web
  locale files. The combined catalog check, command labels and protected test placements pass.
- Updated third-party notice discovery and overrides for the new dependency set,
  and kept the controlled Git-reference snapshot. The Markdown link parser still recognizes GFM containers
  without running the recursive autolink rewrite when collecting code positions.

## Verification

The final runtime candidate is `7297844d44daf204a70528534f9425cee5a7a50b`
(tree `951aa8132d72d50e76a9a3074031bbd40fc6f00d`). Independent Codex
review inspected the server and client composition against both merge parents
and rechecked the committed repairs. It caught the draft diff action, authored
text direction, per-thread preview position, a lost provider's workspace, and
MCP visibility, approval and descriptions. Focused tests also reproduced the
deep Markdown quote parser failure on macOS before the correction. The
existing 62 thread-link tests pass after the correction.

The first two hosted candidates found integration issues in tool registration,
provider identity, native rollback recording, and the web composition. The
final runtime candidate passed all 30 hosted test jobs and the three required
checks. Linux AppImage and Windows installer/native runtime qualification
passed. The Intel macOS R and Julia lane was cancelled during Julia setup after
DNS failures, then passed on retry.
[Hosted CI and qualification](https://github.com/ScientFactory/scient-desktop/actions/runs/46071400614/attempts/2)

The exact-tree seam audit passed all nine boundaries, including test placement.
The web, mobile and desktop catalogs match their source. The lockfile installed
with frozen resolution. Focused tests cover 100 file-preview and encrypted
Office browser cases, 12 native fork and rollback replay cases, 423 Pi cases,
171 ACP package cases, and 125 Antigravity approval, MCP transport and Codex
capacity-ingress cases.

The isolated desktop app opened synthetic locked Word and EPUB files after
rejecting a bad password. Reopening Word required its password again.
A PDF retained its existing password gate. The native Files menu returned a
byte-identical CSV. We also checked the Scient notebook editor, Command-F6,
light and dark appearance, and the narrow password layout. The project
visual record has the screenshots. The reopened exact candidate passed backend
health and the repeated Word and PDF checks. The app was then stopped.

Live Jira, paid providers and physical Simlock leases were outside the synthetic
test. The device list contained no Android emulator for a manual Android PDF
check. Mobile package tests and typechecks ran as part of qualification.

### Local gates

Ran the full gate on the clean runtime candidate with Node 26.13.1 and
pnpm 12.14.0 on macOS arm64. Format, lint, Knip, typecheck, build, packaged
desktop smoke, brand and both diff checks passed.

The local aggregate test gate stayed red. The server suite recorded 20,665
passes, 359 skips and three failures across two watcher files. The linked-theme
timeout and unchanged linked-directory watch assertion reproduced on the
exact owned base. The replacement-tree watch timeout cleared on the isolated
candidate rerun. The watcher suite had another ordering failure on that
rerun. Its implementation and tests are unchanged by this range.

The SSH timeout also reproduced on the owned base. The candidate's full SSH
rerun passed 137 tests with nine skips. The web theme-error and conversation
import failures passed their focused reruns. A separate full web rerun passed
19,053 tests with eight expected failures and an image pan test failure. That
gesture failure reproduced with the same assertion on the owned base and has
a separate test-only follow-up. Hosted tests on the runtime candidate passed
these lanes. The local aggregate result remains recorded as a failure.

## Delivery

This is an alignment of source and history through the normal merge queue.
The metadata commit advances the qualified source cursor and contains the
receipt. Release, deployment and mobile publication have separate approval.
