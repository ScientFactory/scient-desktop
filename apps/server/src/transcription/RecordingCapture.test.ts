// @effect-diagnostics nodeBuiltinImport:off - Verifies the durable chunk files on disk.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it, vi } from "vite-plus/test";
import {
  finishCapture,
  recoverCaptures,
  saveCaptureChunk,
  touchCapture,
} from "./RecordingCapture.ts";

it("recovers only interrupted captures and keeps every saved piece, even after a lost one", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "recording-recovery-"));
  const interrupted = "00000000-0000-0000-0000-000000000001";
  const active = "00000000-0000-0000-0000-000000000002";
  const register = vi.fn(async (source: string) => NodeFSP.readFile(source, "utf8"));
  const chunk = (id: string, index: number, bytes: string) =>
    saveCaptureChunk(root, id, "webm", index, Buffer.from(bytes).toString("base64"));
  try {
    await chunk(interrupted, 0, "header");
    await chunk(interrupted, 1, "audio");
    await chunk(interrupted, 1, "audio");
    await chunk(interrupted, 3, "after the lost chunk");
    await chunk(active, 0, "active audio");
    const now = 1_700_000_000_000;
    await touchCapture(root, active, now);
    const stale = (now - 60_000) / 1000;
    await NodeFSP.utimes(NodePath.join(root, ".recording-capture-" + interrupted), stale, stale);
    await recoverCaptures(root, register, now);
    expect(register).toHaveBeenCalledTimes(1);
    await expect(register.mock.results[0]?.value).resolves.toBe("headeraudioafter the lost chunk");
    await recoverCaptures(root, register, now);
    expect(register).toHaveBeenCalledTimes(1);
    await finishCapture(root, active, register);
    await expect(register.mock.results[1]?.value).resolves.toBe("active audio");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("refuses a late piece of a recording already saved, so the rest is never saved on its own", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "recording-finished-"));
  const id = "00000000-0000-0000-0000-000000000003";
  try {
    await saveCaptureChunk(root, id, "webm", 0, Buffer.from("header").toString("base64"));
    await finishCapture(root, id, async () => undefined);
    await expect(
      saveCaptureChunk(root, id, "webm", 1, Buffer.from("late").toString("base64")),
    ).rejects.toThrow("already saved");
    expect((await NodeFSP.readdir(root)).filter((name) => name.startsWith("."))).toEqual([]);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
