# Scient Cloud: conversation copies, share links and take-over

Scient Cloud is Scient-owned. It is separate from Scient Connect (`infra/relay`), which it does not
change. User-facing behavior is in [Cloud copies and share links](../user/scient-cloud.md); deploying
and running it is in [Scient Cloud operations](../operations/scient-cloud.md).

## Pieces

| Piece               | Where                                                          | Role                                                                                                            |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Contract and crypto | `packages/scient-cloud`                                        | API schemas (`api.ts`), computer JWS (`computerJws.ts`), share crypto, content-frame protocol, limits           |
| Worker              | `infra/scient-cloud`                                           | API on `cloud.scientfactory.com`, share page on `scientfactory.com/s/*`, frame on `share.scientusercontent.com` |
| Desktop server      | `apps/server/src/scient/cloud`                                 | Enrollment, signed client, `CloudSync`, `ShareBuilder` + redaction, lease guard, take-over import               |
| Server contract     | `packages/contracts/src/scientCloud.ts`                        | The `scientCloud` HTTP group the renderer calls on its own computer                                             |
| Renderer            | `apps/web/src/scient/cloud`                                    | `/cloud` reader, share dialog and publishing, settings rows, banners, `SnapshotConversationView`                |
| Public share page   | `infra/scient-cloud/share` → `apps/web/src/scient/cloud/share` | Separate Vite entry (`base: /s/_app/`), decrypts in the browser                                                 |

## One format: the conversation snapshot

Sync, sharing and take-over all move a `ConversationSnapshotV1` (the `.scic` export format,
`packages/contracts/src/scientConversationExport.ts`) captured by `ConversationSnapshotService`.
Orchestration V2 events are pruned to the newest row per thread, so they are not a history to
replay; a settled-thread snapshot is consistent, already redacts Scient paths, carries a
`contentDigest`, and the existing importer can continue it as a new thread with a budgeted handoff.

The uploaded body is gzip of `CloudConversation = {snapshot, sidecar?}`. The sidecar sits beside the
byte-identical snapshot: attachment hashes, per-answer provider and model, repository web URL and
head commit. Attachments go separately as content-addressed blobs (`/v1/blobs/:sha256`), never inside
the record. Handoff records are never uploaded.

## Identity and auth

- **People** call the Worker with a Clerk session JWT from the relay's `scient-relay` template,
  verified with `@clerk/backend` and an audience check.
- **Computers** use the environment's existing Ed25519 key (`apps/server/src/cloud/environmentKeys.ts`).
  Enrollment: the renderer gets a nonce with the person's session, the server signs a proof
  (`typ: scient-cloud-enroll+jwt`, claims `environmentId, sub, nonce, aud`), the renderer posts it to
  `POST /v1/computers`, then the server confirms with a signed call. Every later request carries
  `Authorization: ScientComputer <JWS>` (`typ: scient-cloud+jwt`, `iss: scient-env:<id>`, `sub`, `aud`
  = cloud origin, `exp ≤ iat+300`, single-use `jti`, `htm`, `htu` = path+query, `bsha` = body hash).
  Desktop servers never hold a person's token.
- The server's cloud URL comes from `SCIENT_DESKTOP_IDENTITY.cloudApiUrl`; `SCIENT_CLOUD_URL`
  overrides it for local runs. The renderer uses `VITE_SCIENT_CLOUD_URL`. Development builds can use
  `VITE_SCIENT_CLOUD_DEV_USER` to send `dev:<user>` tokens, which only the local dev server accepts;
  production builds compile that path out.

## Storage and encryption

One SQLite Durable Object per Clerk user holds computers, nonces, used token ids, the thread index
(meta, lease generation, `movedTo`), blobs and which threads use them, owned shares, quota
reservations, usage and a per-user limits override. One Durable Object per share holds access,
versions, objects, reports and the expiry alarm. Bytes live in one R2 bucket.

- **Cloud copies:** each user has a random data key, wrapped by the Worker secret `SCIENT_CLOUD_KEK`
  (AES-GCM, AAD = user id). Objects are encrypted with it in 1 MiB AES-GCM chunks bound to the object
  key. This protects the bucket, not against the service: always described as "stored encrypted with
  a key unique to your account", never end-to-end. Upgrade path: the computer hands the data key to
  the person's browsers over Connect so the service holds only ciphertext; the format stays.
- **Share links:** encrypted in the renderer before upload. Key K = 32 random bytes in the link
  fragment (`/s/<id>#<base64url K>`). Each object (`snapshot`, `meta`, `blob-<sha256>`) is split into
  1 MiB chunks, AES-GCM-256 with `HKDF-SHA256(K, "scient-share/v1/<version>/<object>")`, nonce = 8
  random bytes ‖ 32-bit counter, AAD = object ‖ index ‖ isLast, so truncation, reordering and
  swapping objects fail. The fragment never reaches a server, log, referrer or report. Unencrypted
  links store plaintext plus a sender-chosen card for previews.

## Sync (`CloudSync`)

Domain events mark threads dirty without blocking turns. A worker ticks every 5 s and uploads, one at
a time, listed threads (no side chats or delegated sub-threads) that settled and stayed quiet for
20 s, at most once per 2 min each. An unchanged `contentDigest`, title and archive state is skipped.
Blobs go first (`HEAD` then `PUT`, naming the thread). The setting and enrollment are rechecked before
every request, so turning Cloud copy off ends a batch at the next request. Errors back off from 1 s to
5 min with jitter and `Retry-After`; `quota_exceeded` pauses as "storage full"; 401/403 pause as "not
enrolled". State lives in `<stateDir>/scient/cloud-sync/state.json` (no database migration). Unlinking
Scient Connect turns the setting off (seam in `apps/server/src/cloud/http.ts`).

## Take-over and the lease

A conversation has one owner computer. "Continue on this computer" on B calls
`POST /v1/threads/:env/:thread/lease {to: B}`: the Worker bumps the generation, records `movedTo: B`
and makes B the owner. B's server downloads the copy and its blobs with its own signature and imports
them through `ConversationImportStaging` into the one project whose `repositoryGroupingKeyOf` and
repo-relative path match (otherwise the person picks). The result is a new thread id with a fresh
provider session, `continuedFrom` recorded in sync state (shown as "Continued from <computer>").
Take-overs on one computer are serialized and a repeat for the same source returns the thread
already continued (two windows, retries).

A learns the move from `409 lease_lost` on upload or the 60 s `moved` poll, marks the thread moved and
refuses new provider work on it on the server (`SCIENT-FORK` seams in the Orchestrator at
`dispatchMessage`, `startNextQueuedRun` and queued-message promotion). Notifications and delegated
completions are accepted unchanged so their senders stop retrying. "Take it back" runs the same flow
in reverse. An offline A can only diverge like a fork (two thread ids), never corrupt the copy.

Known limit: a delegated child's completion that arrives after its parent moved is accepted but never
lands in the moved thread; restart recovery may offer it again (also inert).

## Share building and redaction

`ShareBuilder` captures the snapshot with the requested reasoning and work-log choices, drops
excluded messages, and redacts every text field (messages, reasoning, work log, plans, answers,
provenance notices, warnings, sidecar, attachment names and MIME types): exact values from Scient
Accounts (`redactionValues`: saved values and custom-model keys, 6+ characters, with URL-encoded and
base64 forms), token patterns (private keys, JWTs, `sk-`, GitHub, Slack, AWS, Google, Bearer,
credentials in URLs), emails, and home paths. Text attachments with anything redactable are left out
whole unless kept. The result is `documentJson` (the exact bytes to publish) plus a report with
stable per-run ids, never values. Values held only by external password managers are not searched.

## Limits

Worker variables (no app release needed), with a per-user override row: free 1 GiB, 64 MiB per
conversation, 25 MiB per file, 10,000 conversations. Uploads must send `content-length` within the
limit and are read into one bounded buffer; JSON bodies are capped at 64 KiB.

## Seams in upstream files

All marked `SCIENT-FORK:START/END`: settings key `scientCloudSyncEnabled`, the `scientCloud` HTTP
group registration, Orchestrator turn admission, `server.ts` mounting `CloudSyncState`, Connect
unlink, the sidebar entry, thread menu entries, `__root.tsx` hosts, `ChatView.tsx` banners, and the
generated route tree.
