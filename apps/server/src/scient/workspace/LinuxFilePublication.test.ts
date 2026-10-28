// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { platformFileIdentity } from "./PlatformFileIdentity.ts";
import {
  bindNativeFilePublication,
  ensureNativePrivateRetentionDirectory,
  nativeLinuxFileIdentity,
} from "./NativeFilePublication.ts";
import {
  filePublicationProbeHelper,
  filePublicationTestHelper,
  nativePublicationHost,
} from "./fileExchange.testkit.ts";
import { bytesRevision, mutateRetainedFile, readRetainedRecord } from "./RetainedFileMutation.ts";

const linux = HostProcess.Platform.defaultValue() === "linux";
const available = !linux || (await nativePublicationHost());
describe.skipIf(!linux || !available)("Linux held-folder publication", () => {
  it("keeps authority on the linked folder after it moves, leaving its replacement untouched", async () => {
    const helper = (await filePublicationProbeHelper())!;
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-linux-authority-")),
    );
    const paper = NodePath.join(root, "paper"),
      records = NodePath.join(root, "records"),
      moved = NodePath.join(root, "moved");
    let child: ReturnType<typeof NodeChildProcess.spawn> | undefined;
    try {
      await NodeFSP.mkdir(paper);
      await NodeFSP.mkdir(records, { mode: 0o700 });
      await NodeFSP.writeFile(NodePath.join(paper, "main.tex"), "old");
      await NodeFSP.writeFile(NodePath.join(records, "slot"), "new");
      const persistent = await platformFileIdentity.directory(paper, undefined, helper);
      expect(persistent).toMatchObject({ version: 1, platform: "linux" });
      const binding = await bindNativeFilePublication(helper, {
        rootPath: paper,
        parentRelativePath: "",
        recordPath: records,
      });
      const ids = [binding.rootIdentity, binding.parentIdentity, binding.recordIdentity].flatMap(
        (id) => [id.dev, id.ino],
      );
      const bound = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      child = NodeChildProcess.spawn(
        helper,
        [
          "--protocol=1",
          "exchange",
          "linux-held-root",
          paper,
          ".",
          records,
          ...ids,
          "slot",
          "main.tex",
        ],
        {
          env: { ...process.env, SCIENT_PUBLICATION_BARRIER: "1" },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.startsWith("BOUND\n")) bound.resolve();
      });
      child.on("error", (error) => {
        bound.reject(error);
        closed.reject(error);
      });
      child.on("close", () => {
        bound.reject(new Error("Helper retired before binding"));
        closed.resolve();
      });
      await bound.promise;
      await NodeFSP.rename(paper, moved);
      await NodeFSP.mkdir(paper);
      await NodeFSP.writeFile(NodePath.join(paper, "main.tex"), "outside replacement");
      expect(await platformFileIdentity.directory(moved, undefined, helper)).toEqual(persistent);
      expect(await platformFileIdentity.directory(paper, undefined, helper)).not.toEqual(
        persistent,
      );
      child.stdin!.end("\n");
      await closed.promise;
      expect(JSON.parse(stdout.slice(stdout.indexOf("\n") + 1))).toMatchObject({
        outcome: "applied",
        containment: "linux-landlock-root-object",
      });
      expect(await NodeFSP.readFile(NodePath.join(moved, "main.tex"), "utf8")).toBe("new");
      expect(await NodeFSP.readFile(NodePath.join(paper, "main.tex"), "utf8")).toBe(
        "outside replacement",
      );
    } finally {
      child?.kill("SIGKILL");
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it("recovers a moved stage by its journaled identity and refuses a same-content replacement", async () => {
    const helper = (await filePublicationTestHelper())!;
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-linux-create-")),
    );
    try {
      const paper = NodePath.join(root, "paper"),
        records = NodePath.join(root, "records"),
        target = NodePath.join(paper, "new.tex");
      await NodeFSP.mkdir(paper);
      await NodeFSP.mkdir(records, { mode: 0o700 });
      const input = {
        cwd: paper,
        relativePath: "new.tex",
        retentionDirectory: records,
        id: "create",
        kind: "create" as const,
        condition: "absent" as const,
        expectedRevision: null,
        bytes: Buffer.from("new"),
        nativePublicationHelper: helper,
      };
      await expect(
        mutateRetainedFile(input, target, {
          at: async (point) => {
            if (point === "called") throw new Error("died after rename");
          },
        }),
      ).rejects.toThrow("died after rename");
      const record = await readRetainedRecord(NodePath.join(records, "create"));
      expect(record).toMatchObject({
        publication: "staged-create",
        desired: bytesRevision(Buffer.from("new")),
      });
      expect((await mutateRetainedFile({ ...input, bytes: undefined }, target)).outcome).toBe(
        "done",
      );
      const second = { ...input, id: "foreign", relativePath: "other.tex" };
      const other = NodePath.join(paper, "other.tex");
      await expect(
        mutateRetainedFile(second, other, {
          at: async (point) => {
            if (point === "called") throw new Error("died");
          },
        }),
      ).rejects.toThrow("died");
      const replacement = NodePath.join(paper, "replacement");
      await NodeFSP.writeFile(replacement, "new");
      await NodeFSP.rename(replacement, other);
      expect((await mutateRetainedFile({ ...second, bytes: undefined }, other)).outcome).toBe(
        "attention",
      );
      expect(await NodeFSP.readFile(other, "utf8")).toBe("new");
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  // CI runs this with passwordless sudo; elsewhere it says why it did not run.
  it("admits ext4, XFS and Btrfs and refuses tmpfs and overlay, on real mounts", async () => {
    const tools = ["mkfs.ext4", "mkfs.xfs", "mkfs.btrfs", "btrfs", "setfacl", "getfacl", "blkid"];
    const missing = tools.filter((tool) => NodeChildProcess.spawnSync("which", [tool]).status);
    if (missing.length > 0 || NodeChildProcess.spawnSync("sudo", ["-n", "true"]).status !== 0) {
      const reason = `Linux filesystem mounts NOT RUN: missing ${missing.join(", ") || "passwordless sudo"}.`;
      if (process.env.CI) throw new Error(reason);
      process.stderr.write(`${reason}\n`);
      return;
    }
    const script = NodePath.resolve(
      import.meta.dirname,
      "../../../../../native/file-exchange/linux-fixtures.sh",
    );
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-linux-filesystems-")),
    );
    const owner = `${process.getuid!()}:${process.getgid!()}`;
    const run = (command: string, args: ReadonlyArray<string>, env = process.env) =>
      NodeChildProcess.execFileSync(command, args, { encoding: "utf8", env }).trim();
    try {
      run("sudo", ["-n", "bash", script, "mount", root, owner]);
      const helper = (await filePublicationTestHelper())!;
      for (const format of ["ext4", "xfs", "btrfs"] as const) {
        const mount = NodePath.join(root, format);
        const found = await nativeLinuxFileIdentity(mount, true, helper);
        expect(found?.reason).toBeNull();
        expect(found?.identity?.volume).toBe(
          run("blkid", ["-s", "UUID", "-o", "value", `${mount}.img`]).toLowerCase(),
        );
        expect(found?.identity?.subvolumeId != null).toBe(format === "btrfs");
        // A retained create, then a replacement, through the production path.
        const paper = NodePath.join(mount, "paper");
        const records = NodePath.join(mount, "records");
        const target = NodePath.join(paper, "main.tex");
        await NodeFSP.mkdir(paper);
        await NodeFSP.mkdir(records, { mode: 0o700 });
        const base = {
          cwd: paper,
          relativePath: "main.tex",
          retentionDirectory: records,
          nativePublicationHelper: helper,
        };
        const created = await mutateRetainedFile(
          {
            ...base,
            id: "create",
            kind: "create",
            condition: "absent",
            expectedRevision: null,
            bytes: Buffer.from("first"),
          },
          target,
        );
        expect(created.outcome).toBe("done");
        const replaced = await mutateRetainedFile(
          {
            ...base,
            id: "write",
            kind: "write",
            condition: "revision",
            expectedRevision: bytesRevision(Buffer.from("first")),
            bytes: Buffer.from("second"),
          },
          target,
        );
        expect(replaced.outcome).toBe("done");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("second");
      }
      // Kept copies in another Btrfs subvolume would not share the manuscript's inodes.
      await expect(
        bindNativeFilePublication(helper, {
          rootPath: NodePath.join(root, "btrfs/paper"),
          parentRelativePath: "",
          recordPath: NodePath.join(root, "btrfs/other-subvolume"),
        }),
      ).rejects.toThrow();
      // A new private folder sheds an inherited default ACL; an existing folder is never repaired.
      const paper = NodePath.join(root, "ext4/paper");
      run("setfacl", ["-m", "d:u:65534:rwx", paper]);
      await ensureNativePrivateRetentionDirectory(helper, NodePath.join(paper, "private"));
      expect(run("getfacl", ["--omit-header", "-d", NodePath.join(paper, "private")])).toBe("");
      await NodeFSP.mkdir(NodePath.join(paper, "existing"), { mode: 0o700 });
      await expect(
        ensureNativePrivateRetentionDirectory(helper, NodePath.join(paper, "existing")),
      ).rejects.toThrow();
      // Without the UUID ioctl the device's UUID link is used, and an ambiguous device refuses.
      const probe = (await filePublicationProbeHelper())!;
      const mount = NodePath.join(root, "ext4");
      const links = NodePath.join(root, "uuid-links");
      await NodeFSP.mkdir(links);
      const device = run("findmnt", ["-no", "SOURCE", mount]);
      const uuid = run("blkid", ["-s", "UUID", "-o", "value", `${mount}.img`]).toLowerCase();
      await NodeFSP.symlink(device, NodePath.join(links, uuid));
      const inquire = () =>
        JSON.parse(
          run(probe, ["--linux-folder=1", mount, "directory"], {
            ...process.env,
            SCIENT_LINUX_UUID_DIRECTORY: links,
          }),
        );
      expect(inquire().identity?.volume).toBe(uuid);
      await NodeFSP.symlink(device, NodePath.join(links, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
      expect(inquire()).toMatchObject({ identity: null, reason: "no-volume-identity" });
      for (const [format, reason] of [
        ["tmpfs", "volatile-filesystem"],
        ["overlay", "unsupported-filesystem"],
      ] as const)
        expect(await nativeLinuxFileIdentity(NodePath.join(root, format), true, helper)).toEqual({
          identity: null,
          reason,
        });
    } finally {
      run("sudo", ["-n", "bash", script, "unmount", root]);
    }
  });
});
