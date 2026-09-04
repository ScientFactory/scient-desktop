import { randomUUID } from "../../lib/utils";
/** A lost enqueue response must not turn Retry into another queued message. */
export async function queueSubmissionId(targetKey: string, payload: unknown): Promise<string> {
  const fingerprint = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload))),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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
