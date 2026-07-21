// Purpose: Conservatively identify Codex account-authentication failures.
// Structured app-server error data is authoritative. Text matching only
// supports older Codex builds that did not expose `codexErrorInfo`.

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function structuredCodexErrorInfo(detail: unknown): unknown {
  const root = asObject(detail);
  const error = asObject(root?.error);
  return error?.codexErrorInfo ?? root?.codexErrorInfo;
}

const LEGACY_AUTHENTICATION_FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /\bauthentication required\b/iu,
  /\b(?:not|no longer) (?:signed|logged) in\b/iu,
  /\bplease (?:sign|log) in(?: again)?\b/iu,
  /\brun [`'"]?codex login\b/iu,
  /\binvalid_grant\b/iu,
  /\brefresh token\b.{0,80}\b(?:expired|invalid|revoked|failed|rejected)\b/iu,
  /^unauthorized(?:[.:]\s*.*)?$/iu,
];

export function isCodexAuthenticationError(input: {
  readonly message: string;
  readonly detail?: unknown;
}): boolean {
  if (structuredCodexErrorInfo(input.detail) === "unauthorized") {
    return true;
  }

  return LEGACY_AUTHENTICATION_FAILURE_PATTERNS.some((pattern) => pattern.test(input.message));
}
