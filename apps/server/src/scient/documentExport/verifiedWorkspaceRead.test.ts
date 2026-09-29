// @effect-diagnostics nodeBuiltinImport:off -- Builds a checked file and swaps a FIFO in on disk.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { checkedFileIdentity, readVerifiedWorkspaceFile } from "./verifiedWorkspaceRead.ts";

const HOST_PLATFORM = HostProcessPlatform.defaultValue();

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
