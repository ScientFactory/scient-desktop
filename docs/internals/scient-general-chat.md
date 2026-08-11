# Scient General Chat

Status: Scient-owned candidate; automated and manual acceptance required before merge
Owner: ScientFactory
Last updated: 2026-08-11

## Product contract

General Chat is the home for conversations that have not been placed in a
project. It is an ordinary orchestration thread with `projectId: null`, not a
second chat engine or a hidden pseudo-project.

Scient supports multiple General Chats per environment. They appear in a
dedicated, searchable sidebar section; can be renamed, pinned, reordered,
snoozed, settled, archived, deleted, and copied like ordinary threads; and can
be moved into one project without changing their thread ID or conversation
history. The section's disclosure preference is persisted, and opening a
General Chat reveals it once without preventing the user from collapsing it
again. Its plain `+` action creates a General Chat directly in the active
capable environment, with the primary capable environment as fallback.

General Chat can open the right panel (or its responsive sheet) for browser
previews, files, PDF reading, and a plain terminal at the thread's authoritative
environment workspace. Its move control is available from the chat header when
the panel is closed or open; opening the panel adds a second copy of the same
action in the panel header. It cannot use project setup scripts, Git or
checkout operations, checkpoints, worktrees, pull requests, or revert actions
until it has been moved into a project. A local conversation fork stays in
General Chat and preserves the same environment root.

## Ownership boundary

ScientFactory owns General Chat end to end: product policy, capability
advertisement, naming, creation, workspace routing, navigation, mobile
presentation, relocation, and its projectless core compatibility behavior.
There is no runtime, build, release, or update dependency on an open T3 branch
or pull request.

The Scient-owned modules are:

- `packages/client-runtime/src/scient/generalChat.ts` for cross-client product
  identity and capability interpretation;
- `apps/server/src/scient/generalChat/` for server capability authority;
- `apps/web/src/scient/generalChat/` for workspace, terminal, and sidebar
  projection policy;
- `apps/web/src/components/scient-general-chat/` for navigation, disclosure,
  relocation, presentation, and compatibility controllers; and
- `apps/mobile/src/features/scient-general-chat/` for mobile-specific policy
  and a discriminated General Chat group that never fabricates a project.

Generic thread rows, provider sessions, event dispatch, and persistence remain
shared. They are reused through narrow mounts instead of copied into a second
Scient thread engine. The database migration
`apps/server/src/persistence/Migrations/041_ProjectlessThreads.ts` is immutable
history and must not be renamed or replayed.

Some adopted projectless core support necessarily remains in upstream-shaped
contracts, orchestration, persistence, web, and mobile files. Scient owns that
behavior until an equivalent implementation is merged into official T3. This
is deliberate: moving the same schema and thread engine into parallel files
would duplicate state authority and make the later official merge harder.
Product decisions must nevertheless enter through the Scient modules above;
inherited files should contain only nullability support and small mounting or
data-routing seams.

[`scient-general-chat-seams.json`](../../scient-general-chat-seams.json) is the
machine-readable ownership boundary. It names the Scient roots, the small
upstream-shaped mounts, and every reviewed source file that still makes a raw
projectless decision. `scripts/verify-scient-general-chat-seams.mjs` rejects a
new unreviewed decision, a missing mount anchor, or a return of mobile's old
fake-project adapter.

## Open T3 provenance is not a dependency

Scient history contains commit `5566cfc166cebd9b207a541cd8551fba23a4fbda`,
the then-current head of `pingdotgg/t3code#5822`. That commit is provenance for
code Scient adopted; the PR's state and future head are not authorities for
this feature. Scient does not refresh from, cherry-pick, or wait for that open
PR.

Only changes merged into official T3 `main` enter through the normal bounded
upstream merge process. If T3 later merges projectless threads, reconcile the
official ancestry against this owned boundary: prefer equivalent official
generic primitives, remove superseded compatibility patches, retain the
Scient product modules and product contract, and prove behavior with the same
characterization tests.

`upstream-state.json` freezes the exact three commits and import merge as a
historical exception with `followUpdates: false`. The dedicated Scient
provenance workflow fetches official T3 `main` and rejects a new merge parent
that is neither official ancestry nor that exact grandfathered import.

## Workspace and tool policy

The authoritative General Chat root is the durable thread `workspaceRoot`,
falling back to the connected environment `cwd` while a new thread is being
established. Files, search, PDFs, and terminals use only that root. General
Chat terminals receive no project-script environment and no worktree path.

Project-specific actions continue to require a real active project. A valid
General Chat workspace must never be used as evidence that Git, checkpoint,
worktree, setup-script, pull-request, or revert authority exists.

## Relocation invariant

Moving a chat changes the workspace in which future provider work will run.
Scient treats relocation as a lifecycle transition:

1. The client asks the provider reactor to stop the current session.
2. Projection state—not a timer or retry loop—confirms the stopped session.
3. The client submits one single-purpose `thread.meta.update` command.
4. The server accepts only `projectless -> active project` when no turn is
   running or queued, no provider session is live, and no terminal PTY for the
   thread is running.
5. One event changes `projectId`, clears the projectless `workspaceRoot`, and
   clears workspace-bound branch/worktree metadata.
6. Every projection applies that event while preserving the thread ID and
   conversation history.
7. After the destination project is observed, the client closes file, PDF,
   terminal, Diff, and PR surfaces that were bound to the old workspace.
   Browser and agent surfaces remain open.

Moving is disabled while any terminal remains open, and the server independently
rejects a raced request while a PTY is running. Permanent invariant failures
surface to the user.

## Upstream-conflict rule

Future T3 updates must preserve behavior before optimizing conflict count.
Resolve official generic improvements in the upstream-shaped core and adapt
the narrow Scient mounts. Do not duplicate the thread model, weaken project
guards, remove structured errors, or force project assumptions merely to make
a merge automatic. Every upstream pass must rerun General Chat creation,
workspace, terminal, capability, relocation, fork, persistence, web, and
mobile characterization tests.

## Candidate verification and friction evidence

The 2026-08-11 ownership candidate was checked against official T3
`2db08457f2f4` without importing that nine-commit range. Only `ChatView.tsx`
and this feature's user documentation overlap files changed by that range, and
both merge automatically. A merge-tree rehearsal from the aligned Scient base
already has five conflicts in existing theme/sidebar policy files; the complete
General Chat candidate produces the same five conflict files and adds none.

Before review, the exact dirty candidate passed formatting, lint, monorepo
typecheck, all 18 test tasks, production build, desktop smoke, release smoke,
branding, icon verification, mobile static checks, the seam verifier, and the
upstream provenance verifier. Manual UI acceptance remains required before the
candidate can be committed and published.
