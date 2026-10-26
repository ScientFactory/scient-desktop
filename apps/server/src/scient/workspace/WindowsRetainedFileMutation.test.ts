// @effect-diagnostics nodeBuiltinImport:off
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";
import { ensureNativePrivateRetentionDirectory } from "./NativeFilePublication.ts";
import {
  bytesRevision,
  fileIdentity,
  mutateRetainedFile,
  type RetainedMutationInput,
} from "./RetainedFileMutation.ts";
import { windowsNativeFile } from "./WindowsNativeFile.ts";

const windows = HostProcess.Platform.defaultValue() === "win32";
const helper = windows ? await filePublicationTestHelper() : undefined;
async function fixture(body: (input: RetainedMutationInput, target: string) => Promise<void>) {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-windows-files-")),
  );
  const cwd = NodePath.join(root, "paper");
  const retentionDirectory = NodePath.join(root, "private");
  await NodeFSP.mkdir(cwd);
  await ensureNativePrivateRetentionDirectory(helper!, retentionDirectory);
  const target = NodePath.join(cwd, "main.tex");
  await NodeFSP.writeFile(target, "original");
  try {
    await body(
      {
        cwd,
        relativePath: "main.tex",
        retentionDirectory,
        id: "one",
        kind: "write",
        condition: "revision",
        expectedRevision: bytesRevision(Buffer.from("original")),
        bytes: Buffer.from("incoming"),
        nativePublicationHelper: helper!,
      },
      target,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(!windows)("Windows capture and install", () => {
  it("retains the original object and installs complete bytes", () =>
    fixture(async (input, target) => {
      const original = await fileIdentity(target);
      const result = await mutateRetainedFile(input, target);
      expect(result.outcome).toBe("done");
      expect(result.retainedIdentity).toEqual(original);
      expect(await NodeFSP.readFile(result.retainedPath!, "utf8")).toBe("original");
      expect(await NodeFSP.readFile(target, "utf8")).toBe("incoming");
      expect(await fileIdentity(target)).not.toEqual(original);
      expect((await windowsNativeFile(result.retainedPath!, "private", helper)).code).toBe(0);
    }));
  it("keeps a newcomer at the target after capture", () =>
    fixture(async (input, target) => {
      const result = await mutateRetainedFile(input, target, {
        at: async (point) => {
          if (point === "displaced")
            await NodeFSP.writeFile(target, "outside save", { flag: "wx" });
        },
      });
      expect(result.outcome).toBe("attention");
      expect(await NodeFSP.readFile(target, "utf8")).toBe("outside save");
      expect(await NodeFSP.readFile(result.retainedPath!, "utf8")).toBe("original");
    }));
  it("restores A's policy when interrupted between restriction and capture", () =>
    fixture(async (input, target) => {
      await expect(
        mutateRetainedFile(input, target, {
          at: async (point) => {
            if (point === "restricted") throw new Error("interrupted");
          },
        }),
      ).rejects.toThrow("interrupted");
      const recovered = await mutateRetainedFile({ ...input, bytes: undefined }, target);
      expect(recovered.outcome).toBe("skipped");
      expect(await NodeFSP.readFile(target, "utf8")).toBe("original");
    }));
  it("creates without retaining or overwriting an occupant", () =>
    fixture(async (input, target) => {
      await NodeFSP.unlink(target);
      const result = await mutateRetainedFile(
        { ...input, kind: "create", condition: "absent", expectedRevision: null },
        target,
      );
      expect(result.outcome).toBe("done");
      expect(result.retainedPath).toBeNull();
      expect(await NodeFSP.readFile(target, "utf8")).toBe("incoming");
    }));
});
