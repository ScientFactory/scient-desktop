# `@scientfactory/project-init`

This package is the UI-independent, Scient-owned kernel for recognizing and
initializing local scientific project folders. It is permanent product code,
not a prototype fixture.

The public workflow is intentionally split into three steps:

1. `inspectProjectFolder` reads and classifies a folder without writing.
2. `planProjectInitialization` returns explicit create, preserve, propose, or
   conflict operations.
3. `applyProjectInitialization` applies only a still-valid, conflict-free plan.

Initialization creates the smallest universal foundation:

- `PROJECT.md` for human-readable project orientation;
- `AGENTS.md` for portable baseline agent rules, while preserving existing
  user-owned content through proposals;
- `.scient/skills.lock.json` for the exact immutable identities of selected
  Scient built-in skills, without copying or running their bodies;
- `.scient/project.json` for path-independent project identity, written last.

Discipline-specific additions are data-only `ProjectProfileDescriptor` values.
The package does not contain a default medicine, biology, chemistry, physics,
or mathematics profile.

Built-in skills are supplied as release descriptors by the application. The
kernel can expose them for explicit selection and records only their ID,
version, digest, and origin. A skill selection is an activation decision, not
an invocation, scientific claim, or grant of additional authority. Profiles
may later recommend selections, but profiles and skills remain distinct
objects.

## Boundary

The kernel depends on Node filesystem and cryptography primitives, but not on
Electron, React, the Scient desktop shell, Synara application modules,
OpenCode, or SQLite. The desktop server and UI call this package through a
narrow integration that keeps generated plans server-owned; future agent tools
should use the same kernel rather than reimplementing its rules.

## Safety contract

- Inspection and planning perform no writes.
- Apply never overwrites an existing path.
- Existing `PROJECT.md` is preserved.
- Existing `AGENTS.md` changes remain proposals until explicitly accepted.
- Relative paths are validated for traversal, symlink, case, Unicode, and
  cross-platform filename hazards.
- A recoverable transaction marker is written before project files.
- The selected built-in skill lock is written transactionally and must match
  the exact release descriptors used to create the plan.
- Project identity is written last, so incomplete work is never reported as a
  fully initialized project.
- Recovery and rollback refuse ambiguous or externally redirected state.

Projects initialized before the skills lock was introduced remain compatible;
opening them does not silently add or change skill activation state.

The exclusive hard-link install step is deliberate: it provides a no-clobber
commit of a fully written and synced temporary file. Filesystems without hard
link support currently fail safely instead of falling back to a rename that
could overwrite a concurrently created target.

## Developer CLI

The CLI is a development adapter, not the future product UI:

```sh
bun src/cli.ts inspect /path/to/project
bun src/cli.ts plan /path/to/project --title "Example project"
bun src/cli.ts apply /path/to/project --title "Example project"
bun src/cli.ts recover /path/to/project
bun src/cli.ts rollback /path/to/project
```

The application integration should retain and present the returned plan before
calling apply; the CLI's `apply` command creates its own fresh plan because it
is an explicit developer operation.
