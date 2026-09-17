# T3 alignment through dd9528a9

Status: automated qualification passed; owner manual review pending. This is one full,
history-preserving alignment from the previously integrated official boundary through the exact
official target below. It is not a split, cherry-pick, squash, or replay.

## Frozen history

- Owned base: `cbd99c95fbb07cf5c3575b9a5058c6749ae17ca5`.
- Previous official integration: `01e64193d9d2abfae8f7b3d20f66824e38397bd6`.
- Official target: `dd9528a974ba534faa8d1588f3f137fa2a281860` (35 first-parent commits after
  the previous official integration).
- Nearest target tag: `v0.0.43-nightly.20260917.1851`, one commit before the target.
- Branch: `codex/t3-sync-dd9528a9-20260917`.
- History-preserving merge: `f3a0406a28fe7122fdf3ad0932942ed38e401d1b`; its first parent is the exact
  owned base and its second parent is the exact official target.
- `upstream` remains fetch-only (`https://github.com/pingdotgg/t3code.git`, push `DISABLED`).

## Adopted behavior

- The web composer adopts T3's Tiptap rich-text implementation and enables rich text by default,
  including lists, task items, formatting, mentions, paste handling, and draft cursor restoration.
  Scient file/source citations, citation comments, bidirectional text, voice, queue, and attachment
  behavior remain composed into the shared editor boundary.
- A new local task can select multiple models and create one thread per model in separate
  worktrees. The flow keeps Scient's provider availability rules, custom model support,
  project-first policy, and server-authoritative command queue.
- Machine and project settings can configure automatic cleanup for settled worktrees, browser
  artifacts, and rotated logs. Cleanup fails closed around dirty, shared, active, recent, merged,
  or policy-protected worktrees and serializes against provider use of the same workspace.
- Folder links open and reveal the file tree instead of entering a broken file preview. Directory
  selection suppresses file-only reload, error, and auxiliary controls.
- Command-palette search now finds pull-request and usage pages, thread IDs, and searchable
  keybindings. Theme choices include color previews, notifications align their icons and titles,
  and composer/environment controls expose clearer tooltips.
- Pull-request views reuse cached details, render resilient author avatars, improve comment
  scanning, and preserve the complete progressive-diff behavior adopted in the preceding alignment.
- Chat activity groups thoughts into the changing tool line, aligns task rows and timestamps, keeps
  reading positions, defaults diffs to the working tree, and collapses individual files initially.
- Server checkpoint publication flushes objects and refs before advertising them, preserves ready
  checkpoints over later placeholders, keeps VCS waits from blocking turn completion, and settles
  linked pull-request and cancelled worktree-setup state promptly.
- Mobile adopts the shared Android Material layout/control system, worktree setup progress and
  handoff, compose-FAB stability, selection-color support, and a wake lock while dictation is active.

## Deliberately retained Scient architecture

- Scient's durable server-authoritative queue remains the only queue. T3's new composer and
  multi-model UI dispatch through that protocol, including queue protocol version validation,
  rather than introducing browser-local authority.
- Projectless task creation was not reintroduced. Nullable project records remain supported only at
  existing compatibility boundaries; new multi-model local tasks require the active project and
  receive distinct worktrees.
- Scient's signed npm-pinned server runtime, provider install/update/repair/remove lifecycle,
  custom-model routing, product awareness, scientific surfaces, citations, state roots, analytics
  consent, preview/browser authorization, and release authority remain authoritative.
- Scient's fork provisioning disposition remains available only for fork commands. Other upstream
  bootstrap and orchestration errors retain their typed payloads verbatim.
- Upstream mobile store/OTA publication, hosted-cloud activation, release workflows, and product
  identity were not activated. Compatible mobile code is retained without creating publication
  authority.
- No migration was added or renumbered. Scient's immutable migration sequence remains unchanged.

## Conflict composition and review findings

The merge presented 36 textual conflicts plus auto-merged overlap across composer, thread routing,
mobile task creation, server reactors, provider/model selection, settings, file navigation, and the
lockfile. Resolutions kept upstream mechanisms shared and placed Scient policy at existing seams:

- Composer composition uses one Tiptap implementation rather than parallel editors. A generic
  citation extension carries both upstream file references and Scient source citations. Draft
  cursor memory is bounded to 128 entries, and editor identity includes the draft and rich/plain
  mode so state cannot leak across tasks.
- Multi-model creation reuses upstream selection and worktree setup while keeping Scient provider
  lifecycle, availability, costs, continuation behavior, and project guards. It does not create an
  overlapping local queue.
- Server layers start both Scient's queue worker and upstream storage cleanup. Thread settlement,
  pull-request synchronization, and bootstrap disposition combine nullable-project compatibility
  with upstream's immediate synchronization and cleanup behavior.
- File query state composes upstream authoritative-data handling with Scient's non-file guard.
  Directory navigation now reveals/selects/expands the tree and never renders file-only actions.
- Settings search includes upstream storage controls alongside Scient scientific, provider, Skills,
  integrations, and source-control entries. Duplicate provider setup and toast descriptions found
  during semantic review were removed.

Semantic review caught two test/composition issues Git could not identify. First, upstream storage
tests used macOS's `/var` temporary alias while the cleanup correctly rejects paths whose canonical
root is `/private/var`; qualification now uses the canonical host temporary root without weakening
the production guard. Second, upstream bootstrap test commands omitted Scient's queue protocol
version and therefore failed before reaching the behavior under test; those fixtures now exercise
the real protocol. A deleted-worktree fixture also now declares its concrete project owner rather
than widening the production cleanup contract to nullable projects.

## Qualification

- Formatting, lint, recursive typecheck, production build, desktop smoke, brand, mobile native
  static discovery, repository diff integrity, and analysis/onboarding/Skills/LaTeX seam checks
  passed. Lint and typecheck retain existing non-blocking React and Effect suggestions.
- The complete server suite passed 491 files and 6,898 tests, with 15 files and 63 tests skipped by
  declared conditions. The complete desktop suite passed 115 files and 1,414 tests, with four files
  and 43 tests skipped.
- The recursive workspace test run passed all web, mobile, contracts, shared, scripts, relay, and
  Scient package suites. Its first desktop attempt raced the concurrent production build while both
  extracted Electron; the serial desktop rerun above passed completely after that host-only race.
- Mobile native source discovery found 11 Swift and 23 Kotlin files. SwiftLint, ktlint, and detekt
  are unavailable on this host and were reported as skipped.
- No computer use, visual acceptance, live-provider qualification, Windows execution, or native
  iOS/Android visual review was performed.

## Owner manual review

1. Create and edit rich-text drafts: formatting, lists, tasks, mentions, paste, undo/redo, cursor
   restoration, bidirectional text, voice, attachments, and file/source citations with comments.
2. In a Git project, choose multiple available models for a new task. Confirm separate worktrees and
   threads are created, provider availability is accurate, and no projectless path appears.
3. Exercise the durable queue and steer behavior while rich text is enabled: send, queue, edit,
   reorder/resume, remove, and switch drafts without content or cursor leakage.
4. Open folder links from chat and select directories in Files. Confirm the tree reveals and expands
   the folder and the preview does not show file-only loading, errors, reload, or actions.
5. Review Settings > Storage at machine and project scope, plus settings search for Storage,
   Keybindings, Pull Requests, Usage, and Scient-specific pages.
6. Check working-tree diffs, collapsed files, chat activity lines, task rows, notifications, tool
   timestamps, prompt stash, pull-request comments, avatars, and cached detail transitions.
7. Recheck Scient forks, provider setup/manage/update, custom models, Sources, scientific pages,
   browser authorization, voice, citations, and release/update presentation around touched shared
   surfaces.
8. On Android where available, review Material layouts and controls, new-task worktree progress,
   handoff, compose FAB motion, text selection, and sustained dictation with the screen awake.

Manual acceptance, pull-request creation, merge to `main`, cleanup, and release publication remain
separate owner decisions.
