// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  acquireOmpSessionLock,
  makeOmpSessionLockRegistry,
  nodeOmpLockFs,
  releaseOmpSessionLock,
  tryAcquireOmpSessionLockSync,
  type OmpLockFs,
} from "./OmpSessionLock.ts";

let rootCounter = 0;
const makeRoot = (label: string) => {
  const root = NodePath.join(
    NodeOS.tmpdir(),
    `scient-omp-lock-${process.pid}-${label}-${rootCounter++}`,
  );
  NodeFS.rmSync(root, { recursive: true, force: true });
  NodeFS.mkdirSync(root, { recursive: true });
  return NodePath.join(root, "session.lock");
};
const cleanup = (lockPath: string) =>
  NodeFS.rmSync(NodePath.dirname(lockPath), { recursive: true, force: true });
const deadHolder = "2147483646:dead-owner:stale-token";

describe("Oh My Pi session lock", () => {
  it.effect("refuses a second live holder and reclaims a dead holder", () =>
    Effect.gen(function* () {
      const lockPath = makeRoot("holder");
      const registry = makeOmpSessionLockRegistry();
      const first = yield* acquireOmpSessionLock(lockPath, registry);
      expect(yield* acquireOmpSessionLock(lockPath, registry).pipe(Effect.flip)).toBe(
        "This Oh My Pi conversation is already open.",
      );
      yield* releaseOmpSessionLock(first, registry);
      expect(NodeFS.existsSync(lockPath)).toBe(false);

      // A record whose owner is gone is reclaimed, and the reclaiming adapter
      // owns the lock afterwards.
      NodeFS.writeFileSync(lockPath, `${deadHolder}\n`);
      const reclaimed = yield* acquireOmpSessionLock(lockPath, registry);
      expect(NodeFS.readFileSync(lockPath, "utf8").trim()).toBe(reclaimed.token);
      expect(reclaimed.token.startsWith(`${registry.owner}:`)).toBe(true);
      yield* releaseOmpSessionLock(reclaimed, registry);
      expect(NodeFS.existsSync(lockPath)).toBe(false);
      expect(registry.held.size).toBe(0);
      cleanup(lockPath);
    }),
  );

  it.effect("treats a holder that exists but cannot be signalled as live", () =>
    Effect.gen(function* () {
      const lockPath = makeRoot("eperm");
      // PID 1 always exists; an unprivileged kill(1, 0) fails with EPERM, which
      // proves the holder is alive rather than gone.
      NodeFS.writeFileSync(lockPath, "1:foreign-owner:token\n");
      expect(
        yield* acquireOmpSessionLock(lockPath, makeOmpSessionLockRegistry()).pipe(Effect.flip),
      ).toBe("This Oh My Pi conversation is already open.");
      expect(NodeFS.readFileSync(lockPath, "utf8")).toBe("1:foreign-owner:token\n");
      cleanup(lockPath);
    }),
  );

  it.effect("release with a foreign token is a no-op", () =>
    Effect.gen(function* () {
      const lockPath = makeRoot("foreign-release");
      const registry = makeOmpSessionLockRegistry();
      const handle = yield* acquireOmpSessionLock(lockPath, registry);
      // Another owner now holds the conversation (for example after a stale
      // takeover). Releasing our old handle must not delete its record.
      const foreign = `${process.pid}:another-adapter:live-token`;
      NodeFS.writeFileSync(lockPath, `${foreign}\n`);
      yield* releaseOmpSessionLock(handle, registry);
      expect(NodeFS.readFileSync(lockPath, "utf8").trim()).toBe(foreign);
      expect(registry.held.has(lockPath)).toBe(false);
      // Releasing twice stays a no-op.
      yield* releaseOmpSessionLock(handle, registry);
      expect(NodeFS.readFileSync(lockPath, "utf8").trim()).toBe(foreign);
      cleanup(lockPath);
    }),
  );

  it.effect("keeps same-process locks of another adapter and reclaims its own leftovers", () =>
    Effect.gen(function* () {
      const lockPath = makeRoot("same-pid");
      const mine = makeOmpSessionLockRegistry();
      const other = makeOmpSessionLockRegistry();
      const otherHandle = yield* acquireOmpSessionLock(lockPath, other);
      // Another adapter in this server process may own a live session here.
      expect(yield* acquireOmpSessionLock(lockPath, mine).pipe(Effect.flip)).toBe(
        "This Oh My Pi conversation is already open.",
      );
      yield* releaseOmpSessionLock(otherHandle, other);

      // A record this adapter wrote but no longer tracks has no live owner.
      NodeFS.writeFileSync(lockPath, `${mine.owner}:leftover\n`);
      const reclaimed = yield* acquireOmpSessionLock(lockPath, mine);
      expect(NodeFS.readFileSync(lockPath, "utf8").trim()).toBe(reclaimed.token);
      // While the handle is registered, the adapter's own record is live.
      expect(yield* acquireOmpSessionLock(lockPath, mine).pipe(Effect.flip)).toBe(
        "This Oh My Pi conversation is already open.",
      );
      yield* releaseOmpSessionLock(reclaimed, mine);
      cleanup(lockPath);
    }),
  );

  it.effect("concurrent stale takeovers produce exactly one winner at every interleaving", () =>
    Effect.gen(function* () {
      let interleavings = 0;
      for (let step = 0; step < 12; step += 1) {
        const lockPath = makeRoot(`race-${step}`);
        NodeFS.writeFileSync(lockPath, `${deadHolder}\n`);
        const first = makeOmpSessionLockRegistry();
        const second = makeOmpSessionLockRegistry();
        let secondResult: "acquired" | "busy" | undefined;
        let secondToken: string | undefined;
        let operation = 0;
        // Run the second contender's whole acquisition just before the first
        // contender's step-th filesystem operation.
        const interleave = <A>(run: () => A): A => {
          if (operation++ === step) {
            interleavings += 1;
            const result = tryAcquireOmpSessionLockSync(lockPath, second);
            secondResult = result === "busy" ? "busy" : "acquired";
            if (result !== "busy") secondToken = result.token;
          }
          return run();
        };
        const racingFs: OmpLockFs = {
          writeExclusive: (file, contents) =>
            interleave(() => nodeOmpLockFs.writeExclusive(file, contents)),
          read: (file) => interleave(() => nodeOmpLockFs.read(file)),
          identity: (file) => interleave(() => nodeOmpLockFs.identity(file)),
          rename: (from, to) => interleave(() => nodeOmpLockFs.rename(from, to)),
          link: (from, to) => interleave(() => nodeOmpLockFs.link(from, to)),
          remove: (file) => interleave(() => nodeOmpLockFs.remove(file)),
        };
        const exit = yield* acquireOmpSessionLock(lockPath, first, racingFs).pipe(Effect.exit);
        const firstToken = exit._tag === "Success" ? exit.value.token : undefined;
        const winners = [firstToken, secondToken].filter((token) => token !== undefined);
        if (secondResult !== undefined) {
          expect(winners).toHaveLength(1);
          expect(NodeFS.readFileSync(lockPath, "utf8").trim()).toBe(winners[0]);
        } else {
          expect(firstToken).toBeDefined();
        }
        // No renamed-aside record is left behind.
        expect(
          NodeFS.readdirSync(NodePath.dirname(lockPath)).filter(
            (entry) => entry !== "session.lock",
          ),
        ).toEqual([]);
        cleanup(lockPath);
      }
      expect(interleavings).toBeGreaterThanOrEqual(5);
    }),
  );
  it("keeps one owner when two other contenders interleave stale recovery", () => {
    for (let secondStep = 0; secondStep < 20; secondStep += 1) {
      for (let thirdStep = secondStep + 1; thirdStep < 24; thirdStep += 1) {
        const lockPath = makeRoot(`three-${secondStep}-${thirdStep}`);
        NodeFS.writeFileSync(lockPath, `${deadHolder}\n`);
        const first = makeOmpSessionLockRegistry();
        const second = makeOmpSessionLockRegistry();
        const third = makeOmpSessionLockRegistry();
        const winners: string[] = [];
        let operation = 0;
        const interleave = <A>(run: () => A): A => {
          const step = operation++;
          const registry = step === secondStep ? second : step === thirdStep ? third : undefined;
          if (registry) {
            const result = tryAcquireOmpSessionLockSync(lockPath, registry);
            if (result !== "busy") winners.push(result.token);
          }
          return run();
        };
        const racingFs: OmpLockFs = {
          writeExclusive: (file, contents) =>
            interleave(() => nodeOmpLockFs.writeExclusive(file, contents)),
          read: (file) => interleave(() => nodeOmpLockFs.read(file)),
          identity: (file) => interleave(() => nodeOmpLockFs.identity(file)),
          rename: (from, to) => interleave(() => nodeOmpLockFs.rename(from, to)),
          link: (from, to) => interleave(() => nodeOmpLockFs.link(from, to)),
          remove: (file) => interleave(() => nodeOmpLockFs.remove(file)),
        };
        try {
          const result = tryAcquireOmpSessionLockSync(lockPath, first, racingFs);
          if (result !== "busy") winners.push(result.token);
          expect(winners).toHaveLength(1);
          expect(NodeFS.readFileSync(lockPath, "utf8").trim()).toBe(winners[0]);
          expect(NodeFS.readdirSync(NodePath.dirname(lockPath))).toEqual(["session.lock"]);
        } finally {
          cleanup(lockPath);
        }
      }
    }
  });
  it("recovers when a stale-lock reclaimer crashed while holding its claim", () => {
    const lockPath = makeRoot("crashed-reclaimer");
    const digest = NodeCrypto.createHash("sha256")
      .update(`${lockPath}\0${deadHolder}`)
      .digest("hex");
    const claim = NodePath.join(NodePath.dirname(lockPath), `.omp-reclaim-${digest}`);
    NodeFS.writeFileSync(lockPath, `${deadHolder}\n`);
    NodeFS.writeFileSync(claim, `${deadHolder}\n`);
    try {
      const result = tryAcquireOmpSessionLockSync(lockPath, makeOmpSessionLockRegistry());
      expect(result).not.toBe("busy");
      expect(NodeFS.readdirSync(NodePath.dirname(lockPath))).toEqual(["session.lock"]);
    } finally {
      cleanup(lockPath);
    }
  });

  it("does not reclaim an incomplete legacy record", () => {
    const lockPath = makeRoot("incomplete-legacy");
    NodeFS.writeFileSync(lockPath, "");
    try {
      expect(tryAcquireOmpSessionLockSync(lockPath, makeOmpSessionLockRegistry())).toBe("busy");
      expect(NodeFS.readFileSync(lockPath, "utf8")).toBe("");
    } finally {
      cleanup(lockPath);
    }
  });

  it.effect("reclaims an abandoned empty or corrupt lock after the publication grace", () =>
    Effect.gen(function* () {
      for (const contents of ["", "corrupt\n"]) {
        const lockPath = makeRoot("abandoned-incomplete");
        NodeFS.writeFileSync(lockPath, contents);
        NodeFS.utimesSync(lockPath, 1, 1);
        try {
          const registry = makeOmpSessionLockRegistry();
          const acquired = tryAcquireOmpSessionLockSync(lockPath, registry);
          expect(acquired).not.toBe("busy");
          if (acquired !== "busy") {
            expect(NodeFS.readFileSync(lockPath, "utf8").trim()).toBe(acquired.token);
            yield* releaseOmpSessionLock(acquired, registry);
          }
        } finally {
          cleanup(lockPath);
        }
      }
    }),
  );
});
