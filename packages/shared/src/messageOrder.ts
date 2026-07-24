// FILE: messageOrder.ts
// Purpose: Match the persisted projection order for messages in every runtime.
// Layer: Shared orchestration ordering

/**
 * Projection queries order messages by SQLite's created_at/message_id keys.
 * Keep browser and server command validation on the same deterministic order,
 * including when multiple live events share a timestamp.
 */
export function compareProjectionMessageOrderValues(
  leftCreatedAt: string,
  leftMessageId: string,
  rightCreatedAt: string,
  rightMessageId: string,
): number {
  if (leftCreatedAt < rightCreatedAt) return -1;
  if (leftCreatedAt > rightCreatedAt) return 1;
  if (leftMessageId < rightMessageId) return -1;
  if (leftMessageId > rightMessageId) return 1;
  return 0;
}
