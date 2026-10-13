# Overleaf manual sync: collaborator handoff

**Next action: answer the four open decisions below, then build PR B step 1.**
This folder holds the plan, the coordinator contract and the Cloud test results
for manual two-way sync between a Scient project folder and an Overleaf project,
over Overleaf's Git integration. It is documentation only; no product code
depends on it.

Status as of October 13, 2026. The foundation is merged; the feature is not yet
usable in the app.

## Where things stand

| Piece                                                                                         | State                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sync rules, merge engine and safe local apply                                                 | **Merged** in [#486](https://github.com/ScientFactory/scient-desktop/pull/486). Not wired into the running server. See [the engine notes](../scient-overleaf-engine.md).                                            |
| macOS file-exchange helper, signing, protocol probe                                           | **Open draft** [#495](https://github.com/ScientFactory/scient-desktop/pull/495), head `45bcd84a74`. Its checks passed, but it now conflicts with main and must be updated and requalified before merging.           |
| Real Overleaf Cloud test                                                                      | **Passed** for the exercised cases. See [Cloud results](cloud-qualification.md).                                                                                                                                    |
| PR B coordinator contract                                                                     | **Written**, checked against main by its author; **independent review still pending**. See [the contract](pr-b-coordinator-contract.md).                                                                            |
| PR B: coordinator service and routes                                                          | Not started.                                                                                                                                                                                                        |
| PR C: client, settings, review sheet, Sync button                                             | Not started.                                                                                                                                                                                                        |
| [#121](https://github.com/ScientFactory/scient-desktop/pull/121), the original implementation | Open draft, conflicting. Superseded by this approach because of demonstrated correctness defects (see [plan section 7](implementation-plan.md#7-pr-121s-confirmed-defects)). Its UI is a useful reference for PR C. |

## Open decisions

These must be answered before the step that needs them. Record the answer here
and in the contract.

| #   | Question                                                                                   | Recommendation                                                                                                                                                                  | Needed for |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| 1   | Where retained file copies go when the project is on a different volume from Scient's data | **Refuse in v1**, with a clear message. The contract's section 8 currently describes a fallback vault next to the checkout; adopting this recommendation removes that fallback. | Step 1     |
| 2   | How to record a push Scient refused before sending it (for example, the checkout changed)  | Record it as `not-sent`, not `unknown`. A crash before that record is written still leaves it unknown.                                                                          | Step 4     |
| 3   | What a checkpoint restore does when an Overleaf apply was left unfinished                  | Finish the local recovery inside the restore, under the restore's checkout lock; refuse only if that fails.                                                                     | Step 3     |
| 4   | How to deliver PR B                                                                        | Stacked PRs. Step 1 is its own internal-only PR from main, not yet wired into the server, like #486.                                                                            | Delivery   |

The contract also proposes new defaults that need the owner's approval: a
15-minute review lifetime, a SQLite process lease for the Overleaf state folder,
same-volume retained copies, a 5 GiB limit on each connection's private
repository, a conservative 50,000,000-byte upload check, and official Overleaf
Cloud as the only host at first. See
[contract section 1](pr-b-coordinator-contract.md#1-basis-and-dependency).

## Build order

1. **PR B step 1:** connection, apply-intent, push-attempt and receipt formats;
   a crash-safe connection store that rejects stale updates and quarantines
   corrupt files; pinned objects in the private repository; the process lease;
   the same-volume, private-permission check on the retained-copy folder. Does
   not need #495.
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
   Then the full journey against a disposable Cloud project in a packaged,
   signed build.

The contract's [acceptance matrix](pr-b-coordinator-contract.md#12-acceptance-matrix-fixed-before-code)
(A01–A32) lists the tests each step must pass. Write them with the step, not
afterwards.

## Working rules

- **One builder per step.** Open a draft PR, or comment on the parent PR,
  before you start a step, so two people do not build the same layer.
- **Refresh source owners first.** The contract pins main
  `988ceaa4d2`. Main has moved since; check the files in
  [contract section 1](pr-b-coordinator-contract.md#current-owners-and-required-additions)
  before relying on them.
- **Do not copy #495's helper code into PR B.** Build on main after #495 merges,
  or stack on #495's exact head.
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
