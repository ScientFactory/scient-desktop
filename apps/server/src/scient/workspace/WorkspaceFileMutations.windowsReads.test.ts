// @effect-diagnostics nodeBuiltinImport:off -- Real folders, with the host taken for Windows.
/**
 * On Windows the native publication helper can be unavailable: refused by its install folder's
 * permissions, or slow on a cold start. A plain read publishes nothing, so it must still work,
 * and still refuse a folder that was replaced while it was read.
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { fileMutationFixture } from "./fileExchange.testkit.ts";

const withoutHelper = async () => undefined;

describe("plain reads on a Windows host without the native helper", () => {
  it.live("read the workspace and give its epoch", () =>
    fileMutationFixture(
      async (h) => {
        await NodeFSP.writeFile(NodePath.join(h.cwd, "sentinel.txt"), "kept");
        using _host = vi.spyOn(HostProcess.Platform, "defaultValue").mockReturnValue("win32");
        expect(
          await h.run(
            h.methods.withSettledWorkspaceRead({ cwd: h.cwd }, () => Effect.succeed("read")),
          ),
        ).toBe("read");
        expect(
          await h.run(
            h.methods.withSettledFileRead({ cwd: h.cwd, relativePath: "sentinel.txt" }, () =>
              Effect.succeed("file"),
            ),
          ),
        ).toBe("file");
        expect(await h.run(h.methods.getMutationEpoch({ cwd: h.cwd }))).toMatch(/^[0-9a-f]{64}$/u);
      },
      {},
      null,
      withoutHelper,
    ),
  );

  it.live("refuse a read whose workspace folder was replaced meanwhile", () =>
    fileMutationFixture(
      async (h) => {
        using _host = vi.spyOn(HostProcess.Platform, "defaultValue").mockReturnValue("win32");
        const replaced = h.run(
          h.methods.withSettledWorkspaceRead({ cwd: h.cwd }, () =>
            Effect.promise(async () => {
              await NodeFSP.rename(h.cwd, `${h.cwd}-old`);
              await NodeFSP.mkdir(h.cwd);
              return "read";
            }),
          ),
        );
        await expect(replaced).rejects.toMatchObject({ _tag: "WorkspaceFileTargetChangedError" });
      },
      {},
      null,
      withoutHelper,
    ),
  );
});
