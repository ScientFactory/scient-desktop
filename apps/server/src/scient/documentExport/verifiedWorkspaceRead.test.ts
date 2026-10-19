// @effect-diagnostics nodeBuiltinImport:off -- Builds a checked file and swaps a FIFO in on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import {
  checkedFileIdentity,
  readCappedFile,
  readVerifiedWorkspaceFile,
} from "./verifiedWorkspaceRead.ts";

const HOST_PLATFORM = HostProcess.Platform.defaultValue();

it.live("reads an unchanged file whose numeric timestamp rounds into the next millisecond", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const project = yield* fs.makeTempDirectoryScoped({ prefix: "scient-stat-precision-" });
    const file = NodePath.join(project, "notes.tex");
    NodeFS.writeFileSync(file, "Notes.");
    // Node's numeric stat adds the fractional milliseconds to an epoch-sized
    // double; bigint stat (used by Effect) truncates before converting to Date.
    const mtimeNs = 1_790_000_000_999_999_900n;
    const numericMtimeMs = 1_790_000_000_000 + 999_999_900 / 1_000_000;
    const checked = {
      ...checkedFileIdentity(file, yield* fs.stat(file)),
      mtimeMs: Number(mtimeNs / 1_000_000n),
    };
    expect(Math.trunc(numericMtimeMs)).toBe(checked.mtimeMs + 1);
    const timestampStat = <T extends NodeFS.Stats | NodeFS.BigIntStats>(info: T): T =>
      typeof info.mtimeMs === "bigint"
        ? Object.assign(info, { mtimeMs: mtimeNs / 1_000_000n, mtimeNs })
        : Object.assign(info, { mtimeMs: numericMtimeMs });
    const open = NodeFS.promises.open;
    vi.spyOn(NodeFS.promises, "open").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const stat = handle.stat.bind(handle);
      vi.spyOn(handle, "stat").mockImplementation(async (options) =>
        timestampStat(await stat(options)),
      );
      return handle;
    });
    const lstat = NodeFS.promises.lstat;
    vi.spyOn(NodeFS.promises, "lstat").mockImplementation(async (...args) =>
      timestampStat(await lstat(...args)),
    );
    // Model Linux's descriptor containment result on Windows as well.
    vi.spyOn(NodeFS.promises, "readlink").mockResolvedValue(file);
    yield* Effect.addFinalizer(() => Effect.sync(() => vi.restoreAllMocks()));
    for (const read of [
      readCappedFile,
      (identity: typeof checked, cap: number) =>
        readVerifiedWorkspaceFile(identity, project, "linux", cap),
    ]) {
      const contents = yield* read(checked, 1024);
      expect(contents._tag).toBe("bytes");
      if (contents._tag === "bytes")
        expect(new TextDecoder().decode(contents.bytes)).toBe("Notes.");
      expect(yield* read({ ...checked, mtimeMs: checked.mtimeMs - 1 }, 1024)).toEqual({
        _tag: "unreadable",
      });
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);

describe.skipIf(HOST_PLATFORM !== "darwin" && HOST_PLATFORM !== "linux")(
  "readVerifiedWorkspaceFile",
  () => {
    it.live("refuses a FIFO swapped in for the checked file without waiting for a writer", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const project = NodeFS.realpathSync(
          yield* fs.makeTempDirectoryScoped({ prefix: "scient-verified-read-" }),
        );
        const file = NodePath.join(project, "notes.md");
        NodeFS.writeFileSync(file, "# Notes\n");
        const checked = checkedFileIdentity(file, yield* fs.stat(file));
        NodeFS.unlinkSync(file);
        NodeChildProcess.execFileSync("mkfifo", [file]);
        // A blocked open would wait for a writer forever; release it if one is left behind.
        const releaseBlockedOpen = Effect.sync(() => {
          try {
            NodeFS.closeSync(
              NodeFS.openSync(file, NodeFS.constants.O_WRONLY | NodeFS.constants.O_NONBLOCK),
            );
          } catch {
            // No reader is waiting.
          }
        });
        const read = yield* readVerifiedWorkspaceFile(checked, project, HOST_PLATFORM, 1024).pipe(
          Effect.timeoutOption("2 seconds"),
          Effect.ensuring(releaseBlockedOpen),
        );
        expect(read._tag === "Some" && read.value).toEqual({ _tag: "unreadable" });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
    );
  },
);
