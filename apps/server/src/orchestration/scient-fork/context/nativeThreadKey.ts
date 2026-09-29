/**
 * Stable identity of the provider-native conversation a turn is sent to.
 *
 * SCIENT-OWNED. A context handoff is delivered to one provider-native thread.
 * When the provider silently replaces that thread (a resume that falls back to
 * a fresh one, a provider switch, a restart without history), the new thread
 * has not received the context and must get it again. Resume cursors are
 * adapter-private, so the fallback identifying field differs per provider:
 * Codex keeps its app-server thread in `threadId`; Claude's cursor `threadId`
 * is Scient's own thread id and its session lives in `resume`; OpenCode, ACP
 * agents and Pi use `sessionId` (Pi also a session file).
 *
 * Prefer the adapter's live native identity when it is available before a
 * resumable transcript. This is the same identity the eventual cursor carries,
 * never a Scient thread ID or a process ID. `null` cannot prove continuity.
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
