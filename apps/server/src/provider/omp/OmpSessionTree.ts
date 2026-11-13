/**
 * Scient Agent keeps each conversation as a tree of entries. Each turn records the entry of the
 * message that started it, so rewinding can branch the conversation to just before that message.
 */
import * as Effect from "effect/Effect";
import type { OmpRpcClient } from "effect-omp-rpc/client";

interface Entry {
  readonly id: string;
  readonly parentId: string | null;
  readonly userMessage: boolean;
  readonly time: number;
}

interface Listing {
  readonly entries: ReadonlyMap<string, Entry>;
  readonly leafId: string | null;
}

type Command = OmpRpcClient["command"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const decodeListing = (data: unknown): Listing | undefined => {
  if (!isRecord(data) || !Array.isArray(data.entries)) return undefined;
  const leafId = typeof data.leafId === "string" ? data.leafId : null;
  const entries = new Map<string, Entry>();
  for (const value of data.entries) {
    if (!isRecord(value) || typeof value.id !== "string") continue;
    entries.set(value.id, {
      id: value.id,
      parentId: typeof value.parentId === "string" ? value.parentId : null,
      userMessage:
        value.type === "message" && isRecord(value.message) && value.message.role === "user",
      time: typeof value.timestamp === "string" ? Date.parse(value.timestamp) : Number.NaN,
    });
  }
  return { entries, leafId };
};

/**
 * The first user message the turn put on the active branch: walk back from the leaf, through
 * what the listing holds, to the earliest user message written since the turn started.
 */
const turnStartEntry = (listing: Listing, startedAt: number): string | undefined => {
  let found: string | undefined;
  const seen = new Set<string>();
  for (
    let entry = listing.leafId === null ? undefined : listing.entries.get(listing.leafId);
    entry !== undefined && !seen.has(entry.id);
    entry = entry.parentId === null ? undefined : listing.entries.get(entry.parentId)
  ) {
    seen.add(entry.id);
    if (!(entry.time >= startedAt)) break;
    if (entry.userMessage) found = entry.id;
  }
  return found;
};

/** One session's reader. It asks only for entries since the last leaf it saw. */
export class OmpSessionTree {
  private leaf: string | null | undefined;
  private file: string | undefined;

  /** The listing starts over: a new or switched conversation. */
  reset(sessionFile?: string) {
    this.file = sessionFile;
    this.leaf = undefined;
  }

  /** Undefined when the agent could not say, or the turn added no message of the user's. */
  readonly turnStart = (
    command: Command,
    sessionFile: string | undefined,
    startedAt: number,
  ): Effect.Effect<string | undefined> => {
    if (sessionFile !== this.file) this.reset(sessionFile);
    const since = this.leaf ?? undefined;
    const read = (cursor: string | undefined) =>
      command({ type: "get_entries", ...(cursor === undefined ? {} : { since: cursor }) }).pipe(
        Effect.map((response) => decodeListing(response.data)),
      );
    return read(since).pipe(
      // An unknown cursor (another writer rewound the file) needs the whole tree.
      Effect.catch(() => (since === undefined ? Effect.undefined : read(undefined))),
      Effect.map((listing) => {
        if (listing === undefined) {
          this.leaf = undefined;
          return undefined;
        }
        this.leaf = listing.leafId;
        return turnStartEntry(listing, startedAt);
      }),
      Effect.orElseSucceed(() => undefined),
    );
  };
}

/** Moves the conversation into a new session file that ends just before `entryId`. */
export const branchBefore = (command: Command, entryId: string) =>
  command({ type: "branch", entryId }).pipe(
    Effect.map((response) => isRecord(response.data) && response.data.cancelled === true),
  );
