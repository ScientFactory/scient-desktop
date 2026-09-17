# T3 alignment through 1ab2dfb5

Status: automated qualification passed; owner requested PR delivery and merge-commit auto-merge.
No additional visual acceptance is claimed. This is one full,
history-preserving alignment from the previously integrated official boundary through the exact
official target below. It is not a split, cherry-pick, squash, or replay.

## Frozen history

- Owned base: `cbd99c95fbb07cf5c3575b9a5058c6749ae17ca5`.
- Previous official integration: `01e64193d9d2abfae8f7b3d20f66824e38397bd6`.
- Official target: `1ab2dfb5a7bd2996f79407b5d02cae6132a7626c` (37 first-parent commits after
  the previous official integration).
- Nearest target tag: `v0.0.43-nightly.20260917.1851`, three commits before the target.
- Branch: `codex/t3-sync-dd9528a9-20260917`.
- Initial history-preserving merge: `f3a0406a28fe7122fdf3ad0932942ed38e401d1b`, from the owned
  base through `dd9528a974ba534faa8d1588f3f137fa2a281860`.
- Same-branch extension merge: `86b5bb723178ec1959e916d6722e958e5268859e`; its first parent is
  `d1a8574362d2f64038e06aa0d8d1b26f67482855` and its second parent is the exact final official
  target. The first parent incorporates owned main `cee69d80373272fce40d0e1f866193164066c852`
  and its updated PDF authoring guidance.
- `upstream` remains fetch-only (`https://github.com/pingdotgg/t3code.git`, push `DISABLED`).
- During PR delivery, Scient main advanced to `5efa7360c11ed01c6070bfd1bdba45567e6c45b4`
  (Ask in chat citation/voice improvements, #294). Merge
  `c12158ff08d5f813d4828ccc6e74b67a7ed1288e` incorporates it without textual conflicts;
  the official integration target remains unchanged.

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
- Mobile model favorites persist on the device, sort before other models, and remain visible when
  legacy models are hidden. They do not synchronize with desktop favorites.
- Preview picking keeps its navigation listener across subframe navigation and cancels correctly on
  subsequent main-frame navigation, using Electron's current event-object contract.
- Scient's approved stable-only desktop policy hides the inherited channel selector, normalizes
  stale Nightly preferences before updater configuration, and honors that effective channel for
  IPC requests. The existing update feed, downloader, installer, and release workflow are retained.
  Development versions are identified with a Dev suffix; packaged version labels remain unchanged.

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
root is `/private/var`; the storage fixture now resolves its scoped temporary root before deriving
test configuration. All 58 settlement/cleanup tests pass with the ordinary host environment, without
weakening the production guard or requiring a special `TMPDIR`. Second, upstream bootstrap test commands omitted Scient's queue protocol
version and therefore failed before reaching the behavior under test; those fixtures now exercise
the real protocol. A deleted-worktree fixture also now declares its concrete project owner rather
than widening the production cleanup contract to nullable projects.

The two-commit extension has one textual conflict in the mobile model picker. Upstream favorites
filtering and sorting feed Scient's existing presentation-only Antigravity grouping. Native model
IDs, the full catalog, staged selections, and reasoning controls remain unchanged. A regression
assertion verifies that filtering a favorite cannot replace it with a selected/default reasoning
variant outside the filtered results. The preview manager and its tests overlap but compose without
conflict; Scient keyboard, browser authorization, and PDF export seams remain intact.

Final review found that earlier composition conditioned the working header on the presence of a
tool, moving it below a thoughts-only group. Restoring upstream's header placement removes redundant
fallback insertion while retaining Scient's post-handoff setup-script row. The regression suite
covers thoughts, tools, commentary, setup handoff, and stable row identities. Settings-search tests
now assert that commands follow matching product settings without assuming T3's smaller catalog;
the toast layout test follows the adopted icon/title header and still checks Scient's full-width
body/action row. The user update guide no longer advertises an unsupported Nightly track.

## Qualification

- Formatting, lint, recursive typecheck, production build, desktop smoke, release smoke, brand, mobile native
  static discovery, repository diff integrity, and analysis/onboarding/Skills/LaTeX seam checks
  passed. Lint and typecheck retain existing non-blocking React and Effect suggestions.
- Final server verification covered 491 files and 6,898 passing tests, with 15 files and 63 tests
  skipped by declared conditions. The full run passed 490 files and exposed only the temporary-root
  fixture failures above; its corrected file then passed all 58 tests. The test-only repair also
  passed server typecheck and targeted lint.
- The complete desktop suite passed 115 files and 1,414 tests, with four files and 43 tests skipped.
  The complete mobile suite passed 174 files and 1,632 tests. The recursive run also passed contracts,
  shared, scripts, relay, and Scient package suites.
- Initial web failures exposed the working-header composition and outdated search/toast assumptions
  described above. After repair, the complete web rerun passed 684 files and 7,912 tests.
- After incorporating Scient main's #294 during delivery, the complete web suite passed again:
  685 files and 7,926 tests. Web typecheck and build, formatting, lint, preservation seams, and
  upstream provenance were rechecked for the composed result.
- Focused stable-only updater coverage passed 67 tests across four files; focused mobile favorites
  and preview picking coverage passed 125 tests across four files.
- PR CI identified an obsolete exported Lexical direction plugin left after the Tiptap switch.
  The unused wrapper was removed; Tiptap still calls the unchanged DOM direction helper, now in
  `applyComposerDirection.ts`. The exact `knip:check` and `vp check` gates pass, along with web
  typecheck and 54 bidi tests covering RTL/LTR, return to Automatic, and newly inserted paragraphs.
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

The owner requested pull-request creation and merge-commit auto-merge after this review. Cleanup
and release publication remain separate actions; this pass does not claim new manual acceptance.
