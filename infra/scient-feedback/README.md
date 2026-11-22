# Scient feedback

The Worker that receives in-app feedback reports (`feedback.scientfactory.com`). Scient-owned,
separate from analytics: reports never reach the analytics database or PostHog. The wire format is
`packages/contracts/src/scient/feedback.ts`; the desktop sender is
`apps/desktop/src/scient/feedback/`.

## How it works

- `POST /v1/reports`: multipart, a `report` JSON part and optional `screenshot` (JPEG), `logs` and
  `conversation` parts, each declared with its byte count in the report. Headers carry the
  installation's random feedback client id and token; the first token seen binds the id (its
  SHA-256 is stored). The report id is made by the app and is the idempotency key: a repeat from
  the same client answers 200 with the first receipt, the same id from another client 409.
- `GET /v1/reports/status?ids=…`: the caller's own reports only (status, `fixedIn`, note). The
  app uses it to say "Fixed in Scient X" once.
- `/v1/admin/*`: list, read, download attachments, update and delete, with
  `Authorization: Bearer <SCIENT_FEEDBACK_ADMIN_TOKEN>`. Without that secret the routes answer 404.
- D1 holds reports and clients (`migrations/`). The private R2 bucket holds attachments under
  `reports/<id>/<kind>`, written before the row so a row never names a missing file. Admin
  downloads are `content-disposition: attachment`, `nosniff`, sandboxed.

## Limits

- A request needs `content-length` and at most 4 MiB; screenshot 2 MiB, logs 256 KiB,
  conversation 1 MiB, message 20,000 characters. Unknown parts and fields are refused, and the
  screenshot must start with a JPEG signature.
- Rate limits per minute: 3 reports per installation, 10 per network address (the address is a
  limiter key only, never stored), 10 status checks per installation. At most 50 reports per
  installation in 24 hours and `SCIENT_FEEDBACK_DAILY_CAP` (default 2,000) per UTC day overall.
- `SCIENT_FEEDBACK_INGESTION_ENABLED=false` pauses intake. 429 and 503 answers carry
  `retry-after`, and the app keeps such reports queued.

## Run locally

```sh
cd infra/scient-feedback
pnpm run dev       # http://127.0.0.1:8790, data in .scient-feedback-dev/, admin token dev-admin
```

Point a development app at it with `SCIENT_FEEDBACK_TEST_ENDPOINT=http://127.0.0.1:8790`
(`pnpm dev:app:start` passes that variable through). Development builds send nowhere without it.

## Triage

```sh
export SCIENT_FEEDBACK_ADMIN_TOKEN=…        # SCIENT_FEEDBACK_URL defaults to production
node infra/scient-feedback/scripts/feedback.ts list --status new
node infra/scient-feedback/scripts/feedback.ts show <id or prefix>
node infra/scient-feedback/scripts/feedback.ts pull ./feedback-inbox --status new
node infra/scient-feedback/scripts/feedback.ts resolve <id> --status fixed --fixed-in 0.6.31 --note "Thanks!"
node infra/scient-feedback/scripts/feedback.ts delete <id>
```

`pull` writes one folder per report with `report.md` and its attachments, for a person or an agent
to turn into fix-inbox entries, idea rows or GitHub issues. The repository is public: an issue never
copies a person's words, screenshot, logs or conversation unless they agreed.
`resolve --status fixed --fixed-in X` makes the reporter's app show a one-time "Fixed in Scient X"
note once it runs X or later.

## Tests

```sh
pnpm run test       # src/Api.test.ts: the handler against src/Local.ts (node:sqlite, memory files)
pnpm run typecheck
```

## Deploy (owner action)

Nothing deploys automatically. Run **Deploy Scient feedback**
(`.github/workflows/deploy-scient-feedback.yml`, manual) after creating the GitHub environment
`scient-feedback`:

| Kind     | Name                                                             | Value                                                    |
| -------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| secret   | `CLOUDFLARE_API_TOKEN`                                           | Workers, D1, R2 and DNS on the account and zone          |
| secret   | `SCIENT_FEEDBACK_ADMIN_TOKEN`                                    | `openssl rand 32 \| basenc --base64url \| tr -d =`       |
| variable | `CLOUDFLARE_ACCOUNT_ID`                                          | as for the relay                                         |
| variable | `SCIENT_FEEDBACK_HOST`                                           | optional; another stage's host, else its workers.dev URL |
| variable | `SCIENT_FEEDBACK_INGESTION_ENABLED`, `SCIENT_FEEDBACK_DAILY_CAP` | optional (`true`, `2000`)                                |

The D1 database and R2 bucket are kept if the stack is destroyed. Until the Worker is live,
release builds keep reports queued for up to 30 days and deliver them once it answers.
