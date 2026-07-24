# Add project dialog design QA

## Scope

Project-source intake adapted to Scient's existing command-dialog primitives and project-initialization flow. The intentionally supported sources are Local folder, Git URL, GitHub repository, and GitLab repository.

This follow-up adds a compact folder-drop affordance to the existing Local folder browser. It does not replace the dialog, hide the directory list, or change Scient's project-initialization policy.

## Visual evidence

- Reference source chooser: `docs/pr-screenshots/add-project-dialog/reference-source-chooser.png`
- Reference path browser: `docs/pr-screenshots/add-project-dialog/reference-path-browser.png`
- Previous Scient entry point: `docs/pr-screenshots/add-project-dialog/before-sidebar.png`
- Implemented source chooser: `docs/pr-screenshots/add-project-dialog/after-source-chooser.png`
- Implemented path browser: `docs/pr-screenshots/add-project-dialog/after-path-browser.png`
- Implemented persistent sidebar action: `docs/pr-screenshots/add-project-dialog/after-sidebar.png`
- User-approved resting row crop: `docs/pr-screenshots/add-project-dialog/folder-drop-resting-reference-row.png`
- User-approved drag-over row crop: `docs/pr-screenshots/add-project-dialog/folder-drop-active-reference-row.png`
- Native Scient resting row: `docs/pr-screenshots/add-project-dialog/folder-drop-resting-native-row.png`
- Sanitized component-harness resting state: `docs/pr-screenshots/add-project-dialog/folder-drop-resting-sanitized.png`
- Sanitized component-harness drag-over state: `docs/pr-screenshots/add-project-dialog/folder-drop-active-sanitized.png`
- Resting row comparison: `docs/pr-screenshots/add-project-dialog/folder-drop-resting-row-comparison.png`
- Drag-over row comparison: `docs/pr-screenshots/add-project-dialog/folder-drop-active-row-comparison.png`

The reference and implementation were compared together twice. Final measurements at the 1011 x 654 CSS-pixel viewport were 576 x 352 pixels for the source chooser and 576 x 420 pixels for the path browser. A 600 x 480 compact viewport was also checked with no horizontal overflow.

The new row was compared in both resting and drag-over states. The implementation row is 48 CSS pixels tall and its 36-pixel icon tile is vertically centered within one pixel. The native Electron capture confirms the resting row in the real Scient dialog. The sanitized component harness supplies the active-state comparison without recording local project names or paths; the browser harness darkens its whole modal surface, so color judgment for that state is based on the isolated user-approved row plus computed component colors, while behavior and geometry are proved by browser tests.

## Findings resolved

- Reduced the initial 672-pixel dialog to the reference's 576-pixel width.
- Moved the back/close control outside the command input's non-interactive addon so it is pointer and keyboard accessible.
- Reset repository input and error state when returning to Sources.
- Removed the command input's default search icon where it overlapped the back arrow.
- Preserved Enter navigation for the highlighted parent-directory row while retaining modifier-Enter submission for a highlighted folder.
- Kept unsupported Azure DevOps and Bitbucket rows out of the production flow instead of exposing non-functional options.
- Kept the drop row outside the scrollable listbox, so folder names remain visible and listbox semantics stay valid.
- Kept the row white and compact at rest, with only the small folder-plus tile using Scient's blue accent.
- Changed only the tile and copy to green during a valid drag-over; the directory browser remains visible underneath.
- Limited the advertised drop affordance to Electron surfaces that expose the native path resolver, avoiding a dead control in ordinary browsers.

## Functional evidence

- Persistent folder-plus action opens the dialog without hover.
- Local browsing, typed paths, parent navigation, and the native file-manager escape hatch work.
- Git URL, GitHub, and GitLab clone requests use validated structured inputs and route the resulting folder through Scient's existing project initialization.
- GitHub and GitLab setup readiness is reported independently.
- A live local folder was added through the complete dialog-to-project-initialization journey.
- Clone failures remove only the newly reserved destination and do not create or delete unrelated parent folders.
- The final browser state has no current application errors; historical connection warnings occurred only while the isolated development server was intentionally stopped.
- A folder can be dragged over any part of the open Local folder dialog. A valid single-folder drag receives native copy feedback and changes the row copy to “Release to add this folder.”
- The dropped folder is resolved to its exact native absolute path and enters the same existing submission path as browse/manual selection.
- File drops, multiple-item drops, unreadable native paths, and terminal-whitespace paths fail closed with focused guidance.
- A synchronous single-flight guard prevents rapid duplicate drops or a simultaneous picker action from submitting the same project twice.
- The row remains visible after scrolling the directory list to the bottom, and its polite status announcement is outside the listbox.

## Upstream lineage and disposition

- Donor concept: Synara commit `3eb5b1088f3189513115e389bf3b19eaffc7e821`, `apps/web/src/components/CreateProjectDialog.tsx`.
- Disposition: **Adapt / Reimplement** the single-folder drag-and-drop concept on Scient's existing Local folder seam.
- Not imported: Synara's broader Spaces model, replacement dialog architecture, provider/runtime changes, or project lifecycle assumptions.
- Synara's full unreviewed range was not advanced by this bounded adaptation. `reviewedThrough` remains `3a5720bdd0ae4ace444379cabf0a634941d232fd`.

## Verification

- Full repository test suite: 12/12 tasks passed.
- Server project-source tests: 10/10 passed.
- Folder-drop logic tests: 11/11 passed.
- Add-project browser tests: 22/22 passed.
- Stable browser certification: 274 passed, 11 skipped across all four isolated groups.
- Repository typecheck: 9/9 packages passed.
- Repository lint: 0 errors (existing warnings remain outside this feature).
- Brand and identity check passed.
- Production web build, desktop bundle, server bundle, and CLI bundle passed (5/5 tasks).
- Release smoke passed, including a native `node-pty` spawn.
- The folder-plus tile opened the native macOS directory picker from the exact isolated build.
- Real Finder-to-Electron drag remains a manual acceptance gate: automated cross-window pointer
  drags did not produce renderer drag events, so this record does not claim native drop proof.
- Sanitized evidence scan found no local user names, private paths, or embedded image text.
- `git diff --check` passed.

final result: passed
