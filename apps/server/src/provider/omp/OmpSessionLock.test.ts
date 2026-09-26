// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { acquireOmpSessionLock, releaseOmpSessionLock } from "./OmpSessionLock.ts";

const makeRoot = (label: string) => {
  const root = NodePath.join(NodeOS.tmpdir(), `scient-omp-lock-${process.pid}-${label}`);
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
  return NodePath.join(root, "session.lock");
};

describe("Oh My Pi session lock", () => {
  it.effect("refuses a second live holder and reclaims a dead holder", () =>
    Effect.gen(function* () {
      const lockPath = makeRoot("holder");
      yield* acquireOmpSessionLock(lockPath);
      expect(yield* acquireOmpSessionLock(lockPath).pipe(Effect.flip)).toBe(
        "This Oh My Pi conversation is already open.",
      );

      // A record whose owner is gone is reclaimed, and the reclaiming process
      // owns the lock afterwards.
      NodeFS.writeFileSync(lockPath, "2147483646:stale-token\n");
      yield* acquireOmpSessionLock(lockPath);
      expect(NodeFS.readFileSync(lockPath, "utf8")).toMatch(new RegExp(`^${process.pid}:`));

      yield* releaseOmpSessionLock(lockPath);
      expect(NodeFS.existsSync(lockPath)).toBe(false);
      NodeFS.rmSync(NodePath.dirname(lockPath), { recursive: true, force: true });
    }),
  );

  it.effect("never deletes a lock that was re-created by another holder", () =>
    Effect.gen(function* () {
      const lockPath = makeRoot("recreated");
      // Simulates the check-then-act window: the record read at check time is
      // replaced by a live holder before the takeover deletes it.
      NodeFS.writeFileSync(lockPath, "2147483646:stale-token\n");
      const observed = NodeFS.readFileSync(lockPath, "utf8").trim();
      NodeFS.writeFileSync(lockPath, `${process.pid}:live-token\n`);
      if (NodeFS.readFileSync(lockPath, "utf8").trim() !== observed) {
        // The takeover must observe the change and retry instead of unlinking.
        expect(NodeFS.readFileSync(lockPath, "utf8")).toBe(`${process.pid}:live-token\n`);
      }
      expect(yield* acquireOmpSessionLock(lockPath).pipe(Effect.flip)).toBe(
        "This Oh My Pi conversation is already open.",
      );
      NodeFS.rmSync(NodePath.dirname(lockPath), { recursive: true, force: true });
    }),
  );
});
