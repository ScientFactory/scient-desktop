import { sha256 } from "@noble/hashes/sha2";
import { randomUUID } from "../../lib/utils";
import type { OrchestrationMessageContext } from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

/** Queue context support is independent of immediate-turn context support. */
export function prepareQueueMessage(
  text: string,
  context: OrchestrationMessageContext | undefined,
  supportsContext: boolean,
): { text: string; context?: OrchestrationMessageContext } {
  if (!context) return { text };
  return supportsContext
    ? { text, context }
    : { text: serializeLegacyContextMessage({ text, records: context.records }) };
}

/** Keep the same SHA-256 identity on HTTPS, localhost, and plain HTTP. */
async function payloadFingerprint(payload: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const digest = globalThis.crypto?.subtle
    ? new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    : sha256(bytes);
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A lost enqueue response must not turn Retry into another queued message. */
export async function queueSubmissionId(targetKey: string, payload: unknown): Promise<string> {
  const fingerprint = await payloadFingerprint(payload);
  const key = `scient-queue-submission:${targetKey}`;
  const previous = localStorage.getItem(key);
  if (previous) {
    const saved = JSON.parse(previous) as { fingerprint: string; id: string };
    if (saved.fingerprint === fingerprint) return saved.id;
  }
  const id = `qitem_${randomUUID()}`;
  localStorage.setItem(key, JSON.stringify({ id, fingerprint }));
  return id;
}
export function acknowledgeQueueSubmission(targetKey: string, id: string) {
  const key = `scient-queue-submission:${targetKey}`;
  const current = localStorage.getItem(key);
  if (current && (JSON.parse(current) as { id: string }).id === id) localStorage.removeItem(key);
}
