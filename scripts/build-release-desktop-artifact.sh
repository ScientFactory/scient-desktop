#!/usr/bin/env bash

set -euo pipefail

platform="$1"
target="$2"
arch="$3"
build_version="$4"

args=(
  --platform "$platform"
  --target "$target"
  --arch "$arch"
  --build-version "$build_version"
  --verbose
)

has_all() {
  for value in "$@"; do
    if [[ -z "$value" ]]; then
      return 1
    fi
  done
  return 0
}

has_any() {
  for value in "$@"; do
    if [[ -n "$value" ]]; then
      return 0
    fi
  done
  return 1
}

if [[ "$platform" == "mac" ]]; then
  apple_values=(
    "${CSC_LINK:-}"
    "${CSC_KEY_PASSWORD:-}"
    "${APPLE_API_KEY:-}"
    "${APPLE_API_KEY_ID:-}"
    "${APPLE_API_ISSUER:-}"
  )
  if has_all "${apple_values[@]}"; then
    key_path="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"
    printf '%s' "$APPLE_API_KEY" > "$key_path"
    export APPLE_API_KEY="$key_path"
    echo "macOS signing enabled."
    args+=(--signed)
  elif has_any "${apple_values[@]}"; then
    if [[ "$PUBLISH_RELEASE" == "true" ]]; then
      echo "Public macOS releases cannot use a partial Apple signing configuration." >&2
      exit 1
    fi
    echo "Build-only macOS signing disabled because the Apple signing configuration is incomplete."
  elif [[ "$PUBLISH_RELEASE" == "true" ]]; then
    echo "Public macOS releases require all Apple signing and notarization secrets." >&2
    exit 1
  else
    echo "Build-only macOS signing disabled (missing one or more Apple signing secrets)."
  fi
elif [[ "$platform" == "win" ]]; then
  # Build-only validation may produce an unsigned installer. Public releases
  # fail closed unless exactly one signing provider is complete.
  certificate_values=("${WIN_CSC_LINK:-}" "${WIN_CSC_KEY_PASSWORD:-}")
  azure_values=(
    "${AZURE_TENANT_ID:-}"
    "${AZURE_CLIENT_ID:-}"
    "${AZURE_CLIENT_SECRET:-}"
    "${AZURE_TRUSTED_SIGNING_ENDPOINT:-}"
    "${AZURE_TRUSTED_SIGNING_ACCOUNT_NAME:-}"
    "${AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME:-}"
    "${AZURE_TRUSTED_SIGNING_PUBLISHER_NAME:-}"
  )

  if has_all "${certificate_values[@]}" && ! has_any "${azure_values[@]}"; then
    echo "Windows signing enabled (standard Authenticode certificate)."
    args+=(--signed)
  elif has_all "${azure_values[@]}" && ! has_any "${certificate_values[@]}"; then
    echo "Windows signing enabled (Azure Trusted Signing)."
    args+=(--signed)
  elif has_any "${certificate_values[@]}" || has_any "${azure_values[@]}"; then
    if [[ "$PUBLISH_RELEASE" == "true" ]]; then
      echo "Public Windows releases require exactly one complete signing provider: WIN_CSC_LINK plus WIN_CSC_KEY_PASSWORD, or all Azure Trusted Signing secrets." >&2
      exit 1
    fi
    echo "Build-only Windows signing disabled because the signing configuration is incomplete or conflicting."
  elif [[ "$PUBLISH_RELEASE" == "true" && "$ALLOW_UNSIGNED_RELEASE" == "true" ]]; then
    echo "Unsigned Windows early-access publication explicitly enabled."
  elif [[ "$PUBLISH_RELEASE" == "true" ]]; then
    echo "Public Windows releases require a standard Authenticode certificate or Azure Trusted Signing." >&2
    exit 1
  else
    echo "Build-only Windows signing disabled because no signing provider is configured."
  fi
else
  echo "Signing disabled for $platform."
fi

if [[ "$platform" == "mac" && "$arch" == "x64" ]]; then
  # electron-builder occasionally times out fetching x64 DMG helper bundles on GitHub-hosted macOS runners.
  # Retry this narrow packaging path so transient upstream 504s do not block the whole release.
  max_attempts=3
  for attempt in $(seq 1 "$max_attempts"); do
    if bun run dist:desktop:artifact -- "${args[@]}"; then
      break
    fi

    if [[ "$attempt" -eq "$max_attempts" ]]; then
      echo "macOS x64 desktop artifact build failed after $max_attempts attempts."
      exit 1
    fi

    sleep_seconds=$((attempt * 15))
    echo "macOS x64 desktop artifact build failed on attempt $attempt/$max_attempts. Retrying in ${sleep_seconds}s..."
    sleep "$sleep_seconds"
  done
else
  bun run dist:desktop:artifact -- "${args[@]}"
fi
