# Step 4: publication

Written October 23, 2026. Refines section 11's step 4. It builds on step 3b ([#630](https://github.com/ScientFactory/scient-desktop/pull/630)): confirm already applies a review and adopts the result. Step 4 makes confirm send the result to Overleaf, and makes prepare and recover settle earlier sends. Routes, sign-in, the token and the server mount are step 5, together with `connect`, `disconnect`, `relink`, token renewal and `cancel`.

## What step 4 delivers

| Where     | Adds                                                                                                                                                           | Never                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `confirm` | After a complete adoption, in the same reservation and application section: gate, verify the folder against the candidate, record the attempt, send, classify. | Send after a partial apply, or resend anything. |
| `prepare` | Before building the review: classify every unresolved attempt against the head it fetches anyway. The review warns about each one still unresolved.            | Send.                                           |
| `recover` | After any local recovery: the same classification, with one fetch.                                                                                             | Send.                                           |
| review    | A warning per unresolved attempt (`unresolved-publication`, with its number and candidate), which the confirmation must acknowledge.                           | Hide an earlier send whose outcome is unknown.  |

Two injected functions, like `fetchRemote` in 3b: `pushRemote({ repo, connection, commit })` returns the repository's `PushOutcome`, and `gitUrl(connection)` (default `https://git.overleaf.com/<project>`) lets tests use a local bare repository. Step 5 supplies the authenticated versions.

## Confirm, after adoption

1. **Gate.** Publish only when the apply's outcome is `complete` and the adopted record has no forced conflicts, no marker paths and no staging paths, and no copy this apply kept is `changed` or `ambiguous` (a late writer may hold newer work). Otherwise the result says `blocked` with the reason. The base stays where adoption put it.
2. **Nothing to send.** When the candidate tree equals the fetched remote tree, the sync was incoming-only: `publication: none`.
3. **Verify.** Capture the folder again, with the adopted managed and local-only paths and staging, and write its tree. It must equal the candidate tree, byte for byte and absence for absence. A difference (an edit since the apply) returns `not-verified`: the edit is a local change for the next review, and nothing is recorded or sent. The pinned candidate is built from the repository's objects, never from the folder after this point.
4. **Commit and record.** Commit the candidate tree with the plan's fetched remote commit as its only parent. Then, in one replacement with pins first (`attempt/<n>/candidate`, `attempt/<n>/parent`), record attempt `n` as `unknown` on the adopted base generation. No send happens unless this write succeeds.
5. **Send admission.** If the credential epoch changed since the review, record `not-sent` with `send-refused` evidence. The checkout cannot change: the section is still held.
6. **Send** once, never forced.
   - `accepted`: one replacement records `accepted` with `push-accepted` evidence and makes the candidate the base (generation + 1).
   - `out-of-date`: record `out-of-date`. The base stays the adopted one, and a new review is needed.
   - `unknown` (network, timeout, unrecognized output): the attempt stays `unknown`.
   - If the finalizing write fails, the durable `unknown` attempt remains for recovery to settle. It is never sent again.
7. **Receipt.** The confirm receipt finishes with the publication category. A repeated request returns it, never another send.

**The section is held through the send.** A pull or branch switch of the checkout waits for the push (bounded by the Git executor's limits). So the checkout the candidate describes cannot change between verification and sending.

## Classification

Classification runs in `prepare` (on the head it fetches) and `recover` (one fetch). It looks at each `unknown` or `superseded-unresolved` attempt, newest first, reusing step 1's positive rules (`probeAcceptance`):

| Evidence                                                                                              | Kind               |
| ----------------------------------------------------------------------------------------------------- | ------------------ |
| The head's tree equals the candidate's tree                                                           | `remote-head-tree` |
| The candidate's tree appears in the head's first-parent history after the parent (at most 64 commits) | `remote-history`   |
| The candidate commit is an ancestor of the head                                                       | `remote-history`   |

The state each attempt ends in:

- **Positive evidence, `unknown`, built on the current base generation:** it becomes `accepted`, and the candidate becomes the base (generation + 1) in the same replacement.
- **Positive evidence, `superseded-unresolved`:** it becomes `accepted`, and the base stays. A later reviewed apply already moved it.
- **No positive evidence:** it stays as it is. This includes a remote equal to the old parent, missing or rewritten history, more than 64 commits, and fetch failure.

An accepted candidate that a collaborator later reverted is found by its history. The revert is then an incoming change, not replayed.

## Results

`OverleafConfirmResult.applied` gains `publication`:

- `none`: incoming-only;
- `blocked` with a reason (`attention`, `markers`, `staging`, `kept-copy-changed`);
- `not-verified`;
- `not-sent`;
- `accepted`;
- `out-of-date`;
- `unknown`.

Every outcome but `none` and `accepted` leaves local changes unsent, and the result says so.

## Tests (service level, real Git, a local bare Overleaf, real applier)

Each test counts pushes through a wrapper on `pushRemote`.

- **A07.** A clean two-way sync publishes the exact reviewed tree on the fetched parent. An incoming-only sync sends nothing.
- **A08.** An edit between apply and verification is `not-verified`, with no push. An edit after verification doesn't change the pushed tree.
- **A09.** Conflict material left in a file blocks publication.
- **A12 and A13.** Accepted, then a crash before finalization: recovery accepts once, and the push count stays one. A collaborator's later revert becomes incoming.
- **A14.** Several cases stay `unknown`: an explicit out-of-date is the only rejection; no evidence, a remote equal to the parent, and history longer than 64 commits all stay `unknown`.
- **A15 and A31.** An unknown attempt, then an acknowledged new sync: the old attempt is superseded with a new attempt number. Its late acceptance never rewinds the newer base.
- **A03.** A duplicate confirm returns the receipt, with the push count at one.
- A changed credential epoch records `not-sent`.
