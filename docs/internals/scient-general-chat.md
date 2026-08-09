# Scient General Chat

Status: Implemented candidate; manual acceptance pending
Owner: ScientFactory
Last updated: 2026-08-10

## Product boundary

General Chat is the home for conversations that have not been placed in a
project. It is not a second chat engine and it does not imitate a separate
consumer-chat service. A general chat is an ordinary orchestration thread with
`projectId: null`, displayed in a dedicated collapsible section above the
project filter.

The user can start several general chats, return to them from that section,
search them with the existing sidebar search, and move a useful conversation
into one project without losing its title, messages, or thread identity.
The section starts collapsed and is separated from the project selector by a
quiet divider. Persisting the user's disclosure preference is intentionally
deferred until the surrounding sidebar preference model has an owned home.

General Chats also use Scient's ordinary conversation-fork feature. A local
fork preserves the same environment root and remains in General Chat until the
user deliberately moves it into a project. A General Chat cannot request a
separate Git worktree because it has no project-owned checkpoint workspace.

## Ownership and upstream fit

T3 owns the generic projectless-thread foundation, provider sessions, thread
events, persistence, search, and row behavior. Scient owns:

- the visible **General chat** terminology and sidebar section;
- the compact header affordance for moving a chat into a project;
- the relocation controller; and
- the server invariant that makes the workspace transition safe.

The primary Scient UI is isolated under
`apps/web/src/components/scient-general-chat/`. The inherited `Sidebar`,
`ChatHeader`, and `ChatView` changes are mounting and data-routing seams. The
relocation contract is additive to `thread.meta.update`, avoiding a parallel
thread model or a new persistence table.

The branch includes the real history of pending T3 projectless-thread PR
`pingdotgg/t3code#5822`. Before publication, refresh the official PR and
upstream main. If T3 merges a changed version, reconcile by ancestry rather
than replaying the feature manually.

## Relocation invariant

Moving a chat changes the workspace in which future provider work will run.
Scient therefore treats relocation as a lifecycle transition, not a cosmetic
sidebar edit:

1. The client asks the provider reactor to stop the current session.
2. The client submits a single-purpose `thread.meta.update` command.
3. The server accepts only `projectless -> active project` for a thread with no
   running or queued turn and no live provider session.
4. One event changes `projectId`, clears the projectless `workspaceRoot`, and
   clears workspace-bound branch/worktree metadata.
5. The in-memory, durable, shell, and open-thread projections apply that same
   event while preserving the thread ID and conversation history.

The brief client retry handles only the projection delay between an accepted
session stop and the authoritative stopped state. All permanent invariant
failures surface to the user and are not retried.

## Deliberate limits

- General chats run in the environment's default working directory; they do
  not create a hidden pseudo-project.
- Relocation is one-way into a project. Project-to-project moves need a
  separate product and data-safety decision.
- Relocation is unavailable while a response is active.
- A destination project must belong to the chat's environment and must still
  be active.
- Project-specific Git, checkpoint, and source-control controls remain absent
  until the chat belongs to a project.
- General Chat forks continue in the same environment; project worktree forks
  remain available only to checkpoint-backed project conversations.
