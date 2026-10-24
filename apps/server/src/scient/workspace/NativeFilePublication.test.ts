// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";
import {
  bindNativeFilePublicationParent,
  ensureNativePrivateRetentionDirectory,
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
  it("are the binding the helper gives", () =>
    inScratch("scient-observed-binding-", async (root) => {
      const folder = NodePath.join(root, "folder");
      await NodeFSP.mkdir(folder);
      const observed = await observedDirectoryBinding(helper!, folder);
      const native = await bindNativeFilePublicationParent(helper!, folder, "");
      expect(observed).toEqual(native);
    }));

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
