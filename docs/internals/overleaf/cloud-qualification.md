# Overleaf Cloud qualification results

**The disposable Overleaf Cloud test passed for every case it exercised.** It
closes the Cloud protocol gate for manual Git sync on macOS. It does not qualify
the coordinator, the UI, real network loss, Server Pro, Windows or Linux.

The test ran on October 9, 2026, with the protocol probe from PR #495
(`apps/server/scripts/qualify-overleaf-git.ts`), Git 2.54.0 on macOS, and a
disposable project with no collaborators and link sharing disabled. The Git
token was entered only at a local hidden prompt. Browser steps were performed
by hand and verified by the probe before it continued.

## Confirmed behaviour

| Case                                | Result                                                                                                                                                                                                          |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and branch discovery | Passed. Overleaf advertised `main`.                                                                                                                                                                             |
| First non-force push                | Accepted. A fresh, independent clone saw the exact commit and tree.                                                                                                                                             |
| Stale push                          | After a browser edit moved the project, the stale push was rejected as non-fast-forward. A fresh read confirmed Overleaf was unchanged and did not contain the stale tree.                                      |
| File and folder rename              | Accepted; an independent clone saw the exact commit and tree. Overleaf History records it as deletions and creations.                                                                                           |
| Lost acknowledgement                | A real accepted push had its success response discarded. The publisher classified it as **unknown**, as required.                                                                                               |
| Accepted, then reverted             | After that push, the file was edited in the browser and the project restored to the version before the push. The probe recognised the earlier push as accepted from bounded history, and did not publish again. |

## Constraints the product must respect

- **Git renames drop comments and tracked suggestions.** The renamed file kept
  its text, but its Review panel showed no comments or suggestions. The original
  folder stayed visible and empty. The sync review must warn before a rename is
  published.
- **The author shows as "You (via Git)".** Overleaf does not display Scient as
  the publisher. Do not promise a visible Scient author label.

## Not qualified

- Real network loss. Acknowledgement loss was simulated after a real accepted
  push, not injected into the TCP connection. PR B must still test unknown
  outcomes and restarts deterministically.
- Large projects and Overleaf's size limits.
- Arbitrary combinations of folder renames and creations.
- Overleaf Server Pro, Windows and Linux.
- The complete product journey, notarization and the installed-app updater.
