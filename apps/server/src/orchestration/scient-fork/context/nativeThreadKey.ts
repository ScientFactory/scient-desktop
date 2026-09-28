/**
 * Stable identity of the provider-native conversation a turn is sent to.
 *
 * SCIENT-OWNED. A context handoff is delivered to one provider-native thread.
 * When the provider silently replaces that thread (a resume that falls back to
 * a fresh one, a provider switch, a restart without history), the new thread
 * has not received the context and must get it again. Resume cursors are
 * adapter-private, so the identifying field differs per provider:
 * Codex keeps its app-server thread in `threadId`; Claude's cursor `threadId`
 * is Scient's own thread id and its session lives in `resume`; OpenCode, ACP
 * agents and Pi use `sessionId` (Pi also a session file).
 *
 * `null` means the identity is unknown; callers must not treat two unknowns as
 * different sessions.
 */
import * as Predicate from "effect/Predicate";

const nonEmptyString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

export function nativeThreadKey(
  provider: string,
  resumeCursor: unknown,
  providerInstanceId?: string | null,
): string | null {
  if (!Predicate.isObject(resumeCursor) || Array.isArray(resumeCursor)) return null;
  const cursor = resumeCursor as Record<string, unknown>;
  const identity =
    provider === "codex"
      ? nonEmptyString(cursor.threadId)
      : provider === "claudeAgent"
        ? nonEmptyString(cursor.resume)
        : (nonEmptyString(cursor.sessionId) ?? nonEmptyString(cursor.sessionFile));
  const scope =
    providerInstanceId == null ? provider : `${provider}@${encodeURIComponent(providerInstanceId)}`;
  return identity === undefined ? null : `${scope}:${identity}`;
}
