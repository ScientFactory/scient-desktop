# Scient cloud

The Worker behind conversation copies, take-over and shared links. Scient-owned; `infra/relay`
(Scient Connect) is separate and untouched. The API is defined in
`packages/scient-cloud/src/api.ts`.

| Host                                                                        | Serves                                                |
| --------------------------------------------------------------------------- | ----------------------------------------------------- |
| `cloud.scientfactory.com`                                                   | API `/v1/*`                                           |
| `scientfactory.com/s/*` (zone route, wins over the website's custom domain) | share page shell `/s/:id`, its files under `/s/_app/` |
| `share.scientusercontent.com`                                               | `/frame`, the sandboxed frame that renders agent HTML |

## How it works

- **People** send a Clerk session JWT from the relay's `scient-relay` template; it is verified with
  `@clerk/backend` and the audience is checked (`src/ClerkAuth.ts`).
- **Computers** enroll once (nonce → proof signed by the environment's Ed25519 key) and then sign
  every request (`ScientComputer <JWS>` bound to method, path+query, body hash, 300 s, single use).
- **User object** (one SQLite Durable Object per Clerk user, `src/UserStore.ts`): computers, nonces,
  used token ids, the thread index with lease generation and moves, blobs and which threads use
  them, shares owned, quota reservations, usage and a per-user limits override. Every write that
  stores bytes is reserved there first, so quota checks are atomic.
- **Share object** (one per link, `src/ShareStore.ts`): owner, access (`link`, `people`, `me`),
  frozen published versions, objects, reports, and an alarm that ends the link at its expiry.
- **Bucket** (R2): synced copies and files are encrypted at rest with a random per-user data key,
  wrapped by `SCIENT_CLOUD_KEK` (AES-GCM, chunked, bound to the object's key). Shared-link objects
  are stored as received (ciphertext when the link is encrypted).
- A file (`/v1/blobs/:sha256`) is readable only while a stored conversation of the same user names
  it; computers name it with `?env=&thread=` on `HEAD`/`PUT`. Deleting the conversation (or the
  computer) deletes files nothing else uses.
- `GET /v1/threads/:env/:thread` and the lease response return the stored gzip with
  `content-encoding: gzip`; `fetch` hands callers the JSON.

## Run locally

```sh
cd infra/scient-cloud
pnpm run dev                     # http://localhost:8787, data in .scient-cloud-dev/
node scripts/smoke.ts            # end-to-end over HTTP against it
```

`scripts/dev.ts` runs the Worker's own request handler in Node with SQLite files for the Durable
Objects and files for the bucket. API, share page and frame share the port. Sign-in:

- test tokens `Authorization: Bearer dev:<userId>` (or `dev:<userId>:<email>` to be an invited
  person on `people` links), or
- real Clerk session tokens when `CLERK_SECRET_KEY` and `CLERK_JWT_AUDIENCE` are set.

Test sign-in and the fixed test key-encryption key exist only in `scripts/dev.ts` and
`src/Local.ts`; the deployed Worker (`src/worker.ts`) never imports them. Point the desktop
server at the local service with `SCIENT_CLOUD_URL=http://localhost:8787` (exactly that origin:
it is the computer tokens' audience). Localhost browser origins are allowed only here.

The share page app (built by `share/vite.config.ts`) is served from `share/dist` when present.

## Tests

```sh
pnpm run test        # src/Api.test.ts: the HTTP handler against src/Local.ts
pnpm run typecheck
```

They cover sign-in and enrollment, token replay and binding, encrypted storage and unchanged
digests, quota and size limits, `lease_lost` and moves, the blob reference rule, share access,
frozen versions, revoke, expiry, the page shell headers and CORS. Durable Objects run as Node
SQLite (the relay tests its object stores the same way); `alchemy dev` and Workers runtime tests
are not set up.

## Deploy (owner action)

Nothing deploys automatically. Run **Deploy Scient cloud** (`.github/workflows/deploy-scient-cloud.yml`,
manual) after creating the GitHub environment `scient-cloud`:

| Kind     | Name                                                                                                                    | Value                                                                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| secret   | `CLOUDFLARE_API_TOKEN`                                                                                                  | Workers, R2, DNS and Durable Objects on the account and both zones                   |
| secret   | `CLERK_SECRET_KEY`                                                                                                      | the Clerk production secret (same instance as Scient Connect)                        |
| secret   | `SCIENT_CLOUD_KEK`                                                                                                      | 32 random bytes, base64url: `openssl rand 32 \| basenc --base64url \| tr -d =`       |
| secret   | `SCIENT_CLOUD_ADMIN_TOKEN`                                                                                              | optional; enables `PUT /v1/admin/users/:user/limits`                                 |
| variable | `CLOUDFLARE_ACCOUNT_ID`, `CLERK_JWT_AUDIENCE`                                                                           | as for the relay                                                                     |
| variable | `SCIENT_CLOUD_FREE_BYTES`, `SCIENT_CLOUD_MAX_SNAPSHOT_BYTES`, `SCIENT_CLOUD_MAX_BLOB_BYTES`, `SCIENT_CLOUD_MAX_THREADS` | optional limits (defaults 1 GiB, 64 MiB, 25 MiB, 10,000)                             |
| variable | `SCIENT_CLOUD_APP_ORIGINS`                                                                                              | optional; default `https://app.scientfactory.com,scient://app,scient-next-dev://app` |
| variable | `SCIENT_CLOUD_API_HOST`, `SCIENT_CLOUD_PAGE_HOST`, `SCIENT_CLOUD_CONTENT_HOST`                                          | required for any stage other than `prod`                                             |

Before the first deploy: both zones (`scientfactory.com`, `scientusercontent.com`) must be in the
account; add `https://scientfactory.com` to Clerk's allowed origins if the share page signs people
in. **Keep `SCIENT_CLOUD_KEK` safe and never rotate it by replacing it**: every stored copy's data
key is wrapped with it. The bucket is retained if the stack is destroyed.

Per-user limits: `PUT /v1/admin/users/<clerk user id>/limits` with
`Authorization: Bearer <SCIENT_CLOUD_ADMIN_TOKEN>` and a body like `{"freeBytes": 10737418240}`
(or `null` to clear). Without the secret the endpoint answers 404.

## Known limits

- Upload bodies are read into memory (64 MiB conversation cap, Workers' 128 MB memory).
- Reports are stored on the link's object; there is no review screen yet.
- Files referenced only by a conversation that never finished uploading stay until that
  conversation is uploaded and later deleted.
