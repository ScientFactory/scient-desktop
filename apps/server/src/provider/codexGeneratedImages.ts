import type { ProviderEvent } from "@t3tools/contracts";

export const CODEX_GENERATED_IMAGE_ARTIFACT_KIND = "scient.codex-generated-image" as const;

const GENERATED_IMAGE_ITEM_TYPES = new Set([
  "imagegeneration",
  "imagegenerationcall",
  "imagegenerationend",
]);
const IMAGE_PATH_KEYS = ["saved_path", "savedPath", "path", "file_path"] as const;
const IMAGE_CALL_ID_KEYS = ["call_id", "callId", "item_id", "itemId", "id"] as const;
const PROVIDER_THREAD_ID_KEYS = ["thread_id", "threadId", "threadID", "thread"] as const;
const NESTED_PAYLOAD_KEYS = ["item", "payload", "data", "event", "msg"] as const;

export interface CodexGeneratedImageArtifact {
  readonly kind: typeof CODEX_GENERATED_IMAGE_ARTIFACT_KIND;
  readonly callId?: string;
  readonly providerInstanceId?: string;
  readonly providerThreadId?: string;
  readonly sourcePath?: string;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstString(
  value: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!value) return undefined;
  for (const key of keys) {
    const candidate = nonEmptyString(value[key]);
    if (candidate) return candidate;
  }
  return undefined;
}

function normalizedItemType(value: unknown): string {
  return (nonEmptyString(value) ?? "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1$2")
    .replace(/[._\s/-]+/gu, "")
    .toLowerCase();
}

function isCodexGeneratedImageItem(value: unknown): boolean {
  const item = asObject(value);
  return GENERATED_IMAGE_ITEM_TYPES.has(normalizedItemType(item?.type ?? item?.kind));
}

export function codexGeneratedImageArtifactFromProviderEvent(input: {
  readonly event: ProviderEvent;
  readonly item: unknown;
}): CodexGeneratedImageArtifact | undefined {
  const item = asObject(input.item);
  if (!item || !isCodexGeneratedImageItem(item)) return undefined;
  const payload = asObject(input.event.payload);
  const sourcePath = firstString(item, IMAGE_PATH_KEYS);
  const callId = firstString(item, IMAGE_CALL_ID_KEYS) ?? nonEmptyString(input.event.itemId);
  const providerThreadId =
    firstString(item, PROVIDER_THREAD_ID_KEYS) ?? firstString(payload, PROVIDER_THREAD_ID_KEYS);
  if (!sourcePath && !callId) return undefined;
  return {
    kind: CODEX_GENERATED_IMAGE_ARTIFACT_KIND,
    ...(callId ? { callId } : {}),
    ...(input.event.providerInstanceId
      ? { providerInstanceId: String(input.event.providerInstanceId) }
      : {}),
    ...(providerThreadId ? { providerThreadId } : {}),
    ...(sourcePath ? { sourcePath } : {}),
  };
}

/** Removes inline image bytes while retaining the small recovery metadata. */
export function sanitizeCodexGeneratedImagePayload(value: unknown): unknown {
  const record = asObject(value);
  if (!record) return value;

  let nextRecord = record;
  let changed = false;
  if (isCodexGeneratedImageItem(record) && typeof record.result === "string") {
    const { result: _result, ...withoutResult } = record;
    nextRecord = { ...withoutResult, resultElidedForRelay: true };
    changed = true;
  }

  const nestedChanges: Record<string, unknown> = {};
  for (const key of NESTED_PAYLOAD_KEYS) {
    const nested = nextRecord[key];
    if (!asObject(nested)) continue;
    const sanitized = sanitizeCodexGeneratedImagePayload(nested);
    if (sanitized !== nested) nestedChanges[key] = sanitized;
  }
  if (Object.keys(nestedChanges).length > 0) {
    nextRecord = Object.assign({}, nextRecord, nestedChanges);
    changed = true;
  }
  return changed ? nextRecord : value;
}
