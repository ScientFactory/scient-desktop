# Step 3b: local apply, recovery and adoption

Written October 22, 2026. Refines section 11's step 3 for the coordinator's local half. The barrier is step 3a ([#626](https://github.com/ScientFactory/scient-desktop/pull/626)); resumable applier steps are [#624](https://github.com/ScientFactory/scient-desktop/pull/624). Publication (verify, attempt, push) is step 4; routes, sign-in and the server mount are step 5.

## What 3b delivers

One service, `OverleafCoordinator`, unmounted, with four operations and one settler:

| Operation | Does                                                                                                                                                                                                                                               | Never                                              |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `prepare` | Under the connection's reservation: recover a pending apply first (barrier application section), then fetch Overleaf's head (an injected function; step 4 supplies the real one), capture the folder, build the review, offer it.                  | Write the folder (beyond recovery) or send.        |
| `confirm` | Take the review once; fetch again; inside an application section re-capture and rebuild the review and refuse a stale one (offering the fresh review); record a local snapshot, pin the intent, link the apply, run the applier, adopt its result. | Publish. Step 4 continues from the adopted result. |
| `recover` | Resume the linked apply by its ID, without a plan, and adopt.                                                                                                                                                                                      | Fetch or send.                                     |
| `status`  | Connection availability from the document plus the live reservation and barrier.                                                                                                                                                                   | Write anything.                                    |
| settler   | Registered with the barrier: a bulk change of a checkout whose connection has a linked apply recovers it inline when the reservation is free; otherwise it refuses (`CheckoutRecoveryRequiredError`).                                              | Wait for a reservation.                            |

Retained compare and restore are 3c, a separate PR on top.

## Rules

- **Lock order.** The operation reservation comes first; it's in memory, per connection, non-queuing, and a competitor gets `operation_active`. Then the barrier's application section, then the store's compare-and-set, then the file layer's own locks. Network fetches happen before the section is taken, never inside it.
- **Staleness.** The confirm re-checks several things: the checkout epoch from the section, the connection revision, the base, the folder identity and the retention identity. It also captures the folder again and rebuilds the review with the review's own selections and choices. A different digest returns the fresh review with the reason from `overleafReviewStaleness`, and nothing is applied.
- **Retention.** `prepareRetention` re-verifies the vault identity before every apply and recovery. The applier's `applicationDirectory` is `<vault>/applies`.
- **Order of durable records before the applier runs.** Each must succeed before the next:
  1. the confirm receipt;
  2. a local snapshot (`local/<n>/tree` ref, then the document);
  3. the intent pin (`apply/<id>/target`);
  4. `activeApply` in the document.

  A crash in between leaves orphan refs, which are harmless.

- **Adoption is one document replacement.** It changes:
  - the base: tree written from the applier's per-path base, commit set to the fetched remote commit, generation + 1, the old base moved into `priorBases` (newest first, at most 20), each with pins;
  - `managedPaths`: the candidate's paths, plus captured paths of units that didn't complete;
  - `localOnlyPaths`, extended with the review's new local-only paths;
  - forced conflicts: the interrupted groups;
  - marker paths still holding conflict material;
  - retained copies: one per kept file, `releasable` when unchanged, otherwise `changed` or `interrupted`;
  - `completedSyncCount`, which advances only when the outcome is `complete`;
  - unknown publication attempts, which become `superseded-unresolved` when the base moves;
  - `activeApply`, cleared.

  The applier's record is idempotent, so a crash before adoption replays it and adopts once; the base never advances twice.

- **Replan.** An applier `replan` (stale capture, nothing written) clears the link without moving the base and returns `replan`.
- **Schema.** `attentionPaths` becomes two fields, `forcedConflicts` (groups) and `markerPaths`. They feed the next review's `interrupted` and `markerPaths`. Nothing is stored in production yet, so schema version 1 stays.
- **Repository.** `<stateDir>/overleaf/repositories/<connectionId>.git`, created on first use with `initialize`.

## Tests (service level, real files, fake remote)

- Clean incoming-only and two-way confirm.
- A stale confirm for each reason.
- `operation_active`.
- A crash at each durable step before and after the applier (child process), each recovered once with no double base advance.
- A bulk change during an apply waits.
- A bulk change with a pending apply recovers it inline, or refuses when the reservation is held.
- A replan.
- An interrupted unit becomes a forced conflict in the next review.
- Retained copies recorded.
