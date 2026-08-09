export interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
}

const EXTERNAL_CLAUDE_ACCOUNT_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
const EXTERNAL_CLAUDE_BACKEND_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

function environmentValue(environment: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = environment[key]?.trim();
  return value ? value : undefined;
}

/** Whether provider configuration intentionally replaces first-party Claude account sign-in. */
export function hasExternalClaudeAccountConfiguration(environment: NodeJS.ProcessEnv): boolean {
  if (EXTERNAL_CLAUDE_ACCOUNT_KEYS.some((key) => environmentValue(environment, key))) {
    return true;
  }
  return EXTERNAL_CLAUDE_BACKEND_FLAGS.some((key) => {
    const value = environmentValue(environment, key)?.toLowerCase();
    return value !== undefined && !["0", "false", "no", "off"].includes(value);
  });
}

/** Decode the machine-readable result of `claude auth status --json`. */
export function decodeClaudeAuthStatus(output: string): ClaudeAuthStatus | undefined {
  try {
    const value = JSON.parse(output) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const loggedIn = (value as Record<string, unknown>).loggedIn;
    return typeof loggedIn === "boolean" ? { loggedIn } : undefined;
  } catch {
    return undefined;
  }
}
