// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { platformFileIdentity } from "./PlatformFileIdentity.ts";
import { bindNativeFilePublication } from "./NativeFilePublication.ts";
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

  it("qualifies loopback ext4/XFS/Btrfs and refuses tmpfs/overlay when root is available", () => {
    const missing = [
      "mkfs.ext4",
      "mkfs.xfs",
      "mkfs.btrfs",
      "mount",
      "setfacl",
      "btrfs",
      "python3",
      "blkid",
      "losetup",
      "udevadm",
    ].filter((command) => NodeChildProcess.spawnSync("which", [command]).status !== 0);
    const root = process.getuid?.() === 0;
    const sudo = !root && NodeChildProcess.spawnSync("sudo", ["-n", "true"]).status === 0;
    if (missing.length || (!root && !sudo)) {
      const reason = `Linux loopback fixtures NOT RUN: missing ${missing.join(", ") || "root or passwordless sudo"}.`;
      if (process.env.CI) throw new Error(reason);
      process.stderr.write(`${reason}\n`);
      return;
    }
    const helper = NodeChildProcess.execFileSync;
    return Promise.all([filePublicationTestHelper(), filePublicationProbeHelper()]).then(
      ([binary, probe]) => {
        const args = [
          NodePath.resolve(
            import.meta.dirname,
            "../../../../../native/file-exchange/linux-fixtures.sh",
          ),
          binary!,
          probe!,
        ];
        const result = root
          ? helper("bash", args, { encoding: "utf8" })
          : helper("sudo", ["-n", "bash", ...args], { encoding: "utf8" });
        expect(result).toContain("PASS Linux btrfs:");
        expect(result).toContain("PASS Linux tmpfs refusal");
        expect(result).toContain("PASS Linux overlay refusal");
        process.stdout.write(result);
      },
    );
  });
});
