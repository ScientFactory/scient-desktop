// @effect-diagnostics nodeBuiltinImport:off -- Read-only compatibility reader for v1 JSON queue files.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import {
  SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD,
  SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD,
  ScientThreadQueueItem,
  ThreadId,
  type ScientThreadQueueSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const LegacyQueue = Schema.Struct({
  formatVersion: Schema.Literal(1),
  threadId: ThreadId,
  items: Schema.Array(ScientThreadQueueItem).check(
    Schema.isMaxLength(SCIENT_THREAD_QUEUE_MAX_ITEMS_PER_THREAD),
  ),
});
const decode = Schema.decodeUnknownSync(Schema.fromJsonString(LegacyQueue));
const directory = (stateDir: string) => NodePath.join(stateDir, "scient", "thread-queue");
export function legacyQueueFilePath(stateDir: string, threadId: ThreadId) {
  return NodePath.join(
    directory(stateDir),
    `${NodeCrypto.createHash("sha256").update(threadId).digest("hex")}.json`,
  );
}
async function read(filePath: string): Promise<ScientThreadQueueSnapshot | null> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(filePath, "utf8");
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return null;
    throw cause;
  }
  if (Buffer.byteLength(raw, "utf8") > SCIENT_THREAD_QUEUE_MAX_BYTES_PER_THREAD)
    throw new Error("The saved queue exceeds the queue size limit. Its source file has been kept.");
  const parsed = decode(raw);
  if (new Set(parsed.items.map((item) => item.queueItemId)).size !== parsed.items.length)
    throw new Error(
      "The saved queue contains duplicate message IDs. Its source file has been kept.",
    );
  return { threadId: parsed.threadId, items: parsed.items };
}
/** Read only: SQL records the import receipt, and source files remain available for recovery. */
export async function listScientThreadQueue(input: {
  stateDir: string;
  threadId: ThreadId;
}): Promise<ScientThreadQueueSnapshot> {
  const hashed = await read(legacyQueueFilePath(input.stateDir, input.threadId));
  const old =
    hashed ??
    (/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(input.threadId)
      ? await read(NodePath.join(directory(input.stateDir), `${input.threadId}.json`))
      : null);
  if (old && old.threadId !== input.threadId)
    throw new Error("The saved queue belongs to another thread. Its source file has been kept.");
  return old ?? { threadId: input.threadId, items: [] };
}
export async function discoverLegacyQueueThreads(stateDir: string): Promise<ThreadId[]> {
  let files: string[];
  try {
    files = await NodeFSP.readdir(directory(stateDir));
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return [];
    throw cause;
  }
  const ids = new Set<ThreadId>();
  for (const filename of files) {
    if (!filename.endsWith(".json")) continue;
    try {
      const doc = await read(NodePath.join(directory(stateDir), filename));
      if (
        doc &&
        (filename === NodePath.basename(legacyQueueFilePath(stateDir, doc.threadId)) ||
          filename === `${doc.threadId}.json`)
      )
        ids.add(doc.threadId);
    } catch {
      /* An unreadable source remains intact and reports its error when that thread is opened. */
    }
  }
  return [...ids];
}
