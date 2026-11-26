// @effect-diagnostics nodeBuiltinImport:off - Recording chunks are committed alongside the project transcript ledger.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { atomicWrite } from "./ledger.ts";

const prefix = ".recording-capture-";
const captureName = /^\.recording-capture-([0-9a-f-]{36})$/;
const chunkName = /^(\d{8})\.chunk$/;
const leaseMs = 12_000;
/**
 * Captures already published in this process. A late piece of one must not start a new capture
 * under its ID, which would publish the rest of the recording on its own.
 */
const finished = new Set<string>();
const FINISHED_LIMIT = 1_000;

export const isCaptureFinished = (id: string) => finished.has(id);

async function captureDirectory(root: string, id: string) {
  if (finished.has(id)) throw new Error("This recording was already saved.");
  const directory = NodePath.join(root, prefix + id);
  await NodeFSP.mkdir(root, { recursive: true });
  await NodeFSP.mkdir(directory, { recursive: true });
  if (!(await NodeFSP.lstat(directory)).isDirectory()) throw new Error("Invalid capture directory");
  return directory;
}

export async function saveCaptureChunk(
  root: string,
  id: string,
  format: "webm" | "m4a",
  index: number,
  bytes: string,
) {
  const directory = await captureDirectory(root, id);
  await atomicWrite(NodePath.join(directory, "format"), format);
  await atomicWrite(NodePath.join(directory, String(index).padStart(8, "0") + ".chunk"), bytes);
}

export type CaptureCaption = { window: number; start: number; end: number; text: string };

const captionName = /^(\d{6})\.json$/;

/** Live captions of a capture, oldest first. */
export async function readCaptions(root: string, id: string): Promise<CaptureCaption[]> {
  const directory = NodePath.join(root, prefix + id, "captions");
  const names = await NodeFSP.readdir(directory).catch(() => [] as string[]);
  const captions = await Promise.all(
    names
      .filter((name) => captionName.test(name))
      .sort()
      .map(async (name) => {
        try {
          return JSON.parse(
            await NodeFSP.readFile(NodePath.join(directory, name), "utf8"),
          ) as CaptureCaption;
        } catch {
          return undefined;
        }
      }),
  );
  return captions.filter((caption) => caption !== undefined);
}

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const hours = Math.floor(minutes / 60);
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours
    ? `${hours}:${pad(minutes % 60)}:${pad(whole % 60)}`
    : `${pad(minutes)}:${pad(whole % 60)}`;
};

/** The captions as one Markdown file an agent can read while the lesson goes on. */
const captionsPath = (root: string, id: string) => NodePath.join(root, prefix + id, "captions.md");

/** Saves one caption window, idempotent by window, and rewrites the captions file. */
export async function saveCaption(root: string, id: string, caption: CaptureCaption) {
  const directory = await captureDirectory(root, id);
  await NodeFSP.mkdir(NodePath.join(directory, "captions"), { recursive: true });
  await atomicWrite(
    NodePath.join(directory, "captions", `${String(caption.window).padStart(6, "0")}.json`),
    JSON.stringify(caption),
  );
  const captions = await readCaptions(root, id);
  await atomicWrite(
    captionsPath(root, id),
    "# Live captions (provisional)\n\n" +
      captions.map((item) => `[${clock(item.start)}] ${item.text}`).join("\n\n") +
      "\n",
  );
}

export async function touchCapture(root: string, id: string, nowMs: number) {
  const directory = await captureDirectory(root, id);
  await NodeFSP.utimes(directory, nowMs / 1000, nowMs / 1000);
}

export async function finishCapture(
  root: string,
  id: string,
  register: (source: string) => Promise<unknown>,
) {
  const directory = NodePath.join(root, prefix + id);
  if (!(await NodeFSP.lstat(directory)).isDirectory()) throw new Error("Invalid capture directory");
  const chunks = (await NodeFSP.readdir(directory)).filter((name) => chunkName.test(name)).sort();
  if (!chunks.length) {
    await NodeFSP.rmdir(directory).catch(() => undefined);
    return undefined;
  }
  const format = await NodeFSP.readFile(NodePath.join(directory, "format"), "utf8");
  if (format !== "webm" && format !== "m4a") throw new Error("Unknown recording format");
  const stamp = (await NodeFSP.stat(NodePath.join(directory, chunks[0]!))).birthtime
    .toISOString()
    .replace(/[:.]/g, "-");
  const extension = format === "webm" ? "weba" : format;
  const path = NodePath.join(root, `Recording ${stamp} ${id.slice(0, 8)}.${extension}`);
  const temporary = NodePath.join(directory, "audio.part");
  const output = await NodeFSP.open(temporary, "w");
  try {
    // Every saved piece, in order: a piece lost in the middle costs a moment, never the rest.
    for (const name of chunks) {
      const bytes = Buffer.from(
        await NodeFSP.readFile(NodePath.join(directory, name), "utf8"),
        "base64",
      );
      await output.writeFile(bytes);
    }
    await output.sync();
  } finally {
    await output.close();
  }
  if (!(await NodeFSP.stat(temporary)).size) return undefined;
  await NodeFSP.rename(temporary, path);
  if (finished.size >= FINISHED_LIMIT) finished.delete(finished.values().next().value!);
  finished.add(id);
  await register(path);
  await NodeFSP.rm(directory, { recursive: true });
  return path;
}

export async function recoverCaptures(
  root: string,
  register: (source: string) => Promise<unknown>,
  nowMs: number,
) {
  const entries = await NodeFSP.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const id = captureName.exec(entry.name)?.[1];
    if (!id || !entry.isDirectory()) continue;
    const info = await NodeFSP.stat(NodePath.join(root, entry.name)).catch(() => undefined);
    if (info && nowMs - info.mtimeMs > leaseMs)
      await finishCapture(root, id, register).catch(() => undefined);
  }
}
