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
| Sign-in    | Clerk app "Scient", development instance `live-osprey-129`                     | Google, Microsoft, GitHub, email                                                                |
| Logs       | Axiom org `scientfactory-mmof`, US East                                        | Datasets `t3-code-relay-traces-prod`, `t3-code-mobile-logs-prod`, `t3-code-mobile-metrics-prod` |

Cloudflare account `7335fe148c17fc00c2e9cd48fc9162c6` holds the relay, tunnels, both zones, the
hosted app, and Alchemy's state store (`alchemy-state-store` Worker with its Secrets Store).

Public ids live in `.env.example` (clients) and in the `scient-connect` GitHub environment
(deploys). Secrets are in the owner's Scient Accounts vault and in that environment's secrets:
`CLOUDFLARE_API_TOKEN`, `PLANETSCALE_API_TOKEN_ID`, `PLANETSCALE_API_TOKEN`, `AXIOM_TOKEN`,
`CLERK_SECRET_KEY`. Never put a secret in `.env.example` or a client build.

## Deploying

- **Relay:** `.github/workflows/deploy-relay.yml` runs `alchemy deploy --stage prod` on every push
  to `main`, in the `scient-connect` environment (main and `v*` tags only, no approval step).
  Alchemy changes only what differs, so most runs are no-ops. Run it by hand from **Actions** to
  apply a changed variable.
- **Hosted app:** `.github/workflows/deploy-hosted-web.yml` builds and deploys
  `infra/scient-web/build.sh --deploy` when a stable release is published, so the hosted client
  matches the servers people run. Dispatch it with a ref to redeploy.
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

The development instance has these settings (dashboard **Native applications** and the Backend
API):

- Redirect URLs `scient://app/` and `scient-next-dev://app/`; `allowed_origins`
  `scient://app`, `scient-next-dev://app`, `https://app.scientfactory.com`.
- JWT template `scient-relay` with `{"aud": "scient-connect-relay"}`.
- OAuth application "Scient CLI": public, PKCE, redirect `http://127.0.0.1:34338/callback`,
  scopes `openid profile email offline_access`, device authorization grant on.

The development instance caps the app at 100 users, shows a "Development mode" badge, and uses
Clerk's shared Google, Microsoft and GitHub credentials. Before a public launch, create the
production instance on `scientfactory.com` with Scient's own OAuth apps, repeat the settings
above, and put its `pk_live_` key in `.env.example` and the `scient-connect` environment.

## Alerts

The relay creates its Axiom monitors and health dashboard only when `RELAY_ALERT_NOTIFIER_ID` is
set. The free Axiom plan allows 3 monitors and the relay defines 15, so the variable stays unset
until the org moves to Axiom Cloud. The email notifiers exist already: alerts
`eIxJI9kHKNNauiewYh`, warnings `VtZtPzOCgWVaX32B4p`.

## Not yet on

- The phone app: `SCIENT_DESKTOP_IDENTITY.mobileAppEnabled` hides phone offers, and the relay runs
  with `APNS_ENABLED=false` and no FCM account.
- T3 Chat links: the relay has no `T3CHAT_LINK_SECRET`, so clients hide T3 Chat plans.
- Relay client tracing from the apps follows `outboundTelemetryEnabled`, which is off.
