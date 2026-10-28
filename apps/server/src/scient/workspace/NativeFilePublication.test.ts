// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it, vi } from "@effect/vitest";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";
import {
  bindNativeFilePublicationParent,
  ensureNativePrivateRetentionDirectory,
  checkNativePrivateRetentionDirectory,
  closeNativeHelperServers,
  invokeNativeHelper,
  nativeFilePublicationCapabilities,
  observedDirectoryBinding,
  withNativeFilePublicationLease,
} from "./NativeFilePublication.ts";

const helper = await filePublicationTestHelper();

it.skipIf(helper === undefined)(
  "retires cancelled queued acquisition without hiding cancellation or releasing another holder",
  async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-lease-cancel-")),
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const operations: Promise<unknown>[] = [];
    const abort = new AbortController();
    let queuedEntered = false;
    let successorEntered = false;
    try {
      const binding = await bindNativeFilePublicationParent(helper!, root, ".");
      const holder = withNativeFilePublicationLease(
        helper!,
        [binding],
        async () => {
          entered.resolve();
          await release.promise;
        },
        { mode: "exclusive" },
      );
      operations.push(holder);
      await entered.promise;
      const queued = withNativeFilePublicationLease(
        helper!,
        [binding],
        async () => {
          queuedEntered = true;
        },
        { mode: "exclusive", signal: abort.signal },
      );
      operations.push(queued);
      const rejected = expect(queued).rejects.toThrow("Publication lease acquisition cancelled.");
      abort.abort();
      await rejected;
      expect(queuedEntered).toBe(false);
      const successor = withNativeFilePublicationLease(
        helper!,
        [binding],
        async () => {
          successorEntered = true;
        },
        { mode: "exclusive" },
      );
      operations.push(successor);
      expect(successorEntered).toBe(false);
      release.resolve();
      await holder;
      await successor;
      expect(successorEntered).toBe(true);
      expect(queuedEntered).toBe(false);
    } finally {
      abort.abort();
      release.resolve();
      await Promise.allSettled(operations);
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

const posix = HostProcess.Platform.defaultValue() !== "win32";

/** A scratch folder, canonical, removed after `body`. */
const inScratch = async (prefix: string, body: (root: string) => Promise<void>) => {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)),
  );
  try {
    await body(root);
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
};

/**
 * A stand-in helper that records each run in `runs` and prints `reply`, or
 * fails when `reply` is null.
 */
const fakeHelper = async (root: string, name: string, reply: string | null) => {
  const path = NodePath.join(root, name);
  const runs = NodePath.join(root, `${name}.runs`);
  await NodeFSP.writeFile(
    path,
    `#!/bin/sh\necho run >> '${runs}'\n${reply === null ? "exit 3" : `printf '%s\\n' '${reply}'`}\n`,
    { mode: 0o700 },
  );
  return {
    path,
    runs: () =>
      NodeFSP.readFile(runs, "utf8").then(
        (text) => text.split("\n").filter(Boolean).length,
        () => 0,
      ),
  };
};
const capabilitiesReply = (atomicExchange: boolean) =>
  `{"version":1,"strictCurrentRoot":true,"containment":"bound-object","atomicExchange":${atomicExchange},"atomicPublicationMetadata":true,"atomicCreateMetadata":false,"exclusiveMove":true,"exclusiveLink":true,"publicationLease":true,"sharedPublicationLease":true,"privateRetentionDirectory":true,"sourceParentMkdir":true,"codeDomain":"errno"}`;

describe.skipIf(helper === undefined || !posix)("directory bindings observed in process", () => {
  it.each(["", "folder"])(
    "observes %j without a helper inquiry and matches the native binding",
    (relative) =>
      inScratch("scient-observed-binding-", async (root) => {
        await NodeFSP.mkdir(NodePath.join(root, "folder"));
        const refusing = await fakeHelper(root, "helper-refusing-bind", null);
        const observed = await bindNativeFilePublicationParent(refusing.path, root, relative);
        const native = JSON.parse(
          NodeChildProcess.execFileSync(
            helper!,
            [
              "--directory=1",
              "bind",
              HostProcess.Platform.defaultValue() === "linux"
                ? "linux-held-root"
                : "strict-current-root",
              root,
              relative || ".",
              "-",
              "-",
              "-",
              "-",
              "-",
            ],
            { encoding: "utf8" },
          ),
        );
        expect(native.code).toBe(0);
        expect(native.binding.root).toMatchObject(observed.rootIdentity);
        expect(native.binding.parent).toMatchObject(observed.parentIdentity);
        expect(await refusing.runs()).toBe(0);
      }),
  );

  it.each(["root", "parent"])("refuses a nested observation after its %s is replaced", (replaced) =>
    inScratch("scient-observed-binding-", async (root) => {
      const folder = NodePath.join(root, "folder");
      const parent = NodePath.join(folder, "parent");
      await NodeFSP.mkdir(parent, { recursive: true });
      const observed = await bindNativeFilePublicationParent(helper!, folder, "parent");
      const target = replaced === "root" ? folder : parent;
      await NodeFSP.rename(target, `${target}-moved`);
      await NodeFSP.mkdir(parent, { recursive: true });
      let entered = false;
      await expect(
        withNativeFilePublicationLease(
          helper!,
          [observed],
          async () => {
            entered = true;
          },
          { mode: "exclusive" },
        ),
      ).rejects.toThrow();
      expect(entered).toBe(false);
    }),
  );

  it("leave a path through a link to the helper, which refuses it as before", () =>
    inScratch("scient-observed-binding-", async (root) => {
      await NodeFSP.mkdir(NodePath.join(root, "real"));
      await NodeFSP.mkdir(NodePath.join(root, "real", "inner"));
      await NodeFSP.symlink(NodePath.join(root, "real"), NodePath.join(root, "link"));
      const through = NodePath.join(root, "link", "inner");
      await expect(bindNativeFilePublicationParent(helper!, through, "")).rejects.toThrow();
      await expect(observedDirectoryBinding(helper!, through)).rejects.toThrow();
    }));

  it("are checked natively when the lease is taken: a replaced folder refuses it", () =>
    inScratch("scient-observed-binding-", async (root) => {
      const folder = NodePath.join(root, "folder");
      await NodeFSP.mkdir(folder);
      const observed = await observedDirectoryBinding(helper!, folder);
      await NodeFSP.rename(folder, NodePath.join(root, "moved"));
      await NodeFSP.mkdir(folder);
      let entered = false;
      await expect(
        withNativeFilePublicationLease(
          helper!,
          [observed],
          async () => {
            entered = true;
          },
          { mode: "exclusive" },
        ),
      ).rejects.toThrow();
      expect(entered).toBe(false);
    }));
});

describe.skipIf(!posix)("helper answers that are reused", () => {
  it("asks the same helper about the same root once", () =>
    inScratch("scient-capabilities-", async (root) => {
      const fake = await fakeHelper(root, "helper-once", capabilitiesReply(true));
      expect((await nativeFilePublicationCapabilities(fake.path, root)).atomicExchange).toBe(true);
      expect((await nativeFilePublicationCapabilities(fake.path, root)).atomicExchange).toBe(true);
      expect(await fake.runs()).toBe(1);
      // Another root, or none, is another question.
      await nativeFilePublicationCapabilities(fake.path);
      expect(await fake.runs()).toBe(2);
    }));

  it("asks a replaced helper again", () =>
    inScratch("scient-capabilities-", async (root) => {
      const first = await fakeHelper(root, "helper-replaced", capabilitiesReply(true));
      expect((await nativeFilePublicationCapabilities(first.path, root)).atomicExchange).toBe(true);
      const second = await fakeHelper(root, "helper-replaced", capabilitiesReply(false));
      expect((await nativeFilePublicationCapabilities(second.path, root)).atomicExchange).toBe(
        false,
      );
      expect(await second.runs()).toBe(2);
    }));

  it.skipIf(helper === undefined)(
    "asks the helper about a private folder once while it stays as it was, and again after a change",
    () =>
      inScratch("scient-private-retention-", async (root) => {
        // A helper that refuses everything: reaching it fails the call.
        const refusing = await fakeHelper(root, "helper-refusing", null);
        const ready = NodePath.join(root, "ready");
        await NodeFSP.mkdir(ready, { mode: 0o700 });
        // Mode bits alone are not enough: the real helper looks first.
        await expect(ensureNativePrivateRetentionDirectory(refusing.path, ready)).rejects.toThrow();
        expect(await ensureNativePrivateRetentionDirectory(helper!, ready)).toBe(ready);
        const runs = await refusing.runs();
        expect(await ensureNativePrivateRetentionDirectory(refusing.path, ready)).toBe(ready);
        expect(await refusing.runs()).toBe(runs);
        // A change to its metadata (here the same mode again) asks the helper again.
        await NodeFSP.chmod(ready, 0o700);
        await expect(ensureNativePrivateRetentionDirectory(refusing.path, ready)).rejects.toThrow();
        // Open to others, or missing: provisioning (the helper) decides, as before.
        const open = NodePath.join(root, "open");
        await NodeFSP.mkdir(open);
        await NodeFSP.chmod(open, 0o755);
        await expect(ensureNativePrivateRetentionDirectory(refusing.path, open)).rejects.toThrow();
        await expect(
          ensureNativePrivateRetentionDirectory(refusing.path, NodePath.join(root, "missing")),
        ).rejects.toThrow();
        expect(await refusing.runs()).toBeGreaterThanOrEqual(runs + 3);
      }),
  );

  it.skipIf(helper === undefined || HostProcess.Platform.defaultValue() !== "darwin")(
    "refuses a 0700 folder an access list opens to everyone, also one found private before",
    () =>
      inScratch("scient-private-retention-", async (root) => {
        const openToAll = (folder: string) =>
          NodeChildProcess.execFileSync("/bin/chmod", [
            "+a",
            "everyone allow list,search,read,readattr,readextattr,readsecurity,file_inherit,directory_inherit",
            folder,
          ]);
        const fresh = NodePath.join(root, "fresh");
        await NodeFSP.mkdir(fresh, { mode: 0o700 });
        openToAll(fresh);
        await expect(ensureNativePrivateRetentionDirectory(helper!, fresh)).rejects.toThrow();
        const known = NodePath.join(root, "known");
        await NodeFSP.mkdir(known, { mode: 0o700 });
        expect(await ensureNativePrivateRetentionDirectory(helper!, known)).toBe(known);
        openToAll(known);
        expect((await NodeFSP.stat(known)).mode & 0o077).toBe(0);
        await expect(ensureNativePrivateRetentionDirectory(helper!, known)).rejects.toThrow();
      }),
  );
});

it.skipIf(helper === undefined)(
  "never creates a recorded private directory while checking it",
  async () => {
    const root = await NodeFSP.realpath(
      await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-private-check-")),
    );
    const recorded = NodePath.join(root, "recorded");
    try {
      await expect(checkNativePrivateRetentionDirectory(helper!, recorded)).rejects.toThrow(
        "refused",
      );
      await expect(NodeFSP.lstat(recorded)).rejects.toMatchObject({ code: "ENOENT" });
      await ensureNativePrivateRetentionDirectory(helper!, recorded);
      await checkNativePrivateRetentionDirectory(helper!, recorded);
      await NodeFSP.rename(recorded, NodePath.join(root, "moved"));
      await expect(checkNativePrivateRetentionDirectory(helper!, recorded)).rejects.toThrow(
        "refused",
      );
      await expect(NodeFSP.lstat(recorded)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  },
);

/**
 * A stand-in for the Windows helper: `--serve=1` answers framed questions until its
 * input ends, except that a question about "stuck" is never answered; any other run
 * answers its own question once.
 */
const fakeServingHelper = async (root: string) => {
  const path = NodePath.join(root, "helper-serving");
  await NodeFSP.writeFile(
    path,
    `#!${process.execPath}
if (process.argv[2] !== "--serve=1") {
  process.stdout.write("launched " + process.argv[4] + "\\n");
  process.exit(0);
}
let input = Buffer.alloc(0), stuck = false;
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= 4 + input.readUInt32BE(0)) {
    const args = input.subarray(4, 4 + input.readUInt32BE(0)).toString().split("\\0");
    input = input.subarray(4 + input.readUInt32BE(0));
    if (args[2] === "stuck") stuck = true;
    if (!stuck) process.stdout.write("served " + args[2] + "\\n" + '{"version":1,"served":0}' + "\\n");
  }
});
process.stdin.on("end", () => {
  process.stderr.write("left while stuck");
  process.exit(0);
});
`,
    { mode: 0o700 },
  );
  return path;
};

describe.skipIf(!posix)("the long-lived Windows helper", () => {
  it("launches a question on its own while the helper is busy, so none waits behind another", () =>
    inScratch("scient-served-", async (root) => {
      using _host = vi.spyOn(HostProcess.Platform, "defaultValue").mockReturnValue("win32");
      const helper = await fakeServingHelper(root);
      const info = (path: string) => invokeNativeHelper(helper, ["--windows=1", "info", path]);
      expect(await info("first")).toBe("served first\n");
      const stuck = info("stuck");
      expect(await info("second")).toBe("launched second\n");
      const closing = closeNativeHelperServers();
      await expect(stuck).rejects.toThrow(/server exit=0, stderr=left while stuck/u);
      await closing;
      expect(await info("after")).toBe("served after\n");
      await closeNativeHelperServers();
    }));
});
