# Add project dialog design QA

## Scope

T3-inspired project intake adapted to Scient's existing command-dialog primitives and project-initialization flow. The intentionally supported sources are Local folder, Git URL, GitHub repository, and GitLab repository.

## Visual evidence

- Reference source chooser: `docs/pr-screenshots/add-project-dialog/reference-source-chooser.png`
- Reference path browser: `docs/pr-screenshots/add-project-dialog/reference-path-browser.png`
- Previous Scient entry point: `docs/pr-screenshots/add-project-dialog/before-sidebar.png`
- Implemented source chooser: `docs/pr-screenshots/add-project-dialog/after-source-chooser.png`
- Implemented path browser: `docs/pr-screenshots/add-project-dialog/after-path-browser.png`
- Implemented persistent sidebar action: `docs/pr-screenshots/add-project-dialog/after-sidebar.png`

The reference and implementation were compared together twice. Final measurements at the 1011 x 654 CSS-pixel viewport were 576 x 352 pixels for the source chooser and 576 x 420 pixels for the path browser. A 600 x 480 compact viewport was also checked with no horizontal overflow.

## Findings resolved

- Reduced the initial 672-pixel dialog to the reference's 576-pixel width.
- Moved the back/close control outside the command input's non-interactive addon so it is pointer and keyboard accessible.
- Reset repository input and error state when returning to Sources.
- Removed the command input's default search icon where it overlapped the back arrow.
- Preserved Enter navigation for the highlighted parent-directory row while retaining modifier-Enter submission for a highlighted folder.
- Kept unsupported Azure DevOps and Bitbucket rows out of the production flow instead of exposing non-functional options.

## Functional evidence

- Persistent folder-plus action opens the dialog without hover.
- Local browsing, typed paths, parent navigation, and the native file-manager escape hatch work.
- Git URL, GitHub, and GitLab clone requests use validated structured inputs and route the resulting folder through Scient's existing project initialization.
- GitHub and GitLab setup readiness is reported independently.
- A live local folder was added through the complete dialog-to-project-initialization journey.
- Clone failures remove only the newly reserved destination and do not create or delete unrelated parent folders.
- The final browser state has no current application errors; historical connection warnings occurred only while the isolated development server was intentionally stopped.

## Verification

- Full repository test suite: 12/12 tasks passed.
- Server project-source tests: 10/10 passed.
- Web focused unit tests: 32/32 passed.
- Add-project browser tests: 3/3 passed.
- Repository typecheck: 9/9 packages passed.
- Repository lint: 0 errors (existing warnings remain outside this feature).
- Production web build, server bundle, and full serialized repository build passed.
- `git diff --check` passed.

final result: passed
