# Overleaf agent tools

Agents reach Overleaf manual sync through seven Scient tools
(`apps/server/src/mcp/toolkits/overleaf/`). They call the same `OverleafSync`
service as the routes ([engine](scient-overleaf-engine.md#service-and-routes)),
as the calling thread: the service resolves the thread's workspace, and a thread
in another worktree acts on the copy the link belongs to.

**No Overleaf gate.** The tools add no permission, approval, confirmation or
stop of their own, and never read or change the composer's access setting. They
need only the `documents:build` grant every session already has, and their
operation records say `session-grant`. The provider's own handling of tool calls
under the composer setting is the only control. Each tool is annotated honestly
(read-only, destructive, open-world), which providers use for their own prompts.

**Results.** Every success carries `lines`, the sentences a person would see
(pr-c-design.md section 4.1), beside structured fields from the same views the
routes return. Lines name counts, manuscript paths and fixed categories only:
never Git's text, a commit or the token. A result for a thread in another
worktree starts with the linked-copy line ("This link belongs to the copy of the
project at …; your edits in this worktree are not in it until they are merged
there").

**Failures** are `ScientOverleafToolError` with a fixed `code` and a message
that says what to do next: `invalid-input`, `project-required`,
`project-changed`, `workspace-not-authorized`, `relink-needed`, `token-missing`,
`token-invalid`, `secret-unavailable`, `project-invalid`, `editor-save-failed`
(with `paths`), `operation-active`, `connection-not-ready`, `recovery-required`,
`checkout-busy`, `limit-reached`, `state-locked`, `connection-changed`,
`retention-unavailable`, `overleaf-unreachable`, `overleaf-access-denied`,
`overleaf-project-not-found`, `git-unavailable`, `failed`. The service reports
Git failures as fixed refusal reasons, which map to the `overleaf-*` and
`git-unavailable` codes; a raw Git error, should one arrive, is classified the
same way (`classifyProbeGitFailure`). Anything unexpected is logged by its tag
and returned as `failed`.

**Request IDs.** Every connect, sync, restore, disconnect and relink call uses a fresh request ID.
The service keeps a receipt per request ID, so reusing one would return the
earlier receipt instead of running again; a retried tool call is a new request.

## Tools

| Tool                          | Input                                                                             | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scient_overleaf_status`      | `connectionId?`                                                                   | `tokenSaved`; the project's active `connections` (with `linkedHere`); a status per link, offline (`ScientOverleafStatus`), or the error that kept one from being read.                                                                                                                                                                                                                                                                                             |
| `scient_overleaf_preview`     | `connectionId`, `choices?`, `files?`, `diff?`                                     | `link`, `preview`: the review (incoming, outgoing, conflicts with keys and allowed choices, `remoteTree`, new files with `selected` and `skippedBecause`, files kept only here, warnings, marked files), a refusal, or `recovered`. Fetches; changes nothing on Overleaf. With `diff: true`, also returns bounded `diff` text pairs for the base-to-fetched and base-to-publication trees, or a stale-review reason. Binary/oversized entries contain no contents. |
| `scient_overleaf_connect`     | `project` (link or ID), `mode` (`new-folder` or `link-folder`), `folder`          | `result` (`done` with the connection, or `refused` with a reason), `firstSync` (a preview of the first sync), `suggestNewFolder`.                                                                                                                                                                                                                                                                                                                                  |
| `scient_overleaf_sync`        | `connectionId`, `choices?`, `reviewedRemote?`, `files?`                           | `link`, `result` (`synced`, `needs-decision`, `refused`, `duplicate`, `unsettled`, `cancelled`, as the route returns it).                                                                                                                                                                                                                                                                                                                                          |
| `scient_overleaf_kept_copies` | `connectionId`, `restore?` (`applyId`, `kept`, `keptRevision`, `currentRevision`) | `link`, `copies` (after any restore), `restored` (`restored`, `not-restored`, `needs-attention`, `stale`, `unknown-copy`, `duplicate`, or null).                                                                                                                                                                                                                                                                                                                   |
| `scient_overleaf_undo`        | `connectionId`, `attemptNumber?`, `files?`                                        | Without `attemptNumber`: `sends`, the sends that can be undone, newest first, each with its `changes`. With it: `result` (`ScientOverleafUndoResult`: `undone` with `restored`, `removed`, `recreated`, `skipped` with reasons, `outcome` and the `sync` after it; `not-eligible`; `refused`; `duplicate`; `cancelled`). `files` goes to the sync after the undo. Both return `link`.                                                                              |
| `scient_overleaf_manage`      | `connectionId`, `action` (`disconnect`, `relink`, `recover`, `cancel`), `folder?` | `result`: the manage result; for `recover`, whether there was an interrupted apply and how it ended (`outcome`: `complete`, `replan` or `attention`), and which earlier sends were found accepted or are still unresolved; for `cancel`, `requested` or `nothing-running`. Recover also returns `link`, naming the copy it ran in.                                                                                                                                 |
| `scient_overleaf_token`       | `action` (`status`, `save`, `remove`), `secretRef?`                               | `saved`.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

- **Choices** are `{ key, choice }` with `choice` one of `mine`, `theirs`,
  `markers`, keyed by a conflict's key from the last preview or sync.
- **Connect.** `new-folder` needs a folder
  name: Overleaf's Git bridge does not give the project's title, so the agent
  names it (after the paper). After a link, the tool previews the first sync;
  a preview that cannot run leaves the link in place and says why. For
  `link-folder` it walks the folder (at most 2,000 entries, no hidden folders,
  no links) and sets `suggestNewFolder` when it holds five or more code or data
  files, or any when the folder is the project's top. That is information, not
  a step (pr-c-design.md section 3).
- **Sync**, **restore**, **preview** and **recover** look the link up in the project's list first, so
  the result names the linked copy; a link the list leaves out
  fails with the service's own reason (relink, another project, disconnected).
- **Relink** records the folder in the calling thread's copy.
- **Files** (pr-c-design.md section 5) are fields on preview and sync, not a
  tool of their own: `files.keepOnlyHere` keeps new files only on this computer
  (remembered until sent), `files.send` sends a new file the rule skips
  (build output, hidden, Scient's own) or one kept only here, and
  `files.release` sends a file held back for its conflict marks as it is, for a
  file whose marks are its content (results say `released`; one another held
  file blocks is refused as `release-held`, with a line saying so). Paths are relative
  to the linked folder. Results name the skipped files with their reason, the
  files kept only here, and new files over 50 MB, which stay here. Files held
  for their conflict marks are named in every preview and sync result, an
  up-to-date preview and a stop at a conflict included.
- **Choices and `reviewedRemote`.** A result that lists conflicts gives the
  review's `remoteTree`; the agent passes it back as `reviewedRemote` with its
  choices. If Overleaf moved since, the result is a fresh review that needs a
  decision; the tool's first line says the choices don't answer this new review.
  It never says they were not applied: when the first attempt applied them and
  Overleaf changed while sending, the retry stops at the new review with the
  choices already in the folder.
- **Cancel** asks the link's running sync (in this server) to stop at its next
  stage boundary; an apply or send in progress finishes.
- **Incoming wording.** Overleaf's changes are said to have come in only when the
  apply completed. A replanned apply wrote nothing and needs a fresh review
  (sync again); the tool infers neither why nor whether the folder already holds
  that content; one that needs attention may have stopped partway, and
  the result says why (interrupted file groups, conflict marks, or a file or kept
  copy that changed).
- **What a sync did first.** Every sync result but `duplicate` carries
  `retried` (the first attempt applied a review, then Overleaf moved while it
  was sending: nothing was sent and the sync ran again) and `settled` (an
  interrupted earlier sync it finished first, with that apply's outcome). The
  result says each, exactly, before its own lines ("First finished an interrupted
  sync: …", "The first attempt applied a review to the folder, then …"), and
  says nothing about them when they say nothing happened. The stop lines then
  describe only the review or step that stopped ("This sync stopped: …", "none
  of this review's changes were applied"). A preview carries `settled` the same
  way; its refusal says a sync can't run now.
- **Recovery wording.** Recover (and a preview that settles an interrupted sync
  first) says what the recovery's own apply established: `complete` puts what it
  was applying in the folder, `replan` wrote nothing and needs a fresh review (sync again), `attention`
  needs a look. A preview that finished an interrupted sync first says how,
  since that wrote the folder.
- **Restore wording.** `restored` only when the restore's apply completed;
  `not-restored` when the restore wrote nothing (list again and retry), and
  `needs-attention` when it may have stopped partway.
- **Send wording.** Renames and older versions are said as done only when
  Overleaf accepted the send; for a send with no answer the result says they may
  have been sent, and when nothing was sent it says so and leaves them for the
  next sync. A send refused before it went names the possible causes (the folder,
  the workspace or the token changed) rather than guessing one.
- **Refusals** from connect, disconnect and relink are results with a sentence,
  including `authority-changed`, `request-incomplete`, `records-unreadable` and
  `project-invalid`.

## Saving editors first

Every call that may write the folder saves its open editors first: sync, a
kept-copy restore, undo, and every preview, connect's first-sync preview and
recover, because preparing or recovering can finish an interrupted apply. The
tools don't do it themselves: `OverleafSync` does, for the tools and the screens
alike, holding the connection from the save to the end of the operation (see
the engine document). A failed save comes back as `OverleafEditorUnsavedError`,
which the tool reports as `editor-save-failed` with `paths`, naming each file a
window could not save and why, and each window that did not answer (timed out
or went away); nothing was changed. No window open counts as saved.

`OverleafEditorSave` (`apps/server/src/scient/overleaf/OverleafEditorSave.ts`)
is the one seam to the editor-save request: the server provides
`layerFromEditorFlush`, which asks every open window through `EditorFlush`
(each window has 10 seconds, the whole request 30), sharing one `EditorFlush`
with the WebSocket handlers the windows answer on. A folder the request cannot
examine is a failed save of that folder. `OverleafSync.testkit.ts` answers saves
as a test says and records each folder asked.

## The token

The token never travels as tool input or output. The agent asks the user with
`request_secret`, which stores the value under a single-use `secretRef` for the
thread's project. `scient_overleaf_token` with `save` consumes that ref through
`SecretRequests.consume` for the calling thread's host project (the path
scheduled webhook tasks use), and passes the value only to
`OverleafSync.saveToken`. A value that is not a token (empty, with spaces, over
512 characters) fails as `token-invalid`; a used or expired ref fails as
`secret-unavailable` and points back to `request_secret`.

## How agents learn it

- The tool descriptions, written as instructions.
- A "Scient Overleaf" block in `ScientAwareness.ts`, included with document
  authority: it names `scient_overleaf_status` and the skill.
- The built-in `overleaf-sync` skill (`apps/server/src/scient/skills/built-ins/`):
  the folder model, when to make a new folder, the token flow, settling
  conflicts and conflict marks, and what to do when something stops.
- An "Overleaf" entry among the built-in plugins in the Extensions library.

## Not yet

Start fresh after damaged
history, testing a token without syncing, and bringing an Overleaf project in as
a new Scient project have no service operation yet.
