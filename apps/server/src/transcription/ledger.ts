// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Ledger writes use Node file handles and filesystem sync.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

export async function fingerprint(path: string) {
  const file = await NodeFSP.open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("Expected a regular file.");
    const size = Math.min(stat.size, 64 * 1024);
    const head = await file.read(Buffer.alloc(size), 0, size, 0);
    const tail = await file.read(Buffer.alloc(size), 0, size, stat.size - size);
    const current = await file.stat();
    if (
      stat.size !== current.size ||
      stat.mtimeMs !== current.mtimeMs ||
      head.bytesRead !== size ||
      tail.bytesRead !== size
    )
      throw new Error("Input changed.");
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      hash: NodeCrypto.createHash("sha256").update(head.buffer).update(tail.buffer).digest("hex"),
    };
  } finally {
    await file.close();
  }
}

export async function atomicWrite(path: string, text: string) {
  const temporary = path + "." + NodeCrypto.randomUUID() + ".part";
  try {
    await NodeFSP.writeFile(temporary, text, { flag: "wx", flush: true });
    await NodeFSP.rename(temporary, path);
  } finally {
    await NodeFSP.rm(temporary, { force: true });
  }
}

export type Segment = {
  id: string;
  start: number;
  end: number;
  text: string;
  textRaw: string;
  language: string;
  speaker: string | null;
  source?: "subtitles" | "import";
  windowId: number;
  engine: string;
  model: string;
  confidence?: number;
  needsReview?: boolean;
};

export type Checkpoint = {
  windowId: number;
  mapping: { processedStart: number; sourceStart: number; length: number }[];
  segments: Segment[];
  recognitionHints?: boolean;
};

export async function checkpointCount(directory: string) {
  const { O_RDONLY, O_NOFOLLOW } = NodeFS.constants;
  const handle = await NodeFSP.open(
    NodePath.join(directory, "results.jsonl"),
    O_RDONLY | O_NOFOLLOW,
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!handle) return 0;
  try {
    return (await handle.readFile()).reduce((count, byte) => count + Number(byte === 10), 0);
  } finally {
    await handle.close();
  }
}

function parseCheckpoints(bytes: Buffer, end: number) {
  return bytes
    .subarray(0, end)
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, index): Checkpoint => {
      const row = JSON.parse(line) as Checkpoint;
      if (row.windowId !== index || !Array.isArray(row.segments)) {
        throw new Error("Invalid transcript ledger.");
      }
      return row;
    });
}

export async function readCheckpoints(directory: string) {
  const { O_RDONLY, O_NOFOLLOW } = NodeFS.constants;
  const file = await NodeFSP.open(NodePath.join(directory, "results.jsonl"), O_RDONLY | O_NOFOLLOW);
  try {
    const bytes = await file.readFile();
    return parseCheckpoints(bytes, bytes.lastIndexOf(10) + 1);
  } finally {
    await file.close();
  }
}

export async function openLedger(directory: string) {
  const path = NodePath.join(directory, "results.jsonl");
  const { O_APPEND, O_CREAT, O_RDWR, O_NOFOLLOW } = NodeFS.constants;
  const flags = O_APPEND | O_CREAT | O_RDWR | O_NOFOLLOW;
  const file = await NodeFSP.open(path, flags, 0o600);
  let bytes: Buffer;
  try {
    bytes = await file.readFile();
  } finally {
    await file.close();
  }
  const end = bytes.lastIndexOf(10) + 1;
  const rows = parseCheckpoints(bytes, end);
  if (end !== bytes.length) {
    const handle = await NodeFSP.open(path, flags);
    try {
      await handle.truncate(end);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return {
    rows,
    async append(row: Checkpoint) {
      if (row.windowId !== rows.length) throw new Error("Invalid window order.");
      const handle = await NodeFSP.open(path, flags, 0o600);
      try {
        await handle.writeFile(JSON.stringify(row) + "\n");
        await handle.sync();
      } finally {
        await handle.close();
      }
      rows.push(row);
    },
  };
}

export async function createRevision(root: string, source: string) {
  const name = NodePath.basename(source, NodePath.extname(source));
  const slug = [...name.normalize("NFC").replace(/[^\p{L}\p{N}\p{M}]+/gu, "-")]
    .slice(0, 48)
    .join("")
    .replace(/^-+|-+$/g, "");
  const id =
    new Date().toISOString().slice(0, 10) +
    "-" +
    (slug || "audio") +
    "-" +
    NodeCrypto.randomUUID().slice(0, 8);
  await NodeFSP.mkdir(NodePath.join(root, id));
  return id;
}

export function timestamp(seconds: number) {
  const total = Math.max(0, Math.floor(seconds));
  return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60]
    .map((part, index) => (index ? String(part).padStart(2, "0") : String(part)))
    .join(":");
}
