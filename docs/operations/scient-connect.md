# Scient Connect operations

Scient Connect is T3 Connect run by Scient: the relay in `infra/relay`, Clerk sign-in, Cloudflare
tunnels, and the hosted app. This page is the Scient runbook. The inherited
[Connect setup reference](./connect-setup.md), [architecture note](../internals/t3-connect.md) and
[relay README](../../infra/relay/README.md) explain how the pieces work.

## What runs where

| Piece      | Where                                                                          | Notes                                                                                           |
| ---------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| Relay API  | `https://relay.scientfactory.com`                                              | Cloudflare Worker, Alchemy stage `prod`, placed in `aws:us-east-1`                              |
| Database   | PlanetScale org `scient`, Postgres `t3coderelay`, `us-east`, PS-5, no replicas | Reached through Cloudflare Hyperdrive                                                           |
| Tunnels    | `<stage>-<digest>.scientusercontent.com`                                       | One Cloudflare tunnel per linked computer                                                       |
| Hosted app | `https://app.scientfactory.com`                                                | Worker `scient-hosted-web`, static assets from `apps/web`                                       |
| Sign-in    | Clerk app "Scient", production instance on `clerk.scientfactory.com`           | Google, Microsoft, GitHub, email                                                                |
| Logs       | Axiom org `scientfactory-mmof`, US East                                        | Datasets `t3-code-relay-traces-prod`, `t3-code-mobile-logs-prod`, `t3-code-mobile-metrics-prod` |

Cloudflare account `7335fe148c17fc00c2e9cd48fc9162c6` holds the relay, tunnels, both zones, the
hosted app, and Alchemy's state store (`alchemy-state-store` Worker with its Secrets Store).

Public ids live in `.env.example` (clients) and in the `scient-connect` GitHub environment
(deploys). Secrets are in the owner's Scient Accounts vault and in that environment's secrets:
`CLOUDFLARE_API_TOKEN`, `PLANETSCALE_API_TOKEN_ID`, `PLANETSCALE_API_TOKEN`, `AXIOM_TOKEN`,
`CLERK_SECRET_KEY`, `CLERK_LEGACY_SECRET_KEY`. Never put a secret in `.env.example` or a client
build.

## Deploying

- **Relay:** `.github/workflows/deploy-relay.yml` runs `alchemy deploy --stage prod` on every push
  to `main`, in the `scient-connect` environment (main and `v*` tags only, no approval step).
  Alchemy changes only what differs, so most runs are no-ops. Run it by hand from **Actions** to
  apply a changed variable.
- **Hosted app:** after each stable publish, `release.yml` dispatches
  `.github/workflows/deploy-hosted-web.yml` on the release tag, which runs
  `infra/scient-web/build.sh --deploy`, so the hosted client matches the servers people run. To
  redeploy, run that workflow from **Actions** on a `v*` tag or `main`; the environment admits no
  other ref.
- **Desktop and server builds** read the four public values from `.env.example` in
  `release.yml`. Changing Clerk or the relay URL means editing `.env.example` and releasing.

To deploy the relay from a computer, export the variables and secrets above plus
`APNS_ENABLED=false`, then from `infra/relay` run `npx alchemy deploy --stage prod`. Set
`T3CODE_RELAY_CLIENT_CONFIG_ENV` to a file outside the repository, or the deploy rewrites the
repository-root `.env`.

## Limits

Each account can hold `RELAY_DEFAULT_TUNNEL_LIMIT` computers at once (3 today). Change the
variable in the `scient-connect` environment and rerun the relay deploy; apps show the new cap
without an app release. For one account, add a row to `relay_managed_tunnel_limits`
(`user_id` is the Clerk user id, `max_tunnels` replaces the default) in the PlanetScale console.

Idle tunnels are deleted by the relay's reaper (`RELAY_TUNNEL_CLEANUP_MODE=enabled`) and come back
at the same address when the computer returns. Cloudflare charges per tunnel above 1,000 per
account, whether or not it is connected.

## Clerk

The production instance serves `clerk.scientfactory.com` (Frontend API) and
`accounts.scientfactory.com`; its DNS records are DNS-only CNAMEs in the `scientfactory.com` zone.
Its settings (dashboard **Native applications** and the Backend API):

- Redirect URLs `scient://app/`, `scient-next-dev://app/`,
  `http://127.0.0.1:34339/clerk/callback` and `http://127.0.0.1:34340/clerk/callback` (the
  desktop's local return page, release and development); `allowed_origins` `scient://app`,
  `scient-next-dev://app`, `https://app.scientfactory.com`.
- JWT template `scient-relay` with `{"aud": "scient-connect-relay"}`.
- OAuth application "Scient CLI": public, PKCE, redirect `http://127.0.0.1:34338/callback`,
  scopes `openid profile email offline_access`, device authorization grant on.
- Support email `support@scientfactory.com`, a Google Workspace group that accepts outside mail.

Scient owns the sign-in apps behind the social buttons; each uses the redirect
`https://clerk.scientfactory.com/v1/oauth_callback`:

| Provider  | App                                                                                       | Owner account / notes                                 |
| --------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Google    | Google Cloud project `scient-514315`, web client "Scient sign-in (Clerk)", in production  | `yaacov@scientfactory.com`                            |
| GitHub    | OAuth app "Scient" (4008855) in the ScientFactory organization                            | Organization owners                                   |
| Microsoft | Entra app "Scient" `2156acfa-475a-4c73-a87d-dd62ecb3a11d`, any tenant + personal accounts | `yaacov@scientfactory.com`; secret expires 2028-11-09 |

Rotate the Microsoft secret before it expires: add a new one in Entra **Certificates & secrets**,
paste it into Clerk's Microsoft connection, then delete the old one. Microsoft shows the app as
unverified until publisher verification; some organizations block users from approving such apps.

The old development instance `live-osprey-129` stays for local testing only; release builds use
the production key in `.env.example`.

Builds up to v0.6.28 still sign in with the development instance, so the relay accepts its tokens
too while they update (`infra/relay/src/auth/ClerkInstances.ts`). Session tokens go to the instance
named in their issuer; command-line OAuth tokens try production, then development. The
`scient-connect` environment holds the development instance's publishable key as the
`CLERK_LEGACY_PUBLISHABLE_KEY` variable and its secret key as `CLERK_LEGACY_SECRET_KEY`. To end the
transition, delete both and redeploy; old builds' Connect then stops working. Accounts are separate
per instance: a person who signed in on both has two relay accounts, and computers linked under one
don't appear under the other.

## Alerts

The relay creates its Axiom monitors and health dashboard only when `RELAY_ALERT_NOTIFIER_ID` is
set. The free Axiom plan allows 3 monitors and the relay defines 15, so the variable stays unset
until the org moves to Axiom Cloud. The email notifiers exist already: alerts
`eIxJI9kHKNNauiewYh`, warnings `VtZtPzOCgWVaX32B4p`.

## Aligning with T3

Scient Connect is T3 Connect with Scient's names and settings, so T3's Connect improvements arrive
in ordinary alignments. Review the Connect `SCIENT-FORK` regions in `infra/relay`, `apps/desktop`,
`apps/web`, `apps/server`, `packages` and `.github/workflows` (including `release.yml`), and the
public build settings in `.env.example`. The hosted-app workflow (`deploy-hosted-web.yml`) and
`infra/scient-web` are Scient's own.

Merging to `main` deploys the relay and applies its migrations to the live database. When an
alignment changes `infra/relay`:

- Read each new migration in `infra/relay/migrations/postgres`. Stop for a decision if one drops or
  rewrites existing data.
- Before merging, add any new relay variable or secret to the `scient-connect` environment and
  `deploy-relay.yml`.
- Keep T3-only services (T3 Chat, phone notifications) off unless the owner turns them on.
- After merging, check the **Deploy Scient Connect relay** run and
  `https://relay.scientfactory.com/health`.

## Not yet on

- The phone app: `SCIENT_DESKTOP_IDENTITY.mobileAppEnabled` hides phone offers, and the relay runs
  with `APNS_ENABLED=false` and no FCM account.
- T3 Chat links: the relay has no `T3CHAT_LINK_SECRET`, so clients hide T3 Chat plans.
- Relay client tracing from the apps follows `outboundTelemetryEnabled`, which is off.
