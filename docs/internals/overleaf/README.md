# Overleaf manual sync: collaborator handoff

**Next action: finish reworking PR B step 1 ([#536](https://github.com/ScientFactory/scient-desktop/pull/536)) for decision 1, then step 2. Step 2 can start in parallel.**
This folder holds the plan, the coordinator contract and the Cloud test results
for manual two-way sync between a Scient project folder and an Overleaf project,
over Overleaf's Git integration.

**These are temporary working documents on a PR that will be closed, not
merged.** Edit them freely as decisions are made. Permanent documentation ships
with the feature PR it describes: PR B updates
`docs/internals/scient-overleaf-engine.md`, and PR C adds the user guide and
the final internals notes.

Status as of October 13, 2026. The foundation is merged; the feature is not yet
usable in the app. This PR has one editor at a time; currently the agent
building PR B ("Overleaf 2").

## Where things stand

| Piece                                                                                         | State                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync rules, merge engine and safe local apply                                                 | **Merged** in [#486](https://github.com/ScientFactory/scient-desktop/pull/486). Not wired into the running server. See [the engine notes](../scient-overleaf-engine.md).                                                                                                                  |
| macOS file-exchange helper, signing, protocol probe                                           | **Open draft** [#495](https://github.com/ScientFactory/scient-desktop/pull/495), aligned with main on October 13 (head `4c918b9f3b`, mergeable). Ready to merge once its checks pass; a signed macOS build has not been rechecked since the alignment (a release gate, not a merge gate). |
| Real Overleaf Cloud test                                                                      | **Passed** for the exercised cases. See [Cloud results](cloud-qualification.md).                                                                                                                                                                                                          |
| PR B coordinator contract                                                                     | **Written and in use.** Step 1's code was reviewed against it three times by Codex (gpt-6.1-sol, high). See [the contract](pr-b-coordinator-contract.md).                                                                                                                                 |
| PR B step 1: state, receipts, lease, retention preflight                                      | **Draft [#536](https://github.com/ScientFactory/scient-desktop/pull/536), in rework for decision 1** (vault beside the checkout, volume-UUID identity, exchange capability check, unplugged disk). The rest is done and reviewed.                                                         |
| PR B steps 2–5: coordinator service and routes                                                | Not started. See [contract section 11](pr-b-coordinator-contract.md#11-transport-and-implementation-order).                                                                                                                                                                               |
| PR C: client, settings, review sheet, Sync button                                             | Not started.                                                                                                                                                                                                                                                                              |
| [#121](https://github.com/ScientFactory/scient-desktop/pull/121), the original implementation | Open draft, conflicting. Superseded by this approach because of demonstrated correctness defects (see [plan section 7](implementation-plan.md#7-pr-121s-confirmed-defects)). Its UI is a useful reference for PR C.                                                                       |

## Decided

All four open decisions were answered by the owner on October 13, 2026. The
contract's [owner-decisions table](pr-b-coordinator-contract.md#owner-decisions-october-13-2026)
is the reference.

1. **Projects on another disk are supported in v1.** Retained copies go in a
   hidden `.scient-overleaf` folder beside the checkout on the project's own
   disk, with a subfolder per environment and connection. Scient identifies
   it by the disk's volume UUID plus the folder's file ID, so a remounted disk
   is still recognized. It refuses, with a specific reason, a disk without a
   readable volume UUID, a disk where the #495 helper cannot exchange files
   atomically (exFAT and FAT, tested), and a location where no protected
   folder can be created. Details: [contract section 8](pr-b-coordinator-contract.md#8-retention-disk-failures-and-inventory-budgets).
2. **A push Scient refused to start is recorded `not-sent`**, not `unknown`.
3. **A checkpoint restore finishes an unfinished Overleaf apply itself**
   when the connection is idle, and refuses only if that fails.
4. **PR B ships as stacked PRs**, one per step. Plans stay on this PR.

The contract also proposes new defaults that still need the owner's approval:
a 15-minute review lifetime, a 5 GiB limit on each connection's private
repository, a conservative 50,000,000-byte upload check, and official Overleaf
Cloud as the only host at first. See
[contract section 1](pr-b-coordinator-contract.md#1-basis-and-dependency).

## Build order

1. **PR B step 1** ([#536](https://github.com/ScientFactory/scient-desktop/pull/536)):
   connection, apply-intent, push-attempt and receipt formats; a crash-safe
   connection store that rejects stale updates, refuses changes that would
   lose publication evidence, and quarantines corrupt files; the process
   lease; the retained-copy folder (decision 1). Its capability check uses
   the #495 helper.
2. **Step 2:** bounded folder capture and plan assembly, review digests and
   replacement plans.
3. **Step 3:** the shared checkout lock across checkpoint restore, pull, branch
   switch and worktree removal; local apply, recovery and retained restore.
   **#495 must be merged first**: this step applies changes through its helper.
4. **Step 4:** verifying the reviewed files, recording a push before sending,
   classifying accepted, rejected or unknown outcomes, and never resending
   automatically.
5. **Step 5:** authenticated routes, wiring into the server, and an independent
   review of the complete service.
6. **PR C:** the connection settings, review sheet with rename warnings,
   conflict and retained-file recovery, and the Sync button with editor flush.
   Because the retained-copy folder is hidden, PR C must offer a way to reveal
   kept copies, for example "Show kept copies" opening the folder in Finder,
   alongside compare and restore. Then the full journey against a disposable Cloud project in a packaged,
   signed build.

The contract's [acceptance matrix](pr-b-coordinator-contract.md#12-acceptance-matrix-fixed-before-code)
(A01–A32) lists the tests each step must pass. Write them with the step, not
afterwards.

## Working rules

- **One builder per step.** Open a draft PR, or comment on the parent PR,
  before you start a step, so two people do not build the same layer.
- **Refresh source owners first.** The contract pins main
  `988ceaa4d2`; step 1 was rebuilt on `deaa13dab5`. Main has moved since; check the files in
  [contract section 1](pr-b-coordinator-contract.md#current-owners-and-required-additions)
  before relying on them.
- **Do not copy #495's helper code into PR B.** Build on main after #495 merges,
  or stack on #495's exact head.
- **Permanent docs go in the feature PR.** Do not add plans or handoff notes to
  feature PRs, and do not add permanent docs here. Link this PR from each
  feature PR.
- **Never force-push to Overleaf, and never resend a push whose outcome is
  unknown.** Recovery classifies it from Overleaf's history; anything else waits
  for a fresh review.

## What you need

- macOS. The exchange helper and signing are macOS-only for now.
- System Git 2.39 or newer. Tests must also pass at 2.39.
- For Cloud tests, your own disposable Overleaf project with Git access. Enter
  the token only at a local prompt; never put it in a file, log, PR or chat.

## Out of scope

Live collaboration (real-time sync) is planned separately and is not part of
this delivery. Real network-loss testing comes later; it does not block PR B as
long as unknown outcomes stay unknown.

## Files

- [Implementation plan (revision 5)](implementation-plan.md): what gets built,
  the sync rules, decisions D1–D8, qualification gates and risks.
- [PR B contract](pr-b-coordinator-contract.md): states, transitions, locks,
  recovery, budgets and the acceptance matrix.
- [Cloud results](cloud-qualification.md): what the real Overleaf test proved
  and what it did not.
