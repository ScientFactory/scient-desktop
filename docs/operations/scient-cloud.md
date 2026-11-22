# Scient Cloud operations

Runbook for the Worker behind cloud copies, share links and take-over (`infra/scient-cloud`). How it
works is in [the internals note](../internals/scient-cloud.md); the
[Worker README](../../infra/scient-cloud/README.md) has the full secrets table and local commands.
Scient Connect (`infra/relay`) is separate and unaffected.

## What runs where

| Piece             | Where                                                  | Notes                                                              |
| ----------------- | ------------------------------------------------------ | ------------------------------------------------------------------ |
| API               | `https://cloud.scientfactory.com/v1/*`                 | Worker custom domain                                               |
| Share page        | `https://scientfactory.com/s/<id>`, files `/s/_app/*`  | Zone route `scientfactory.com/s/*`; wins over the website's domain |
| Untrusted content | `https://share.scientusercontent.com/frame`            | Custom domain; cannot collide with tunnel names `<stage>-<digest>` |
| Data              | One R2 bucket (retained on destroy), Durable Objects   | One user object per Clerk user, one share object per link          |
| Sign-in           | The Clerk instance Scient Connect uses                 | Same `scient-relay` JWT template and audience                      |
| Cloud reader      | `https://app.scientfactory.com/cloud`, the desktop app | Ships with the hosted app and desktop releases                     |

Nothing deploys automatically: the workflow is `workflow_dispatch` only.

## First deploy (owner)

1. Create the GitHub environment `scient-cloud` with the secrets and variables in the
   [Worker README](../../infra/scient-cloud/README.md#deploy-owner-action): `CLOUDFLARE_API_TOKEN`
   (Workers, R2, DNS, Durable Objects on the account and both zones), `CLERK_SECRET_KEY`,
   `SCIENT_CLOUD_KEK`, `CLOUDFLARE_ACCOUNT_ID`, `CLERK_JWT_AUDIENCE`. Generate the KEK once
   (`openssl rand 32 | basenc --base64url | tr -d =`) and keep a copy in the owner's Accounts vault.
2. Check both zones (`scientfactory.com`, `scientusercontent.com`) are in the Cloudflare account. The
   deploy creates the custom domains and the `scientfactory.com/s/*` route; no manual DNS records.
3. Clerk: the share page does not sign people in itself (links for named people send them to
   `app.scientfactory.com/shared/<id>`), so the allowed origins Connect already has are enough.
4. Run **Deploy Scient cloud** with stage `prod`. It builds the share page from `apps/web` and
   deploys the stack.
5. Check: `curl https://cloud.scientfactory.com/v1/limits` returns the limits;
   `https://scientfactory.com/s/x` returns the "link has ended" page with `x-robots-tag: noindex`;
   `https://share.scientusercontent.com/frame` returns the frame with its sandbox CSP.
6. Deploy the hosted app from a build that includes the cloud reader so `/cloud` and `/shared/<id>`
   exist there (see [Scient Connect operations](./scient-connect.md#deploying)).
7. Turn the features on: set `scientCloudLive` to `true` in
   `packages/shared/src/scientDesktopIdentity.ts` and release. Until then the app hides Sync, Share
   link and Continue on this computer; a build with `VITE_SCIENT_CLOUD_URL` set shows them for
   testing against a staging or local service.

Before shipping to users, update the website's privacy and terms pages for cloud copies and public
share links. Cloud copy stays off until each person turns it on.

To try a non-production stage, set `SCIENT_CLOUD_API_HOST`, `SCIENT_CLOUD_PAGE_HOST` and
`SCIENT_CLOUD_CONTENT_HOST`; any stage other than `prod` refuses to deploy without them.

## Limits and storage

Defaults: 1 GiB free per person, 64 MiB per conversation, 25 MiB per file, 10,000 conversations.
Change them with the `SCIENT_CLOUD_*` variables and redeploy; no app release is needed. One person's
limits: `PUT /v1/admin/users/<clerk user id>/limits` with `Authorization: Bearer
<SCIENT_CLOUD_ADMIN_TOKEN>` (the endpoint answers 404 when that secret is unset). There is no billing
yet.

## Key-encryption key

Every person's data key is wrapped with `SCIENT_CLOUD_KEK`. Replacing the secret makes every stored
copy unreadable, so **never change it in place**. Rotation is not implemented yet. It needs a release
that reads both a previous and a current KEK, re-wraps each user's data key on first use (and in a
sweep), and only then retires the previous one. Objects themselves do not need re-encrypting.

If the KEK leaks, the bucket's contents are exposed to whoever also has bucket access; rotate as above
and review R2 access tokens.

## Abuse and reports

Readers can report a link (`POST /v1/public/shares/<id>/report`); reports are stored on the link's
object, up to 100 per link. There is no review screen and no operator takedown endpoint yet; only the
link's owner can stop sharing. Both are needed before share links are promoted publicly.

## Local runs

`pnpm run dev` in `infra/scient-cloud` serves everything on `http://localhost:8787` with a fixed
test KEK and `dev:<user>` test tokens. Point desktop servers at it with
`SCIENT_CLOUD_URL=http://localhost:8787` and the web dev server with
`VITE_SCIENT_CLOUD_URL=http://localhost:8787` plus `VITE_SCIENT_CLOUD_DEV_USER=<user>` for a test
account. Build the share page first (`vp build --config ../../infra/scient-cloud/share/vite.config.ts`
in `apps/web`) to serve it at `/s/<id>`.
