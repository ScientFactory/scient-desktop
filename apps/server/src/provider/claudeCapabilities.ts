// FILE: claudeCapabilities.ts
// Purpose: Verify Claude account availability through the same SDK initialization used by turns.
// Layer: Provider utility.

import {
  query,
  type Options as ClaudeQueryOptions,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeAccountCapabilities {
  readonly email?: string;
  readonly organization?: string;
  readonly subscriptionType?: string;
  readonly tokenSource?: string;
  readonly apiKeySource?: string;
  readonly apiProvider?: string;
}

interface ClaudeCapabilitiesQuery {
  readonly initializationResult: () => Promise<{
    readonly account?: Record<string, unknown>;
  }>;
  readonly close: () => void;
}

export type ClaudeCapabilitiesQueryFactory = (input: {
  readonly prompt: AsyncIterable<SDKUserMessage>;
  readonly options: ClaudeQueryOptions;
}) => ClaudeCapabilitiesQuery;

export interface ClaudeCapabilitiesProbeInput {
  readonly executable: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly createQuery?: ClaudeCapabilitiesQueryFactory;
}

const DEFAULT_CAPABILITIES_TIMEOUT_MS = 15_000;

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}

async function* neverSendingPrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await waitForAbort(signal);
  if (false) {
    // Keeps the generator correctly typed without ever yielding a user message.
    yield undefined as never;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function nonAbsentString(value: unknown): string | undefined {
  const normalized = nonEmptyString(value);
  if (!normalized) return undefined;
  const absenceMarker = normalized.toLowerCase().replaceAll(/[\s_-]+/g, "");
  return absenceMarker === "none" ||
    absenceMarker === "unknown" ||
    absenceMarker === "notconfigured"
    ? undefined
    : normalized;
}

export function sanitizeClaudeAccountCapabilities(
  account: Record<string, unknown> | undefined,
): ClaudeAccountCapabilities | undefined {
  if (!account) return undefined;
  const email = nonEmptyString(account.email);
  const organization = nonEmptyString(account.organization);
  const subscriptionType = nonAbsentString(account.subscriptionType);
  const tokenSource = nonAbsentString(account.tokenSource);
  const apiKeySource = nonAbsentString(account.apiKeySource);
  const apiProvider = nonEmptyString(account.apiProvider);
  const capabilities: ClaudeAccountCapabilities = {
    ...(email ? { email } : {}),
    ...(organization ? { organization } : {}),
    ...(subscriptionType ? { subscriptionType } : {}),
    ...(tokenSource ? { tokenSource } : {}),
    ...(apiKeySource ? { apiKeySource } : {}),
    ...(apiProvider ? { apiProvider } : {}),
  };
  const hasAuthenticationEvidence =
    email !== undefined ||
    organization !== undefined ||
    subscriptionType !== undefined ||
    tokenSource !== undefined ||
    apiKeySource !== undefined ||
    (apiProvider !== undefined && apiProvider !== "firstParty");
  return hasAuthenticationEvidence ? capabilities : undefined;
}

/**
 * Starts Claude only far enough to receive its local initialization payload.
 * The prompt stream never yields, so this performs no model request. Credentials
 * stay inside Claude; only non-secret account labels are returned.
 */
export async function probeClaudeAccountCapabilities(
  input: ClaudeCapabilitiesProbeInput,
): Promise<ClaudeAccountCapabilities | undefined> {
  const abortController = new AbortController();
  const createQuery: ClaudeCapabilitiesQueryFactory =
    input.createQuery ?? ((queryInput) => query(queryInput) as unknown as ClaudeCapabilitiesQuery);
  let runtime: ClaudeCapabilitiesQuery | undefined;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    runtime = createQuery({
      prompt: neverSendingPrompt(abortController.signal),
      options: {
        pathToClaudeCodeExecutable: input.executable,
        env: input.env,
        persistSession: false,
        settingSources: ["user", "project", "local"],
        allowedTools: [],
        abortController,
        stderr: () => {},
        ...(input.cwd ? { cwd: input.cwd } : {}),
      },
    });

    const timeout = new Promise<undefined>((resolve) => {
      timeoutId = setTimeout(
        () => resolve(undefined),
        input.timeoutMs ?? DEFAULT_CAPABILITIES_TIMEOUT_MS,
      );
    });
    const initialization = await Promise.race([
      runtime.initializationResult().then((result) => result),
      timeout,
    ]);
    return initialization ? sanitizeClaudeAccountCapabilities(initialization.account) : undefined;
  } catch {
    return undefined;
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    abortController.abort();
    try {
      runtime?.close();
    } catch {
      // Probe cleanup is best effort and must not alter the authentication result.
    }
  }
}
