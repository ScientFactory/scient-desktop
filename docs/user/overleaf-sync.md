# Manual Overleaf synchronization

Connect an Overleaf project from **Project Settings → Overleaf**. The project can appear at the
workspace root, in an existing subdirectory, or in a new subdirectory. The selected folder remains
an ordinary workspace folder: the app keeps the Git mirror in its private state directory and does
not create an Overleaf `.git` repository there.

Synchronization is manual. The app does not poll Overleaf and does not synchronize on open, save,
close, or a timer. Select **Sync** in Project Settings or in the LaTeX toolbar when you want to:

1. capture the current managed workspace files;
2. fetch and merge the project's advertised `main` or legacy `master` branch in the private mirror;
3. review any destructive or reverting candidate;
4. push the confirmed result; and
5. update the workspace without overwriting edits made after Sync began.

The first connection offers three choices:

- **Safe Combine** preserves files found on only one side and asks you to resolve same-path or
  structural conflicts.
- **Replace local** uses Overleaf's managed tree locally. The exact changes are shown first, and
  replaced or deleted managed files are retained in the connection's private pre-connect backup.
- **Replace Overleaf** commits the local managed tree on top of the discovered Overleaf branch. It does not force-push,
  and the review warns that comments or Track Changes metadata may be displaced.

## Accounts and identity

Save an account for the exact Overleaf Cloud or Server Pro Git host. A saved account can be reused
by several projects on that host. Tokens are write-only in the UI and API. They use the app's
existing private-file secret store; this is not an OS keychain and is not encrypted at rest. POSIX
uses private file modes, while Windows relies on the user profile and state-directory ACL.

Every new Overleaf commit uses the human name and email configured on the selected account for both
author and committer. The app adds no generated author, co-author, signature, or attribution.

## Reviews and conflicts

Every Sync exposes an expandable additions/modifications/renames/deletions summary. A push cannot
continue without explicit review when it would:

- delete an unmatched remote-managed file;
- restore a managed file to an older remote version; or
- restore the whole project to an older remote tree.

The first rename candidate also pauses with a comments/Track Changes warning. You may suppress later
rename-only warnings for that connection; renames remain visible, and deletion/revert review is never
suppressed. Size and file-count guidance is advisory and can be acknowledged with **Sync anyway**.

Git merges disjoint text edits automatically. For an overlapping conflict, choose **Keep Overleaf**,
**Keep Local**, **Keep both**, or **Delete** where applicable. Text conflicts have a read-only
side-by-side diff. Binary and structural conflicts show their paths, sizes, and hashes. You can also
preserve the unselected file as a local-only sibling such as
`chapter.overleaf-1a2b3c4d.tex`. A local-only companion is excluded from Sync until you choose
**Include on next Sync**.

Conflict markers never enter workspace files. While a conflict affecting a connected LaTeX project
is pending, the LaTeX editor is inert and links to Project Settings for resolution.

## Recovery and disconnect

If Overleaf accepts a push but local projection cannot finish, **Retry** completes the local step
without another network push. If local files changed after the final pre-push check, **Reconcile
local** performs an explicit offline three-way reconciliation and preserves the later edit. If a
push response was lost, Retry first fetches and proves acceptance from tree/history identity before
deciding whether another push is safe.

Use **Repair** to recreate a damaged private mirror and compare it through Safe Combine. Repair is
always explicit.

Disconnect never deletes workspace files. If local changes are pending, choose **Sync and
disconnect**, **Disconnect without syncing**, or **Cancel**. Saved accounts used elsewhere remain.
Local-only companion files are left as ordinary workspace files by default.

If access fails, the app reports that Git access is unavailable rather than guessing a subscription
cause. Check the project/Git URL, collaborator permissions, token expiry, Cloud project-owner Git
eligibility, or Server Pro Git Bridge configuration. Only HTTPS projects advertising an unambiguous
`main` or legacy `master` branch are supported in this version.
