/**
 * Keys of the encrypted links this person made, kept on this device only: the cloud never holds
 * them, so Copy link works here and nowhere else.
 */

const STORAGE_KEY = "scient:cloud-share-keys:v1";

function readAll(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function readShareKey(shareId: string): string | null {
  const key = readAll()[shareId];
  return typeof key === "string" ? key : null;
}

export function rememberShareKey(shareId: string, key: string): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [shareId]: key }));
  } catch {
    // Storage can be unavailable; the link still works where it was copied.
  }
}

export function forgetShareKey(shareId: string): void {
  const { [shareId]: _removed, ...rest } = readAll();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // Nothing to forget without storage.
  }
}
