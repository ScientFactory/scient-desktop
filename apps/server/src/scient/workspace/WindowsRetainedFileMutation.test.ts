// @effect-diagnostics nodeBuiltinImport:off
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { filePublicationTestHelper, filePublicationProbeHelper } from "./fileExchange.testkit.ts";
import {
  ensureNativePrivateRetentionDirectory,
  bindNativeFilePublicationParent,
  withNativeFilePublicationLease,
  removeNativeRetainedEntry,
} from "./NativeFilePublication.ts";
import {
  bytesRevision,
  fileIdentity,
  mutateRetainedFile,
  type RetainedMutationInput,
} from "./RetainedFileMutation.ts";
import { overleafFilesAvailability } from "../overleaf/overleafFileAvailability.ts";
import { platformFileIdentity } from "./PlatformFileIdentity.ts";
import type { WindowsCrashJob } from "./WindowsRetainedFileMutation.crash-child.ts";
import { windowsNativeFile } from "./WindowsNativeFile.ts";

const windows = HostProcess.Platform.defaultValue() === "win32";
const probe = windows ? await filePublicationProbeHelper() : undefined;
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
      expect(
        result.outcome,
        await NodeFSP.readFile(NodePath.join(result.recordDirectory, "record.json"), "utf8"),
      ).toBe("done");
      expect(result.retainedIdentity).toEqual(original);
      expect(await NodeFSP.readFile(result.retainedPath!, "utf8")).toBe("original");
      expect(await NodeFSP.readFile(target, "utf8")).toBe("incoming");
      expect(await fileIdentity(target)).not.toEqual(original);
      expect((await windowsNativeFile(result.retainedPath!, "private", helper)).code).toBe(0);
    }));
  it("deletes by keeping the original object and prunes only an empty directory", () =>
    fixture(async (input, target) => {
      const original = await fileIdentity(target);
      const deleted = await mutateRetainedFile(
        { ...input, kind: "delete", bytes: undefined },
        target,
      );
      expect(deleted.outcome).toBe("done");
      expect(deleted.retainedIdentity).toEqual(original);
      expect(await NodeFSP.readFile(deleted.retainedPath!, "utf8")).toBe("original");
      await expect(NodeFSP.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
      await NodeFSP.mkdir(target);
      const pruned = await mutateRetainedFile(
        {
          ...input,
          id: "prune",
          kind: "prune",
          condition: "unguarded",
          expectedRevision: null,
          bytes: undefined,
        },
        target,
      );
      expect(pruned.outcome).toBe("done");
      await expect(NodeFSP.lstat(target)).rejects.toMatchObject({ code: "ENOENT" });
    }));
  it("preserves read-only and hidden attributes and removes the kept file by its held parent", () =>
    fixture(async (input, target) => {
      NodeChildProcess.execFileSync("attrib.exe", ["+R", "+H", target]);
      const result = await mutateRetainedFile(input, target);
      expect(result.outcome).toBe("done");
      expect((await windowsNativeFile(target, "flags")).flags & 3).toBe(3);
      expect((await windowsNativeFile(result.retainedPath!, "flags")).flags & 3).toBe(3);
      const binding = await bindNativeFilePublicationParent(helper!, result.recordDirectory, "");
      await withNativeFilePublicationLease(
        helper!,
        [binding],
        async (lease) => {
          await removeNativeRetainedEntry(lease, result.recordDirectory, "retained");
        },
        { mode: "exclusive" },
      );
      await expect(NodeFSP.lstat(result.retainedPath!)).rejects.toMatchObject({ code: "ENOENT" });
    }));
  it.each(["create", "replace"] as const)(
    "keeps another process’s %s at the target after capture",
    (mode) =>
      fixture(async (input, target) => {
        const result = await mutateRetainedFile(input, target, {
          at: async (point) => {
            if (point === "displaced")
              NodeChildProcess.execFileSync(process.execPath, [
                "-e",
                'const fs = require("node:fs"); const [target, mode] = process.argv.slice(1); if (mode === "replace") { fs.writeFileSync(target, "intermediate"); fs.writeFileSync(target + ".outside", "outside save"); fs.renameSync(target + ".outside", target); } else fs.writeFileSync(target, "outside save", { flag: "wx" });',
                target,
                mode,
              ]);
          },
        });
        expect(result.outcome).toBe("attention");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("outside save");
        expect(await NodeFSP.readFile(result.retainedPath!, "utf8")).toBe("original");
      }),
  );
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
      expect(
        result.outcome,
        await NodeFSP.readFile(NodePath.join(result.recordDirectory, "record.json"), "utf8"),
      ).toBe("done");
      expect(result.retainedPath).toBeNull();
      expect(await NodeFSP.readFile(target, "utf8")).toBe("incoming");
    }));
});

async function security(path: string) {
  return JSON.parse(
    NodeChildProcess.execFileSync(helper!, ["--windows=1", "security", path], { encoding: "utf8" }),
  ).security;
}

describe.skipIf(!windows)("Windows process death and sharing", () => {
  it.each(
    (
      [
        "intent",
        "staged",
        "prepared",
        "checked",
        "restricted",
        "called",
        "displaced",
        "install-intent",
        "installed",
        "done",
      ] as const
    ).flatMap<{ point: WindowsCrashJob["point"]; occurrence: number }>((point) =>
      point === "called"
        ? [
            { point, occurrence: 1 },
            { point, occurrence: 2 },
          ]
        : [{ point, occurrence: 1 }],
    ),
  )(
    "recovers after TerminateProcess at $point/$occurrence without losing the original",
    ({ point, occurrence }) =>
      fixture(async (input, target) => {
        const original = await fileIdentity(target);
        const policy = await security(target);
        const jobPath = NodePath.join(NodePath.dirname(input.cwd), "job.json");
        const job: WindowsCrashJob = { input, target, point, occurrence, probe: probe! };
        await NodeFSP.writeFile(jobPath, JSON.stringify(job));
        const child = NodeChildProcess.spawnSync(
          process.execPath,
          [
            NodePath.join(import.meta.dirname, "WindowsRetainedFileMutation.crash-child.ts"),
            jobPath,
          ],
          { encoding: "utf8" },
        );
        expect(child.status, child.stderr).toBe(73);
        const recovered = await mutateRetainedFile({ ...input, bytes: undefined }, target);
        const live = await NodeFSP.readFile(target, "utf8").catch(() => null);
        const kept = recovered.retainedPath
          ? await NodeFSP.readFile(recovered.retainedPath, "utf8")
          : null;
        expect([live, kept]).toContain("original");
        if (live === "original") {
          expect(await fileIdentity(target)).toEqual(original);
          expect(await security(target)).toBe(policy);
        } else {
          expect(live).toBe("incoming");
          expect(recovered.retainedIdentity).toEqual(original);
        }
      }),
  );
  it("refuses a file held for writing by another process", () =>
    fixture(async (input, target) => {
      const holder = NodeChildProcess.spawn(probe!, ["--windows=1", "hold-write", target], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const retired = new Promise<void>((resolve) => holder.once("close", () => resolve()));
      try {
        await new Promise<void>((resolve, reject) => {
          holder.stdout.once("data", () => resolve());
          holder.once("error", reject);
          holder.once("exit", (code) => {
            if (code !== null) reject(new Error(`writer exited ${code}`));
          });
        });
        await expect(mutateRetainedFile(input, target)).rejects.toMatchObject({
          message: "file-busy",
        });
        expect(await NodeFSP.readFile(target, "utf8")).toBe("original");
      } finally {
        holder.stdin.end("\n");
        await retired;
      }
    }));
  it("preserves explicit permissions and restricts retained bytes before capture", () =>
    fixture(async (input, target) => {
      const account = `Scient${NodeCrypto.randomBytes(5).toString("hex")}`;
      const password = `S!${NodeCrypto.randomBytes(5).toString("hex")}a7`;
      const accountCommand = (operation: string) =>
        JSON.parse(
          NodeChildProcess.execFileSync(probe!, ["--windows=1", operation, "fixture"], {
            encoding: "utf8",
            env: { ...process.env, SCIENT_TEST_ACCOUNT: account, SCIENT_TEST_PASSWORD: password },
          }),
        ).code;
      expect(accountCommand("add-account")).toBe(0);
      try {
        NodeChildProcess.execFileSync("icacls.exe", [target, "/grant", `${account}:(R,W)`]);
        const policy = await security(target);
        const access = (path: string) =>
          JSON.parse(
            NodeChildProcess.execFileSync(probe!, ["--windows=1", "as-account", path], {
              encoding: "utf8",
              env: { ...process.env, SCIENT_TEST_ACCOUNT: account, SCIENT_TEST_PASSWORD: password },
            }),
          ).code;
        expect(access(target)).toBe(0);
        const result = await mutateRetainedFile(input, target, {
          at: async (point) => {
            if (point === "restricted") expect(access(target)).not.toBe(0);
            if (point === "displaced")
              expect(access(NodePath.join(input.retentionDirectory, "one/retained"))).not.toBe(0);
          },
        });
        expect(
          result.outcome,
          await NodeFSP.readFile(NodePath.join(result.recordDirectory, "record.json"), "utf8"),
        ).toBe("done");
        expect(await security(target)).toBe(policy);
        expect(access(result.retainedPath!)).toBe(5);
        await NodeFSP.writeFile(target, "original");
        const crashInput = { ...input, id: "privacy-crash" };
        const jobPath = NodePath.join(NodePath.dirname(input.cwd), "privacy-crash.json");
        const job: WindowsCrashJob = {
          input: crashInput,
          target,
          point: "restricted",
          probe: probe!,
        };
        await NodeFSP.writeFile(jobPath, JSON.stringify(job));
        const killed = NodeChildProcess.spawnSync(
          process.execPath,
          [
            NodePath.join(import.meta.dirname, "WindowsRetainedFileMutation.crash-child.ts"),
            jobPath,
          ],
          { encoding: "utf8" },
        );
        expect(killed.status, killed.stderr).toBe(73);
        const binding = await bindNativeFilePublicationParent(helper!, input.cwd, "");
        await withNativeFilePublicationLease(
          helper!,
          [binding],
          async () => {
            expect(access(target)).toBe(5);
          },
          { mode: "exclusive" },
        );
        expect(
          (await mutateRetainedFile({ ...crashInput, bytes: undefined }, target)).outcome,
        ).toBe("skipped");
        expect(access(target)).toBe(0);
        expect(await security(target)).toBe(policy);
        NodeChildProcess.execFileSync("icacls.exe", [
          input.cwd,
          "/grant",
          `${account}:(OI)(CI)(R,W)`,
        ]);
        NodeChildProcess.execFileSync("icacls.exe", [
          target,
          "/inheritance:r",
          "/remove:g",
          account,
        ]);
        const privatePolicy = await security(target);
        expect(access(target)).toBe(5);
        const privateInput = {
          ...input,
          id: "private-stage",
          bytes: Buffer.from("private incoming"),
        };
        const privateResult = await mutateRetainedFile(privateInput, target, {
          at: async (point) => {
            if (point === "staged") {
              const journal = JSON.parse(
                await NodeFSP.readFile(
                  NodePath.join(input.retentionDirectory, "private-stage/record.json"),
                  "utf8",
                ),
              );
              expect(access(NodePath.join(input.cwd, journal.stageName))).toBe(5);
            }
          },
        });
        expect(privateResult.outcome).toBe("done");
        expect(await security(target)).toBe(privatePolicy);
        expect(access(target)).toBe(5);
      } finally {
        expect(accountCommand("delete-account")).toBe(0);
      }
    }));
  it.each(["stream", "hardlink"] as const)(
    "refuses unsupported %s before changing the target",
    (kind) =>
      fixture(async (input, target) => {
        if (kind === "stream") await NodeFSP.writeFile(`${target}:notes`, "private stream");
        else await NodeFSP.link(target, `${target}.alias`);
        await expect(mutateRetainedFile(input, target)).rejects.toThrow(
          kind === "stream" ? "alternate-data-streams" : "multiple-hard-links",
        );
        expect(await NodeFSP.readFile(target, "utf8")).toBe("original");
      }),
  );
});

describe.skipIf(!windows)("Windows retention placement", () => {
  it("refuses a registered Cloud Files sync root and its descendant without repairing it", () =>
    fixture(async (input) => {
      const root = NodePath.join(input.retentionDirectory, "cloud-root");
      await ensureNativePrivateRetentionDirectory(helper!, root);
      const child = NodePath.join(root, "child");
      await NodeFSP.mkdir(child);
      const register = (operation: string) =>
        JSON.parse(
          NodeChildProcess.execFileSync(probe!, ["--windows=1", operation, root], {
            encoding: "utf8",
          }),
        ).code;
      expect(register("register-sync-root")).toBe(0);
      try {
        await expect(ensureNativePrivateRetentionDirectory(helper!, root)).rejects.toThrow();
        await expect(ensureNativePrivateRetentionDirectory(helper!, child)).rejects.toThrow();
      } finally {
        expect(register("unregister-sync-root")).toBe(0);
      }
    }));
});

describe.skipIf(!windows)("Windows folder leases and removals", () => {
  it("shares a folder across processes and excludes an exclusive holder", () =>
    fixture(async (input) => {
      const binding = await bindNativeFilePublicationParent(helper!, input.cwd, "");
      const tryLease = (mode: "shared" | "exclusive") =>
        JSON.parse(
          NodeChildProcess.execFileSync(
            probe!,
            [
              "--lease=1",
              mode,
              binding.rootPath,
              ".",
              binding.rootIdentity.dev,
              binding.rootIdentity.ino,
              binding.parentIdentity.dev,
              binding.parentIdentity.ino,
              mode,
            ],
            {
              encoding: "utf8",
              input: Buffer.alloc(4),
              env: { ...process.env, SCIENT_LEASE_TRY: "1" },
            },
          ),
        );
      await withNativeFilePublicationLease(
        helper!,
        [binding],
        async () => {
          await withNativeFilePublicationLease(
            helper!,
            [binding],
            async () => {
              expect(tryLease("exclusive")).toMatchObject({ lease: "refused", code: 33 });
            },
            { mode: "shared" },
          );
        },
        { mode: "shared" },
      );
      await withNativeFilePublicationLease(
        helper!,
        [binding],
        async () => {
          expect(tryLease("shared")).toMatchObject({ lease: "refused", code: 33 });
        },
        { mode: "exclusive" },
      );
    }));
  it("removes only the child junction beneath its pinned directory", () =>
    fixture(async (input) => {
      const outside = NodePath.join(NodePath.dirname(input.cwd), "outside");
      await NodeFSP.mkdir(outside);
      await NodeFSP.writeFile(NodePath.join(outside, "sentinel"), "keep");
      await NodeFSP.symlink(outside, NodePath.join(input.cwd, "junction"), "junction");
      const binding = await bindNativeFilePublicationParent(helper!, input.cwd, "");
      await withNativeFilePublicationLease(
        helper!,
        [binding],
        async (lease) => {
          await expect(NodeFSP.rename(input.cwd, `${input.cwd}-old`)).rejects.toThrow();
          await removeNativeRetainedEntry(lease, input.cwd, "junction");
        },
        { mode: "exclusive" },
      );
      expect(await NodeFSP.readFile(NodePath.join(outside, "sentinel"), "utf8")).toBe("keep");
      await expect(NodeFSP.lstat(NodePath.join(input.cwd, "junction"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));
  it("refuses a junction ancestor of the lock-state root before creating a lock directory", () =>
    fixture(async (input) => {
      const outside = NodePath.join(NodePath.dirname(input.cwd), "outside-state");
      const alias = NodePath.join(input.cwd, "state-link");
      await NodeFSP.mkdir(outside);
      await NodeFSP.symlink(outside, alias, "junction");
      const previous = process.env.SCIENT_PUBLICATION_LOCK_ROOT;
      process.env.SCIENT_PUBLICATION_LOCK_ROOT = NodePath.join(alias, "locks");
      try {
        const binding = await bindNativeFilePublicationParent(helper!, input.cwd, "");
        await expect(
          withNativeFilePublicationLease(helper!, [binding], async () => undefined, {
            mode: "exclusive",
          }),
        ).rejects.toThrow();
        await expect(NodeFSP.lstat(NodePath.join(outside, "locks"))).rejects.toMatchObject({
          code: "ENOENT",
        });
      } finally {
        if (previous === undefined) delete process.env.SCIENT_PUBLICATION_LOCK_ROOT;
        else process.env.SCIENT_PUBLICATION_LOCK_ROOT = previous;
      }
    }));
  it("refuses an existing broad directory without changing its policy", () =>
    fixture(async (input) => {
      const broad = NodePath.join(input.cwd, "broad");
      await NodeFSP.mkdir(broad);
      const before = await security(broad);
      await expect(ensureNativePrivateRetentionDirectory(helper!, broad)).rejects.toThrow();
      expect(await security(broad)).toBe(before);
    }));
});

describe.skipIf(!windows)("Windows identity and file admission", () => {
  it("uses the mount-manager GUID and the complete file ID beyond MAX_PATH", () =>
    fixture(async (input) => {
      const cwd = NodePath.join(
        input.cwd,
        ...Array.from({ length: 8 }, (_, index) => `${index}-${"long".repeat(10)}`),
      );
      await NodeFSP.mkdir(cwd, { recursive: true });
      const target = NodePath.join(cwd, "main.tex");
      await NodeFSP.writeFile(target, "original");
      const identity = await platformFileIdentity.directory(cwd);
      expect(identity).toMatchObject({ platform: "windows", version: 1 });
      expect(identity!.volume.startsWith("\\\\?\\Volume{")).toBe(true);
      expect(identity!.fileId).toMatch(/^[0-9a-f]{32}$/u);
      expect((await overleafFilesAvailability([cwd, target])).get(target)).toBe("available");
      const result = await mutateRetainedFile({ ...input, cwd }, target);
      expect(
        result.outcome,
        await NodeFSP.readFile(NodePath.join(result.recordDirectory, "record.json"), "utf8"),
      ).toBe("done");
      expect(await NodeFSP.readFile(target, "utf8")).toBe("incoming");
    }));
  it("stops on enumerated offline attributes before reading or displacing the file", () =>
    fixture(async (input, target) => {
      NodeChildProcess.execFileSync("attrib.exe", ["+O", target]);
      try {
        expect((await overleafFilesAvailability([target])).get(target)).toBe("online-only-file");
        await expect(mutateRetainedFile(input, target)).rejects.toThrow("online-only-file");
      } finally {
        NodeChildProcess.execFileSync("attrib.exe", ["-O", target]);
      }
      expect(await NodeFSP.readFile(target, "utf8")).toBe("original");
    }));
  it("refuses an EFS-encrypted file before changing its bytes or policy", () =>
    fixture(async (input, target) => {
      NodeChildProcess.execFileSync("cipher.exe", ["/e", "/a", target]);
      expect((await windowsNativeFile(target, "flags")).flags & 0x4000).toBe(0x4000);
      const policy = await security(target);
      await expect(mutateRetainedFile(input, target)).rejects.toThrow("encrypted-file");
      expect(await NodeFSP.readFile(target, "utf8")).toBe("original");
      expect(await security(target)).toBe(policy);
    }));
  it("refuses a different owner without changing its bytes or policy", () =>
    fixture(async (input, target) => {
      NodeChildProcess.execFileSync("icacls.exe", [target, "/setowner", "*S-1-5-32-544"]);
      const policy = await security(target);
      await expect(mutateRetainedFile(input, target)).rejects.toThrow("unsupported-file-owner");
      expect(await security(target)).toBe(policy);
      expect(await NodeFSP.readFile(target, "utf8")).toBe("original");
    }));
});

it.skipIf(!windows)(
  "creates a user-owned file even with an elevated Administrators default owner",
  () =>
    fixture(async (input, target) => {
      const owner = (operation: string) =>
        JSON.parse(
          NodeChildProcess.execFileSync(probe!, ["--windows=1", operation, String(process.pid)], {
            encoding: "utf8",
          }),
        ).code;
      await NodeFSP.unlink(target);
      expect(owner("default-owner-admin")).toBe(0);
      try {
        const created = await mutateRetainedFile(
          { ...input, kind: "create", condition: "absent", expectedRevision: null },
          target,
        );
        expect(created.outcome).toBe("done");
        const replaced = await mutateRetainedFile(
          {
            ...input,
            id: "next",
            expectedRevision: bytesRevision(Buffer.from("incoming")),
            bytes: Buffer.from("next"),
          },
          target,
        );
        expect(replaced.outcome).toBe("done");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("next");
      } finally {
        expect(owner("default-owner")).toBe(0);
      }
    }),
);
