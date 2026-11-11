#!/usr/bin/env bash
# Builds apps/web as Scient's hosted app and, with --deploy, publishes it to Cloudflare.
# Public Scient Connect ids come from .env.example; CLOUDFLARE_API_TOKEN and
# CLOUDFLARE_ACCOUNT_ID are needed only to deploy.
set -euo pipefail
cd "$(dirname "$0")/../.."

for name in CLERK_PUBLISHABLE_KEY CLERK_JWT_TEMPLATE CLERK_CLI_OAUTH_CLIENT_ID RELAY_URL; do
  value="$(sed -n "s|^T3CODE_${name}=||p" .env.example)"
  [[ -n "$value" ]] || { echo "Missing T3CODE_${name} in .env.example" >&2; exit 1; }
  export "T3CODE_${name}=${value}"
done
export VITE_HOSTED_APP_URL="https://app.scientfactory.com"
# The stable hosted app is plain "Scient", as T3's hosted build names its own (apps/web/vercel.ts).
export VITE_HOSTED_APP_CHANNEL=latest
# Nothing reads hosted source maps, and they double the upload.
export T3CODE_WEB_SOURCEMAP=false

pnpm exec vp run --filter @t3tools/web build

# Hashed build output never changes under the same name.
cat > apps/web/dist/_headers <<'HEADERS'
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
HEADERS

if [[ "${1:-}" == "--deploy" ]]; then
  pnpm dlx wrangler@4.152.0 deploy --config infra/scient-web/wrangler.jsonc
fi
