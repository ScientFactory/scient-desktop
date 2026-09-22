---
name: scient-dev-app
description: Launch, verify, restart, or stop an isolated Scient Desktop development candidate from its owning checkout. Select the macOS managed or Windows foreground workflow. Not for release builds, deployment, or visual feature acceptance.
---

# Scient Dev App

Keep one candidate's code, state, processes, and ports attributable to its
checkout, without disturbing another candidate or the installed app.

## Resolve the request and host

Read-only inspection does not authorize launch, restart, or cleanup. For an
authorized lifecycle operation, identify the exact repository/worktree, branch,
commit, dirty state, and host OS before acting. Preserve unrelated changes and
running review apps; do not switch, reset, or update their checkout.

Read that checkout's `AGENTS.md`, `package.json`, and
`docs/operations/local-dev-app.md` from the repository filesystem. These are
checkout-owned documents, not resources bundled inside this skill. Use the
versions and commands in that revision rather than a maintainer's personal
paths or another branch's capabilities.

## Select the existing platform workflow

- **macOS:** use the runbook's managed lifecycle commands from the exact
  worktree. Check existing ownership before starting and reuse a healthy
  candidate. Ordinary feature review does not replace the stable launcher.
- **Windows:** also read `docs/operations/local-dev-app-windows.md`. Use its
  foreground desktop command and retain the owning terminal. Do not invoke
  macOS service commands or claim background persistence. If the available
  tool cannot retain the session, report that boundary rather than inventing
  a supervisor.
- **Other hosts:** consult `docs/operations/development.md`; do not assume
  that the managed macOS workflow applies.

Use isolated worktree state and synthetic data. Never copy credentials or live
profiles to make a candidate appear configured. Inspect the selected ports and
state root in output; never take another process's port or identify ownership
by a window title alone.

## Verify and retain

Apply the runbook's readiness checks before reporting success: correct
ownership, window/backend readiness, responding endpoints, and persistence
appropriate to the platform. A status message or HTTP response alone is not
feature acceptance. Leave the candidate available during the user's review.

For stop/restart, use the owning platform's procedure and verify that the old
runner, app, backend, and listeners are gone before relaunching. Never kill by
process name or broad path matching. If ownership or shutdown is uncertain,
preserve evidence and stop the operation; do not conceal it with a second app.

Hand off the exact worktree/commit, platform, state root, ports, lifecycle state,
readiness evidence, stop procedure, and any unverified capabilities. Keep keys
and pairing tokens out of durable evidence. Report startup verification
separately from microphone/OAuth checks and the user's visual acceptance.
