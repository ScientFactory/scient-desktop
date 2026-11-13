/**
 * What each link this person made was published with, kept on this device: the messages left out,
 * the values shown, reasoning, and the content digest of the published copy. An update starts from
 * these, so a message left out once stays out, and the dialog can tell when the link is behind.
 */

const STORAGE_KEY = "scient:cloud-share-selections:v1";

export interface ShareSelection {
  readonly reasoning: boolean;
  readonly excluded: ReadonlyArray<string>;
  readonly keep: ReadonlyArray<string>;
  /** `contentDigest` of the build that was published. */
  readonly contentDigest: string;
}

function isSelection(value: unknown): value is ShareSelection {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const strings = (list: unknown) =>
    Array.isArray(list) && list.every((item) => typeof item === "string");
  return (
    typeof entry.reasoning === "boolean" &&
    strings(entry.excluded) &&
    strings(entry.keep) &&
    typeof entry.contentDigest === "string"
  );
}

function readAll(): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function readShareSelection(shareId: string): ShareSelection | null {
  const entry = readAll()[shareId];
  return isSelection(entry) ? entry : null;
}

export function rememberShareSelection(shareId: string, selection: ShareSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...readAll(), [shareId]: selection }));
  } catch {
    // Storage can be unavailable; the next update then starts from the defaults.
  }
}

export function forgetShareSelection(shareId: string): void {
  const { [shareId]: _removed, ...rest } = readAll();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(rest));
  } catch {
    // Nothing to forget without storage.
  }
}
