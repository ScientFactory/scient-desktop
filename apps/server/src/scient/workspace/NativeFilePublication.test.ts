// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { filePublicationTestHelper } from "./fileExchange.testkit.ts";
import {
  bindNativeFilePublicationParent,
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
