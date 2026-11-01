/**
 * Context belongs to a provider-native thread and must be redelivered if that identity changes.
 * Prefer live adapter identity; cursor fallbacks differ by provider (Claude uses resume, not its
 * Scient threadId). Neither null nor a Scient thread/process ID proves continuity.
 */
import * as Predicate from "effect/Predicate";

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function nativeThreadKey(
  provider: string,
  resumeCursor: unknown,
  providerInstanceId?: string | null,
  nativeSessionId?: string,
): string | null {
  const cursor =
    Predicate.isObject(resumeCursor) && !Array.isArray(resumeCursor)
      ? (resumeCursor as Record<string, unknown>)
      : {};
  const identity =
    nonEmptyString(nativeSessionId) ??
    (provider === "codex"
      ? nonEmptyString(cursor.threadId)
      : provider === "claudeAgent"
        ? nonEmptyString(cursor.resume)
        : (nonEmptyString(cursor.sessionId) ?? nonEmptyString(cursor.sessionFile)));
  const scope =
    providerInstanceId == null ? provider : `${provider}@${encodeURIComponent(providerInstanceId)}`;
  return identity === undefined ? null : `${scope}:${identity}`;
}
