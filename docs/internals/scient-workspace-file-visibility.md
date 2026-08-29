# Scient workspace file browsing and visibility

Status: Accepted architecture
Owner: ScientFactory
Purpose: Defines truthful, useful, and scalable workspace file browsing without
turning Files into a recursive dump of project machinery.
Doc type: Architecture decision record
Scope: Desktop Files browsing, deliberate internal inspection, and the minimum
policy needed to render and edit entries truthfully
Implementation status: Implemented and automatically validated in this candidate;
manual desktop acceptance remains pending
Deferred work: [GitHub issue #201](https://github.com/ScientFactory/scient-desktop/issues/201)

## Decision

Scient will treat Files as a truthful, user-facing view of project material, not as a rendering of Git's tracked-file set and not as a dump of every implementation path.

The ordinary Files view will:

1. show useful project files and directories, including dotfiles and Git-ignored material;
2. hide only exact, conservatively classified machinery such as version-control internals, dependency stores, disposable caches, and transient Scient state;
3. default unknown in-workspace paths to visible;
4. enumerate one directory at a time instead of loading a recursive project index;
5. keep managed or tool-owned internals read-only in generic Files; and
6. offer a quiet, session-scoped `Show workspace internals` action for deliberate raw inspection.

Tree visibility is a presentation decision. It does not grant or revoke provider filesystem authority, preload file contents into model context, decide content-search eligibility, or make a file safe to send to an external service.

Project-wide filename discovery must ultimately cover the same ordinary-visible namespace and report incomplete scope honestly. This ADR deliberately does not choose a new filename index. That choice requires separate evidence and is tracked in [issue #201](https://github.com/ScientFactory/scient-desktop/issues/201).

## Why

The user owns the workspace. A file that helps them understand, study, develop, reproduce, or deliver the project should not disappear because its name starts with a dot or because Git does not track it.

That principle does not require displaying every implementation path by default. `.git/objects`, `node_modules`, interpreter caches, and transaction staging are machinery. They reduce signal and can contain hundreds of thousands of entries. Keeping them quiet is a product decision about the ordinary view, not a security boundary or a denial of ownership.

The current Files tree couples two different jobs:

- [`WorkspaceSearchIndex`](../../apps/server/src/workspace/WorkspaceSearchIndex.ts) recursively builds a fuzzy-search index with Git and tool ignore semantics; and
- [`FileBrowserPanel`](../../apps/web/src/components/files/FileBrowserPanel.tsx) uses an empty search result as the complete tree and resets the client model from that flat result.

The index returns at most 25,000 entries. The server reports truncation, but the tree can still appear complete. Broadening that recursive index to include every ignored and hidden path would make startup, memory, payload, and truncation behavior worse.

Direct directory reads already exist in [`WorkspaceEntries`](../../apps/server/src/workspace/WorkspaceEntries.ts), and exact file reads are independently protected by [`WorkspaceFileSystem`](../../apps/server/src/workspace/WorkspaceFileSystem.ts). The root problem is therefore not opening a known file. It is recursively discovering and transferring most of the workspace before the user asks to see it.

Measurements taken on the Scient checkout on 2026-08-27 support that diagnosis:

| Observation                             |     Measured result |
| --------------------------------------- | ------------------: |
| Entries returned by the current index   |              18,770 |
| Full empty fuzzy search, median         |        about 412 ms |
| Serialized full-tree response           |       about 1.75 MB |
| Direct warm root-directory read, median |        under 0.1 ms |
| `node_modules` in the measured checkout | about 231,000 files |

These are diagnostic observations, not universal performance targets. They must be refreshed before implementation.

## First principles

### User value decides ordinary visibility

Ordinary Files contains material a user may reasonably need to identify, open, understand, or manage as part of the project. Examples include source code, papers, lessons, datasets, figures, notebooks, reports, project configuration, local notes, and ignored project-specific data.

Dot prefixes and Git ignore state are metadata. They are not visibility rules.

### Exclusion must be exact and conservative

Hiding causes silent loss of discoverability, so it requires an exact path rule with a clear owner and rationale. Generic names such as `data`, `results`, `output`, `build`, `dist`, `target`, `vendor`, `cache`, `history`, or `records` remain visible unless a known subsystem owns that exact path.

A name that merely resembles an internal path is not internal. For example, `.github-notes` must not match `.git`.

### Useful managed data remains accessible

A Scient subsystem may provide the clearest primary surface for an object, but durable project data must not become opaque. Generic Files may keep raw managed storage out of the ordinary view while deliberate internal inspection provides a read-only fallback.

This ADR does not require Files to become a second Sources, Skills, or Settings editor. Valid mutation remains with the owning subsystem.

### Performance follows the user's navigation

Initial work is proportional to the root's direct children. Expanding a directory is proportional to that directory's direct children. Unopened branches do not create payload, tree-model, or indexing work.

Useful files are not hidden to compensate for an eager architecture.

### Visibility is not authority or context

- A hidden row does not remove native or agent filesystem access.
- A visible row does not preload content into a conversation.
- Exact reads still enforce workspace confinement, symlink, size, binary, and revision safeguards.
- Model-facing and sensitive-file behavior is decided at the action that can expose content, not by the tree alone.

### Mutation has one owner

Ordinary user-authored files can be edited through Files. Scient-managed and tool-owned internals are inspectable read-only there when direct edits could bypass validation or corrupt machinery. Their owning subsystem remains the mutation authority.

## Visibility policy

The server owns one small, deterministic path policy. The first implementation needs only these orthogonal facts:

```ts
type WorkspaceEntryDisposition = {
  readonly visibility: "ordinary" | "internal";
  readonly mutation: "files" | "owner";
  readonly reasonCode: string;
};
```

`reasonCode` supports fixtures and diagnostics. It need not be serialized unless the client has a concrete user-facing action that requires it. New policy fields are added only when an implemented behavior consumes them.

Policy precedence is:

1. reject paths outside the canonical workspace root;
2. apply exact Scient-owned or well-known tool-internal rules;
3. set the mutation owner for managed or tool-owned paths; and
4. default every other in-root path to ordinary, Files-owned project material.

### Ordinary-visible material

The ordinary view includes:

- regular project files and directories;
- project configuration such as `.github`, `.vscode`, `.devcontainer`, `.editorconfig`, `.gitignore`, and `.gitattributes`;
- locally useful sensitive-name files such as `.env` and `.env.local`;
- Git-tracked, untracked, and ignored project material;
- generated reports, figures, PDFs, datasets, and other meaningful outputs; and
- the durable `.scient` documents listed below.

`generated` is not a visibility class. A generated artifact can be a first-class deliverable.

### Internal-only material

The initial exact policy keeps these classes out of ordinary Files:

| Class                      | Initial exact examples                                                           | Generic Files mutation |
| -------------------------- | -------------------------------------------------------------------------------- | ---------------------- |
| Version-control internals  | `.git`, `.svn`, `.hg`, `.jj`, `CVS`                                              | Read-only              |
| Dependency stores          | `node_modules`, `.pnpm-store`, `.yarn/cache`, `.venv`, `venv`                    | Read-only              |
| Disposable language caches | `__pycache__`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.tox`, `.nox`     | Read-only              |
| Scient runtime machinery   | `.scient-next` and exact owned staging, lock, transaction, index, or cache paths | Read-only              |
| Operating-system metadata  | `.DS_Store`                                                                      | Read-only              |

This list must remain small and fixture-tested. A subsystem that wants another path hidden must add an exact rule, rationale, and test. Unknown paths fail open to ordinary visibility.

### `.scient` material

`.scient` is a visible managed container whose children are classified independently and lazily.

| Path class                                                                | Ordinary Files                                  | With internals | Generic Files mutation |
| ------------------------------------------------------------------------- | ----------------------------------------------- | -------------- | ---------------------- |
| `.scient/project.json`                                                    | Visible, managed                                | Visible        | Read-only              |
| `.scient/skills.lock.json`                                                | Visible, managed                                | Visible        | Read-only              |
| Future user-authored project skill sources                                | Visible once their storage contract is accepted | Visible        | Editable               |
| `.scient/sources/records`, `history`, `receipts`, and stored source files | Hidden; Sources is primary                      | Visible        | Read-only              |
| `.scient/sources/operations` and `staging`                                | Hidden                                          | Visible        | Read-only              |
| Exact subsystem caches, indexes, locks, migrations, and temporary files   | Hidden                                          | Visible        | Read-only              |

`PROJECT.md` and `AGENTS.md` are ordinary root project documents, not `.scient` internals.

Sources remains the primary surface for logical source details, PDFs, notes, export, editing, and removal. Internal inspection ensures that authoritative records, durable evidence, and stored bytes remain reachable without making raw hashed paths the ordinary user experience. Richer Sources provenance and history presentation is deferred to [issue #201](https://github.com/ScientFactory/scient-desktop/issues/201).

### Deliberate internal inspection

The Files overflow menu includes one checkable action: `Show workspace internals`.

- It is off by default.
- It applies only to the current workspace and app session.
- It does not affect useful dotfiles or ignored project files, which are already ordinary.
- Enabling it re-enumerates the root and loaded branches; unopened directories remain unloaded.
- Managed and tool-owned internal entries open read-only in generic Files.
- It does not add internal paths to filename search, content search, composer suggestions, telemetry, or model context.
- Disabling it removes internal rows without claiming to revoke native or agent access.

It is deliberately not called `Show hidden files`: hidden-name conventions do not define ordinary visibility.

## Minimal architecture

### Pure policy plus direct directory listing

Add one small Scient-owned pure policy module and one additive directory-listing boundary. Do not introduce a stateful `WorkspaceFileCatalog`, dynamic subsystem registry, or second background index for the first slice.

An endpoint such as:

```ts
projects.listDirectory({
  cwd,
  relativeDirectory,
  view: "ordinary" | "with-internals",
  continuation?,
})
```

returns only direct children:

```ts
{
  entries: Array<{
    name: string;
    relativePath: string;
    kind: "file" | "directory" | "symlink";
    readOnly: boolean;
  }>;
  continuation: string | null;
  complete: boolean;
}
```

The names are illustrative. The lasting contract is behavioral:

- normalize the workspace root and confine every request to it;
- enumerate one directory directly;
- classify direct children with exact rules;
- never follow a symlink outside the workspace;
- return stable, predictable ordering;
- expose failure or incomplete results at the affected branch; and
- never silently truncate.

Pagination mechanics are selected only after refreshed measurements of unusually large single directories. A revision-bound cursor protocol is not required unless evidence shows that a simpler continuation cannot remain truthful and reliable.

The existing flat `projects.listEntries` contract remains during migration so mobile and other consumers are not forced into the desktop change.

### Narrow client adapter

Keep the existing `@pierre/trees` component. Its public model already supports incremental `add`, `batch`, and `remove` operations.

The Scient adapter will:

- load root children afresh when Files mounts or remounts;
- load a directory on first expansion;
- track only loaded, loading, failed, and complete branches;
- update the affected branch rather than reset the whole workspace model;
- preserve selection, expansion, and focus through refresh;
- keep the existing panel-level refresh action as the minimum recovery path by
  re-enumerating the root and every loaded branch;
- re-enumerate loaded branches when internal inspection changes; and
- reveal an exact path by enumerating its ancestors in order.

The whole tree is reset only when the workspace root changes. The tree library and its upstream behavior are not forked.

### Filename discovery remains independent

The tree's search field is project-wide filename discovery, not merely a filter over loaded branches. Search results can enumerate and reveal their ancestors without preloading the rest of the tree.

The current FFF path index excludes some Git-ignored material. The first lazy-tree slice may preserve that legacy search temporarily only if the UI reports its scope as partial. It must not present legacy index coverage as the final visibility policy.

Before building a second index, compare the smallest viable approaches at representative scale: adapting or replacing the existing path index, bounded query-time traversal, or an incremental metadata index. The long-term design should have one filename-discovery mechanism rather than permanent parallel indexes. This investigation belongs to [issue #201](https://github.com/ScientFactory/scient-desktop/issues/201).

Content search, composer suggestions, and sensitive model-facing actions remain separate decisions. Changing the tree must not broaden them accidentally. Broader filename discovery must not feed composer suggestions until the sensitive-path behavior for that surface is decided.

### Preserve existing exact-file safeguards

Exact file reads continue through `WorkspaceFileSystem`. Lazy discovery does not weaken root confinement, realpath checks, symlink-escape rejection, file-size limits, binary detection, revisions, or atomic writes.

The generic Files write boundary consults the same minimal policy before writing. It rejects paths whose mutation owner is `owner`; validated Sources, Skills, Project, or tool-specific APIs remain unaffected.

### Keep the upstream seam narrow

The intended change consists of:

- one additive Scient-owned pure policy module;
- one additive directory contract and server handler;
- one small Scient client adapter around the existing tree;
- one policy check at the generic Files write boundary; and
- no change to FFF, the tree library, provider permission architecture, or unrelated T3 routes.

The exact file placement may follow current repository structure. The important constraint is that the policy remains Scient-owned and the upstream components remain intact.

## Acceptance invariants

### Product behavior

- Useful dotfiles and ignored project material appear without a preference change.
- `.git`, dependency stores, disposable caches, and exact Scient internals stay out of ordinary Files.
- Unknown in-root entries remain visible.
- `Show workspace internals` exposes internal paths lazily and read-only.
- Durable `.scient` documents and raw managed evidence remain deliberately inspectable.
- Generic Files cannot write managed or tool-owned internals.
- Exact previews retain all current filesystem safeguards.
- No incomplete directory is presented as complete.
- Files visibility does not change agent access or model context.

### Performance and reliability

- Initial loading is proportional to root children, not total workspace size.
- Expanding or refreshing one branch does not scan or rebuild unrelated branches.
- The existing Files refresh action re-enumerates the root and loaded branches,
  so recovery from stale rows does not depend on future watcher machinery.
- Large hidden machinery does not create normal tree payload or model work.
- Project switching cannot leak cached paths from the previous root.
- Remote clients transfer requested branches rather than a complete tree.
- Branch loading, failure, retry, and incomplete states are keyboard- and screen-reader-understandable.

### Architecture

- One server-owned pure policy determines ordinary versus internal visibility and generic mutation ownership.
- Desktop Files no longer depends on an empty fuzzy-search query.
- Search and browsing remain separate lifecycles.
- The new contract is additive while legacy consumers remain.
- No upstream tree or search library is forked.
- No new stateful catalog or filename index ships without evidence that the smaller design is insufficient.

### Documentation

When user-facing behavior ships, update the owning `docs/user/` guidance for Files browsing, internal inspection, and any changed search scope. Every implementation PR records the required documentation-impact declaration.

## Consequences

### Benefits

- Files reflects meaningful project material rather than Git tracking mechanics.
- Ignored datasets, notes, local configuration, and generated deliverables become browsable.
- Large internal trees no longer justify hiding unrelated files.
- Advanced users can inspect machinery without making it the default experience.
- The first implementation remains small, testable, and isolated from upstream T3.
- Deferred improvements remain visible in one tracking issue without becoming foundation requirements.

### Costs and limits

- Lazy browsing adds branch loading and error state to the desktop client.
- Exact path policy requires maintenance when a subsystem introduces project-local storage.
- The first slice may expose a temporary mismatch between truthful browsing and legacy filename-search coverage; that mismatch must be disclosed.
- Internal raw files can be difficult to interpret, so owning surfaces remain responsible for meaningful long-term presentation.
- Files is not a security sandbox and must not be described as one.

## Deferred work

Implementation sequencing and future investigations are tracked in [GitHub issue #201](https://github.com/ScientFactory/scient-desktop/issues/201), including:

- filename discovery and ignored-file coverage;
- content-search policy and budgets;
- composer and sensitive model-facing actions;
- richer managed-data provenance and inspection UX;
- branch freshness, remote scale, and large-directory pagination;
- mobile migration; and
- policy governance for future `.scient` subsystems.

Those items are deliberately not prerequisites for the minimal lazy browsing foundation. Each must establish evidence and the smallest adequate design before implementation.

## Implementation readiness

Implementation must begin from a clean branch based on current `main`, with the relevant contracts and server/client seams revalidated. The first executable slice should turn the visibility and mutation examples above into table-driven policy tests before adding UI behavior.

No additional product-policy decision is required to begin that bounded slice. Parameters such as response budgets and continuation mechanics must come from refreshed measurements rather than speculative infrastructure.

## References

- [Follow-up planning issue #201](https://github.com/ScientFactory/scient-desktop/issues/201)
- [Git documentation: `.gitignore`](https://git-scm.com/docs/gitignore)
- [`WorkspaceSearchIndex`](../../apps/server/src/workspace/WorkspaceSearchIndex.ts)
- [`WorkspaceEntries`](../../apps/server/src/workspace/WorkspaceEntries.ts)
- [`WorkspaceFileSystem`](../../apps/server/src/workspace/WorkspaceFileSystem.ts)
- [`FileBrowserPanel`](../../apps/web/src/components/files/FileBrowserPanel.tsx)
- [`Project` contracts](../../packages/contracts/src/project.ts)
- [`FileTreeBrowser` mobile consumer](../../apps/mobile/src/features/files/FileTreeBrowser.tsx)
- [Scient project initialization](./scient-project-initialization.md)
- [Scient skills](./scient-skills.md)
- [Scient Sources](./scient-sources.md)
