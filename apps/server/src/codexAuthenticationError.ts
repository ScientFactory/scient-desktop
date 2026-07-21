// Purpose: Conservatively identify Codex account-authentication failures.
// Structured app-server error data is authoritative. Generic provider text is
// never sufficient because custom OpenAI-compatible endpoints can also return
// an `Unauthorized` response without invalidating the user's Codex account.

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

export function isCodexAuthenticationError(input: {
  readonly message: string;
  readonly detail?: unknown;
  readonly requiresProviderAccount?: boolean;
}): boolean {
  return (
    input.requiresProviderAccount !== false &&
    structuredCodexErrorInfo(input.detail) === "unauthorized"
  );
}
