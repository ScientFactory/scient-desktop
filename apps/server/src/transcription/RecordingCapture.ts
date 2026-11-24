// @effect-diagnostics nodeBuiltinImport:off - Recording chunks are committed alongside the project transcript ledger.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { atomicWrite } from "./ledger.ts";

const prefix = ".recording-capture-";
const captureName = /^\.recording-capture-([0-9a-f-]{36})$/;
const chunkName = /^(\d{8})\.chunk$/;
const leaseMs = 12_000;

async function captureDirectory(root: string, id: string) {
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
    for (const [index, name] of chunks.entries()) {
      if (Number(chunkName.exec(name)?.[1]) !== index) break;
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
