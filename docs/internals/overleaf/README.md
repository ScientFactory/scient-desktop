# Overleaf manual sync: collaborator handoff

**Next action: step 5, the last coordinator step, when the owner says go.** It switches the engine on in the server and takes five additions from [pr-c-design.md](pr-c-design.md) section 7. After it come the agent tools (PR C1), then the screens (PR C2).

This folder holds the plans for manual two-way sync between a folder in a Scient project and an Overleaf project, over Overleaf's Git integration.

**These are temporary working documents on a PR that will be closed, not merged.** Edit them freely as decisions are made. Permanent documentation ships with the feature PR it describes: the coordinator steps update `docs/internals/scient-overleaf-engine.md`, and PRs C1 and C2 add the agent, user and app documentation listed in [pr-c-design.md](pr-c-design.md) section 9.

Status as of October 24, 2026. The engine and the coordinator's steps 1–4 are merged, but nothing calls them yet: there are no routes, agent tools or screens. This PR has one editor at a time; currently the agent building the coordinator ("Overleaf 2").

## The two rules that shape everything after step 4

1. **Agents can do whatever a person can.** An agent on full access has full access. Overleaf adds no permission, approval, confirmation, warning or stop of its own; the composer's access setting is the only control, and nothing changes it.
2. **Like GitHub sync, only a conflict stops a sync.** Everything else is done, then reported, with Undo.

The full product design, including the one-folder-per-Overleaf-project model and the five ways to connect, is in [pr-c-design.md](pr-c-design.md).

## Where things stand

| Piece                                                                                         | State                                                                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync rules, merge engine and safe local apply                                                 | **Merged** in [#486](https://github.com/ScientFactory/scient-desktop/pull/486). See [the engine notes](../scient-overleaf-engine.md).                                                                                                                                                                                            |
| macOS file-exchange helper, signing, protocol probe                                           | **Merged** in [#495](https://github.com/ScientFactory/scient-desktop/pull/495) and [#555](https://github.com/ScientFactory/scient-desktop/pull/555).                                                                                                                                                                             |
| Real Overleaf Cloud test                                                                      | **Passed** for the exercised cases. See [Cloud results](cloud-qualification.md).                                                                                                                                                                                                                                                 |
| Coordinator steps 1–4                                                                         | **Merged**: state, receipts and lease ([#536](https://github.com/ScientFactory/scient-desktop/pull/536)); inventory and review ([#556](https://github.com/ScientFactory/scient-desktop/pull/556)); checkout barrier, apply, recovery and kept copies (#626, #630); publication (#633, #634). Each reviewed by Codex until clean. |
| Coordinator step 5: connect, routes, server mount                                             | Not started. Scope in [contract section 11](pr-b-coordinator-contract.md#11-transport-and-implementation-order).                                                                                                                                                                                                                 |
| PR C1: agent tools                                                                            | Not started. [pr-c-design.md](pr-c-design.md) section 6.                                                                                                                                                                                                                                                                         |
| PR C2: screens and user guide                                                                 | Not started. [pr-c-design.md](pr-c-design.md) section 8. The Files-panel Connect button is being designed in its own thread (worktree `scient-desktop-connectui-20261023`).                                                                                                                                                      |
| [#121](https://github.com/ScientFactory/scient-desktop/pull/121), the original implementation | Closed October 19 with thanks to its author. Its UI is a useful reference for PR C2.                                                                                                                                                                                                                                             |

## Build order

1. **Step 5:** connect, disconnect, relink, token renewal, cancel and status; authenticated routes; wiring into the server; and the five additions (offline status, a "needs a decision" flag, the other-agents line, the new-file rule, holding back only a conflicted file).
2. **PR C1, agent tools:** status, preview, connect, sync, decide, files, kept copies, Undo and management; the request that saves open editors in every window; two engine operations (send a file kept only here; Undo); the built-in Overleaf skill. Its acceptance is the first real end-to-end sync against Overleaf Cloud, driven by an agent.
3. **PR C2, the screens:** the Overleaf chip, the review tab, settings, the connect dialog, and the user guide. Then the full journey in a packaged, signed build.

The contract's [acceptance matrix](pr-b-coordinator-contract.md#12-acceptance-matrix-fixed-before-code) (A01–A32) lists the tests each coordinator step must pass. Write them with the step, not afterwards.

## Working rules

- **Build, review, merge.** Each piece is reviewed by Codex until clean, then merged through the queue, one PR at a time, after merging current main into it.
- **One builder per step.** Open a draft PR, or comment on this one, before starting, so two people do not build the same layer.
- **Refresh source owners first.** Main moves fast; check the files in [contract section 1](pr-b-coordinator-contract.md#current-owners-and-required-additions) before relying on them.
- **Permanent docs go in the feature PR.** Do not add plans or handoff notes to feature PRs, and do not add permanent docs here. Link this PR from each feature PR.
- **Never force-push to Overleaf, and never resend a push whose outcome is unknown.** Recovery classifies it from Overleaf's history; anything else waits for a fresh sync.
- **Never add an Overleaf permission or approval step for agents**, and never change the composer's access setting.

## Still open with the owner

Four defaults, recommended as they are: a review expires after 15 minutes; a 5 GiB limit on each connection's private repository; a conservative 50,000,000-byte upload check; official Overleaf Cloud as the only host at first. See [contract section 1](pr-b-coordinator-contract.md#1-basis-and-dependency).

## What you need

- macOS with an APFS disk. The exchange helper and signing are macOS-only for now.
- System Git 2.39 or newer. Tests must also pass at 2.39.
- For Cloud tests, your own disposable Overleaf project with Git access. Enter the token only at a local prompt or Scient's secure secret request; never put it in a file, log, PR or chat.

## Out of scope

Live collaboration (real-time sync) is planned separately and is not part of this delivery. Real network-loss testing comes later; it does not block the coordinator as long as unknown outcomes stay unknown.

## Files

- [Product design for agents, the app and the docs](pr-c-design.md): the October 24 decisions. Wins over the other files where they differ.
- [Implementation plan (revision 5)](implementation-plan.md): what gets built, the sync rules, decisions D1–D14, qualification gates and risks.
- [Coordinator contract](pr-b-coordinator-contract.md): states, transitions, locks, recovery, budgets and the acceptance matrix.
- [Step 3b design](step-3b-design.md) and [step 4 design](step-4-design.md): the coordinator's local half and publication.
- [Cloud results](cloud-qualification.md): what the real Overleaf test proved and what it did not.
