import type { ProviderReplayEntry, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

const THREAD_OPENS = new Set(["thread/start", "thread/fork", "thread/resume"]);

const frameOf = (entry: ProviderReplayEntry | undefined) =>
  entry !== undefined && "frame" in entry && Predicate.isObject(entry.frame)
    ? entry.frame
    : undefined;

const outboundMethod = (entry: ProviderReplayEntry | undefined) => {
  const method = entry?.type === "expect_outbound" ? frameOf(entry)?.method : undefined;
  return typeof method === "string" ? method : undefined;
};

/**
 * Adds what imported pre-06eda8e36e/767f194fd9 recordings lack: a `config/read` before each thread
 * start, fork or resume, and a `thread/name/set` (the app thread's title) before a native thread's
 * first turn per app-server, renaming recorded names to the test's titles. Client request ids are
 * translated; other recorded payloads stay unchanged.
 */
export function materializeCodexThreadSetup<T extends ProviderReplayTranscript>(
  transcript: T,
  threadName: (nativeThreadId: string) => string,
): T {
  const source: ReadonlyArray<ProviderReplayEntry> = transcript.entries;
  // Where each addition goes, as recorded entries to insert before an index.
  const before = new Map<number, ReadonlyArray<ProviderReplayEntry>>();
  const add = (index: number, entries: ReadonlyArray<ProviderReplayEntry>) =>
    before.set(index, [...(before.get(index) ?? []), ...entries]);
  let named = new Set<string>();
  let previousOutbound: ProviderReplayEntry | undefined;
  for (const [index, entry] of source.entries()) {
    const method = outboundMethod(entry);
    if (method === undefined) continue;
    const params = frameOf(entry)?.params;
    const threadId = Predicate.isObject(params) ? params.threadId : undefined;
    const cwd = Predicate.isObject(params) ? params.cwd : undefined;
    // A recorded process restart starts a new app-server, which has applied no names.
    if (method === "initialize") named = new Set();
    // Already set up, as by an earlier pass over the same entries.
    if (method === "thread/name/set" && typeof threadId === "string") named.add(threadId);
    if (THREAD_OPENS.has(method) && outboundMethod(previousOutbound) !== "config/read") {
      add(index, [
        {
          type: "expect_outbound",
          label: "thread-setup.config/read",
          frame: {
            id: 0,
            method: "config/read",
            params: {
              ...(typeof cwd === "string" ? { cwd } : {}),
              includeLayers: false,
            },
          },
        },
        {
          type: "emit_inbound",
          label: "thread-setup.config/read:response",
          frame: { id: 0, result: { config: {}, origins: {} } },
        },
      ]);
    }
    if (method === "turn/start" && typeof threadId === "string") {
      const nativeThreadId = threadId;
      if (!named.has(nativeThreadId)) {
        named.add(nativeThreadId);
        // The name is set before the turn's own config read.
        const configRead = source.findLastIndex(
          (candidate, candidateIndex) =>
            candidateIndex < index && outboundMethod(candidate) !== undefined,
        );
        const at = outboundMethod(source[configRead]) === "config/read" ? configRead : index;
        add(at, [
          {
            type: "expect_outbound",
            label: "thread-setup.thread/name/set",
            frame: {
              id: 0,
              method: "thread/name/set",
              params: { threadId: nativeThreadId, name: threadName(nativeThreadId) },
            },
          },
          {
            type: "emit_inbound",
            label: "thread-setup.thread/name/set:response",
            frame: { id: 0, result: {} },
          },
        ]);
      }
    }
    previousOutbound = entry;
  }
  // Client request ids count up from initialize; server requests and their answers keep theirs.
  const entries: ProviderReplayEntry[] = [];
  let nextId = 0;
  let requestIds = new Map<number, number>();
  let insertedId = 0;
  // A recording names its threads after its own titles; the test's threads carry theirs.
  const renamed = (entry: ProviderReplayEntry): ProviderReplayEntry => {
    const frame = frameOf(entry);
    const params = frame?.params;
    if (frame === undefined || !Predicate.isObject(params) || typeof params.threadId !== "string")
      return entry;
    if (entry.type === "expect_outbound" && frame.method === "thread/name/set")
      return {
        ...entry,
        frame: { ...frame, params: { ...params, name: threadName(params.threadId) } },
      };
    if (entry.type === "emit_inbound" && frame.method === "thread/name/updated")
      return {
        ...entry,
        frame: { ...frame, params: { ...params, threadName: threadName(params.threadId) } },
      };
    return entry;
  };
  const translate = (entry: ProviderReplayEntry, inserted: boolean): ProviderReplayEntry => {
    const frame = frameOf(entry);
    if (frame === undefined || typeof frame.id !== "number") return entry;
    if (entry.type === "expect_outbound" && typeof frame.method === "string") {
      if (frame.method === "initialize") {
        nextId = 0;
        requestIds = new Map();
      }
      const id = ++nextId;
      if (inserted) insertedId = id;
      else requestIds.set(frame.id as number, id);
      return id === frame.id ? entry : { ...entry, frame: { ...frame, id } };
    }
    if (entry.type === "emit_inbound" && frame.method === undefined) {
      const id = inserted ? insertedId : (requestIds.get(frame.id as number) ?? frame.id);
      return id === frame.id ? entry : { ...entry, frame: { ...frame, id } };
    }
    return entry;
  };
  for (const [index, entry] of source.entries()) {
    for (const addition of before.get(index) ?? []) entries.push(translate(addition, true));
    entries.push(translate(renamed(entry), false));
  }
  return {
    ...transcript,
    entries: entries as unknown as T["entries"],
    metadata: {
      ...transcript.metadata,
      codexThreadSetup:
        "synthetic upstream config reads and thread names; native payloads preserved; client request ids translated",
    },
  };
}

/**
 * For tests that keep editing a recorded transcript's entries while the replay runs: the replay
 * reads this view, which always shows `entries` with the thread setup above. Edits stay in the
 * recorded shape and must stay after the replay cursor, so the prefix the replay used is unchanged.
 */
export function liveCodexThreadSetup<T extends ProviderReplayTranscript>(
  transcript: T,
  entries: T["entries"],
  threadName: (nativeThreadId: string) => string,
): T["entries"] {
  const current = (): T["entries"] =>
    materializeCodexThreadSetup({ ...transcript, entries }, threadName).entries;
  return new Proxy([] as unknown as T["entries"], {
    get: (_target, key) => {
      const view = current();
      const value = Reflect.get(view, key, view);
      return typeof value === "function" ? value.bind(view) : value;
    },
    has: (_target, key) => Reflect.has(current(), key),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), key);
      // The proxy target's own length stays non-configurable, as the invariant requires.
      return key === "length" && descriptor !== undefined
        ? { ...descriptor, configurable: false }
        : descriptor;
    },
  });
}
