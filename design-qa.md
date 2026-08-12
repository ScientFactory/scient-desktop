# Provider connection lab design QA

Status: historical QA record from 2026-08-09. This does not certify current
`origin/main` or the later preserved experiment state.

## Scope

Render the current Claude provider UI from the unfinished implementation worktree inside the
synthetic full-app provider lab. The implementation worktree remains read-only. The lab simulates
only provider snapshots and lifecycle-controller results; it does not read credentials, install
software, or contact a provider.

## Source of truth

- Branch: `feat/provider-lifecycle-claude-20260809`
- Worktree: `/Users/yaacov/REPOs/ScientFactory-worktrees/scient-desktop-next-provider-claude-20260809`
- Inspected head: `0a15193634c459f4b4eadaa6df586637f9f9e856`
- `ClaudeInlineSetup.tsx` and `claudeLifecycleActions.ts` are byte-for-byte identical between the
  implementation worktree and this lab.
- The shared `ChatComposer.tsx`, `ProviderModelPicker.tsx`, `ModelPickerContent.tsx`, and
  `ModelPickerSidebar.tsx` surfaces are also byte-for-byte identical.
- Lab-only code is limited to synthetic provider data, controller overrides, scenario controls, and
  the minimum integration wrapper needed to keep those scenarios available in the normal app.

## Browser verification

- Local route: `http://localhost:6264/draft/ed270dec-5fa3-4c88-a246-fa5b63b65196`
- The route is served from the provider full-app lab worktree on port 6264 with the explicit lab
  flag enabled.
- Verified the normal app shell, provider picker, Claude not-installed state, installed/signed-out
  state, browser handoff state, and the real collapsible one-time-code affordance.
- Verified the concise production copy: `Claude is not installed on this Mac`, `Private and
removable`, `Sign in with your existing Claude subscription`, and the official browser/password
  note.
- The scenario selector remains available for deterministic review of connected, update, progress,
  and failure states without touching a real account.

## Verification

- Web tests: 236 files and 2,104 tests passed.
- Web typecheck passed.
- Targeted lint, formatting, and `git diff --check` passed.
- Source-fidelity comparisons passed for the production Claude component and lifecycle helper.

## Boundary

This QA certifies that the lab renders the current branch UI code rather than a visual imitation. It
does not certify the unfinished Claude backend, provider authentication, managed-runtime download,
or real model discovery.

final result: passed
