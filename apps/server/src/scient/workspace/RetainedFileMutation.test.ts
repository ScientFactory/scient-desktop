// @effect-diagnostics nodeBuiltinImport:off
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  bytesRevision,
  fileIdentity,
  mutateRetainedFile,
  recheckRetainedFile,
  type MutationPoint,
  type RetainedMutationInput,
} from "./RetainedFileMutation.ts";
import { nativeFilePublicationCapabilities } from "./NativeFilePublication.ts";
const bytes = (text: string) => Buffer.from(text);
const helper = await filePublicationTestHelper();
const capabilities = helper === undefined ? null : await nativeFilePublicationCapabilities(helper);
const qualifiedCapture =
  capabilities?.strictCurrentRoot === true &&
  capabilities.exclusiveMove &&
  capabilities.exclusiveLink;
async function fixture(
  body: (input: RetainedMutationInput, target: string, root: string) => Promise<void>,
) {
  const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-retained-")),
    ),
    target = NodePath.join(root, "paper/main.tex");
  await NodeFSP.mkdir(NodePath.dirname(target));
  await NodeFSP.mkdir(NodePath.join(root, "records"), { mode: 0o700 });
  await NodeFSP.writeFile(target, "captured", { mode: 0o600 });
  try {
    await body(
      {
        cwd: NodePath.dirname(target),
        relativePath: "main.tex",
        retentionDirectory: NodePath.join(root, "records"),
        id: "one",
        mutationId: "one",
        expectedRevision: bytesRevision(bytes("captured")),
        bytes: null,
        kind: "delete",
        condition: "revision",
        ...(helper === undefined ? {} : { nativePublicationHelper: helper }),
      },
      target,
      root,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}
describe("retained publication admission", () => {
  it.skipIf(!qualifiedCapture || !capabilities?.atomicExchange)(
    "replaces bytes atomically, preserving permissions and the displaced inode",
    () =>
      fixture(async (input, target) => {
        const identity = await fileIdentity(target);
        const result = await mutateRetainedFile(
          { ...input, kind: "write", bytes: bytes("incoming") },
          target,
        );
        expect(result.outcome).toBe("done");
        expect(await fileIdentity(target)).not.toEqual(identity);
        expect(await NodeFSP.readFile(target, "utf8")).toBe("incoming");
        expect((await NodeFSP.stat(target)).mode & 0o777).toBe(0o600);
        expect(result.retainedIdentity).toEqual(identity);
        expect(result.retainedRevision).toBe(bytesRevision(bytes("captured")));
      }),
  );
  if (!qualifiedCapture)
    it("refuses namespace mutation on an unqualified host without consuming the source", () =>
      fixture(async (input, target) => {
        const identity = await fileIdentity(target);
        await expect(mutateRetainedFile(input, target)).rejects.toMatchObject({
          reason: "unavailable",
        });
        expect(await fileIdentity(target)).toEqual(identity);
        expect(await NodeFSP.readFile(target, "utf8")).toBe("captured");
      }));
  if (qualifiedCapture) {
    it("retains the actual removed inode with restrictive permissions and late descriptor writes", () =>
      fixture(async (input, target) => {
        const identity = await fileIdentity(target),
          handle = await NodeFSP.open(target, "r+");
        try {
          const result = await mutateRetainedFile(input, target);
          expect(result.outcome).toBe("done");
          expect(result.retainedIdentity).toEqual(identity);
          expect((await NodeFSP.stat(result.retainedPath!)).mode & 0o777).toBe(0o600);
          await handle.truncate(0);
          await handle.writeFile("late B");
          await handle.sync();
          const observed = await recheckRetainedFile(result, input.expectedRevision);
          expect(observed.changed).toBe(true);
          expect(await NodeFSP.readFile(observed.retainedPath!, "utf8")).toBe("late B");
          await expect(NodeFSP.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
        } finally {
          await handle.close();
        }
      }));
    it.each([false, true])("retains a post-check outside edit, replacement=%s", (replacement) =>
      fixture(async (input, target, root) => {
        const result = await mutateRetainedFile(input, target, {
          at: async (point) => {
            if (point !== "checked") return;
            if (replacement) {
              const outside = NodePath.join(root, "outside");
              await NodeFSP.writeFile(outside, "outside B");
              await NodeFSP.rename(outside, target);
            } else await NodeFSP.writeFile(target, "outside B");
          },
        });
        expect(result.outcome).toBe("attention");
        expect(result.failure).toBe("revision");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("outside B");
        expect(await NodeFSP.readFile(result.retainedPath!, "utf8")).toBe("outside B");
      }),
    );
    it("preserves a final link inserted at capture without opening its outside referent", () =>
      fixture(async (input, target, root) => {
        const outside = NodePath.join(root, "outside");
        await NodeFSP.writeFile(outside, "outside kept");
        const result = await mutateRetainedFile(input, target, {
          at: async (point) => {
            if (point === "checked") {
              await NodeFSP.unlink(target);
              await NodeFSP.symlink(outside, target);
            }
          },
        });
        expect(result.outcome).toBe("attention");
        expect(await NodeFSP.readFile(outside, "utf8")).toBe("outside kept");
        expect((await NodeFSP.lstat(target)).isSymbolicLink()).toBe(true);
      }));
    it("does not overwrite foreign D while exclusively returning retained B", () =>
      fixture(async (input, target, root) => {
        const replace = async (contents: string) => {
          const file = NodePath.join(root, "writer");
          await NodeFSP.writeFile(file, contents);
          await NodeFSP.rename(file, target);
        };
        const result = await mutateRetainedFile(input, target, {
          at: async (point) => {
            if (point === "checked") await replace("outside B");
            if (point === "restore-intent") await replace("outside D");
          },
        });
        expect(result.outcome).toBe("attention");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("outside D");
        expect(await NodeFSP.readFile(result.retainedPath!, "utf8")).toBe("outside B");
      }));
    it.each(["intent", "prepared", "displaced", "done"] as MutationPoint[])(
      "reconstructs a removal after durable boundary %s without repeating capture",
      (point) =>
        fixture(async (input, target) => {
          await expect(
            mutateRetainedFile(input, target, {
              at: async (at) => {
                if (at === point) throw new Error("owned process died");
              },
            }),
          ).rejects.toThrow("owned process died");
          const result = await mutateRetainedFile(input, target);
          expect(result.outcome).toBe("done");
          await expect(NodeFSP.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await NodeFSP.readFile(result.retainedPath!, "utf8")).toBe("captured");
        }),
    );
    it("never re-captures after an ambiguous publishing boundary", () =>
      fixture(async (input, target) => {
        await expect(
          mutateRetainedFile(input, target, {
            at: async (point) => {
              if (point === "checked") throw new Error("native admission interrupted");
            },
          }),
        ).rejects.toThrow("native admission interrupted");
        await NodeFSP.writeFile(target, "outside D");
        const identity = await fileIdentity(target);
        const result = await mutateRetainedFile(input, target);
        expect(result.outcome).toBe("attention");
        expect(result.failure).toBe("recovery");
        expect(await fileIdentity(target)).toEqual(identity);
        expect(await NodeFSP.readFile(target, "utf8")).toBe("outside D");
      }));
    it("refuses same-content private replacement as a captured receipt", () =>
      fixture(async (input, target, root) => {
        const recordDirectory = NodePath.join(input.retentionDirectory, input.id);
        await expect(
          mutateRetainedFile(input, target, {
            at: async (point) => {
              if (point === "displaced") throw new Error("captured before crash");
            },
          }),
        ).rejects.toThrow("captured before crash");
        const replacement = NodePath.join(root, "foreign");
        await NodeFSP.writeFile(replacement, "captured");
        await NodeFSP.rename(replacement, NodePath.join(recordDirectory, "retained"));
        const foreign = await fileIdentity(NodePath.join(recordDirectory, "retained"));
        const result = await mutateRetainedFile(input, target);
        expect(result.outcome).toBe("attention");
        expect(result.failure).toBe("recovery");
        expect(result.retainedIdentity).toEqual(foreign);
        await expect(NodeFSP.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      }));
    it("replays original terminal deletion after outside D instead of removing D", () =>
      fixture(async (input, target) => {
        await mutateRetainedFile(input, target);
        await NodeFSP.writeFile(target, "outside D");
        const replayed = await mutateRetainedFile(input, target);
        expect(replayed.outcome).toBe("done");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("outside D");
        await expect(
          mutateRetainedFile(
            { ...input, expectedRevision: bytesRevision(bytes("outside D")) },
            target,
          ),
        ).rejects.toMatchObject({ reason: "intent" });
      }));
    it("refuses finite admission without consuming the workspace entry", () =>
      fixture(async (input, target) => {
        const identity = await fileIdentity(target);
        await expect(
          mutateRetainedFile({ ...input, retentionLimitBytes: 1 }, target),
        ).rejects.toThrow("cannot admit");
        expect(await fileIdentity(target)).toEqual(identity);
      }));
    it("creates a distinct public clone with normal mode and leaves late private-stage writes private", () =>
      fixture(async (input, target) => {
        await NodeFSP.unlink(target);
        const created = await mutateRetainedFile(
          {
            ...input,
            kind: "create",
            condition: "absent",
            expectedRevision: null,
            bytes: bytes("C"),
          },
          target,
        );
        expect(created.outcome).toBe("done");
        expect(await fileIdentity(target)).not.toEqual(created.retainedIdentity);
        expect((await NodeFSP.stat(target)).mode & 0o777).toBe(0o666 & ~process.umask());
        const stage = await NodeFSP.open(created.retainedPath!, "r+");
        try {
          await stage.truncate(0);
          await stage.writeFile("private late D");
          await stage.sync();
        } finally {
          await stage.close();
        }
        expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
        expect(await NodeFSP.readFile(created.retainedPath!, "utf8")).toBe("private late D");
      }));
    it.each(["installed", "done"] as MutationPoint[])(
      "reconstructs a confirmed clone after %s without adopting its private inode",
      (point) =>
        fixture(async (input, target) => {
          await NodeFSP.unlink(target);
          const creation = {
            ...input,
            kind: "create" as const,
            condition: "absent" as const,
            expectedRevision: null,
            bytes: bytes("C"),
          };
          await expect(
            mutateRetainedFile(creation, target, {
              at: async (at) => {
                if (at === point) throw new Error("process died after confirmed clone");
              },
            }),
          ).rejects.toThrow("process died");
          const publicIdentity = await fileIdentity(target);
          const recovered = await mutateRetainedFile(creation, target);
          expect(recovered.outcome).toBe("done");
          expect(await fileIdentity(target)).toEqual(publicIdentity);
          expect(publicIdentity).not.toEqual(recovered.retainedIdentity);
          expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
        }),
    );
    it("does not mistake a foreign same-content object for an ambiguous creation receipt", () =>
      fixture(async (input, target) => {
        await NodeFSP.unlink(target);
        const creation = {
          ...input,
          kind: "create" as const,
          condition: "absent" as const,
          expectedRevision: null,
          bytes: bytes("C"),
        };
        await expect(
          mutateRetainedFile(creation, target, {
            at: async (point) => {
              if (point === "install-intent")
                throw new Error("process died without native receipt");
            },
          }),
        ).rejects.toThrow("process died");
        await NodeFSP.writeFile(target, "C");
        const foreign = await fileIdentity(target);
        const recovered = await mutateRetainedFile(creation, target);
        expect(recovered.outcome).toBe("attention");
        expect(await fileIdentity(target)).toEqual(foreign);
        expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
        expect(await NodeFSP.readFile(recovered.retainedPath!, "utf8")).toBe("C");
      }));
  }
});
