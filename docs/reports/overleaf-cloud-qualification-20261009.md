# Overleaf Cloud protocol qualification (2026-10-09)

Dated evidence record. It qualifies the exercised Git-bridge behaviors on
Overleaf Cloud, not a Scient feature. The current plan and coordinator rules
live in the [sync plan](../internals/scient-overleaf-sync-plan.md) and the
[coordinator contract](../internals/scient-overleaf-coordinator-contract.md).

## Setup

- Probe: `pnpm overleaf:qualify:git --cloud` from PR #495, at
  `e98c82cd46871d91826b85dd6c2b4a92336e1393` plus the probe corrections later
  pushed as `45bcd84a741a231734d1d2524921aeb2e56f9e36`.
- A disposable Cloud project with no collaborators and link sharing disabled.
  The owner entered the Git token only at the probe's hidden terminal prompt.
- macOS, Git 2.54.0. Raw observations, with remote URLs redacted:
  [overleaf-cloud-qualification-20261009.json](./assets/overleaf-cloud-qualification-20261009.json).

## Observed

| Behavior                        | Result                                                                                                                                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication and branch       | Passed; the project advertises `main`.                                                                                                                                                                                                               |
| Non-force push                  | Accepted. A fresh independent clone saw the exact published commit and tree.                                                                                                                                                                         |
| Publisher shown in History      | **You (via Git)**, not Scient's commit identity.                                                                                                                                                                                                     |
| Stale push after a browser edit | Rejected as non-fast-forward. A fresh read confirmed the remote unchanged and without the stale tree.                                                                                                                                                |
| File and folder rename          | Accepted with exact commit and tree. The renamed file kept its text but lost its comment and tracked suggestion ("No comments or suggestions"). The original folder stayed visible and empty. History records the rename as deletions and creations. |
| Lost acknowledgement            | A real accepted push whose response was discarded was classified unknown. After a browser edit and a History restore to before that push, the probe recognized the earlier candidate through bounded first-parent history and did not publish again. |
| Final independent read          | Matched the restored tree.                                                                                                                                                                                                                           |

## Not established

- Actual network loss: the acknowledgement loss was simulated after a real
  accepted push, not injected into the connection.
- Size limits, large projects, arbitrary rename/create combinations.
- Server Pro, Windows, Linux, the coordinator, the UI, notarized or updated
  installed apps.

## Consequences for the design

- Reviews must warn that a rename loses Overleaf comments and tracked changes.
- The product must not promise a visible Scient author label.
- Only an explicit out-of-date response proves rejection; acceptance after a
  lost response is established from positive evidence in fetched history, and
  absent evidence stays unknown.

An earlier attempt's stale-push result was invalid (the browser edit had not
been saved, so the push was a fast-forward); the probe now verifies the browser
edit before pushing and the restored tree before testing acceptance.
