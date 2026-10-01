// @effect-diagnostics nodeBuiltinImport:off - the tests stall individual file system calls.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { EnvironmentFilePath } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { resolveEnvironmentFileLink } from "./EnvironmentFileLinkResolve.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    realpath: vi.fn(actual.realpath),
    stat: vi.fn(actual.stat),
  };
});
const native = await vi.importActual<typeof NodeFSP>("node:fs/promises");

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(NodeFSP.lstat).mockImplementation(native.lstat);
  vi.mocked(NodeFSP.realpath).mockImplementation(native.realpath);
  vi.mocked(NodeFSP.stat).mockImplementation(native.stat);
  for (const root of roots.splice(0)) await native.rm(root, { recursive: true, force: true });
});

const never = () => new Promise<never>(() => {});
const BOUND_MS = 150;

/** A workspace holding `candidate/victim.md`; the link `missing/victim.md` does not exist. */
const makeWorkspace = Effect.promise(async () => {
  const workspace = await native.realpath(
    await native.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-link-stall-")),
  );
  roots.push(workspace);
  await native.mkdir(NodePath.join(workspace, "candidate"));
  await native.writeFile(NodePath.join(workspace, "candidate/victim.md"), "x\n");
  return workspace;
});

const resolveTimed = (workspace: string, link: string) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const result = yield* resolveEnvironmentFileLink(
      { workspaceRoot: EnvironmentFilePath.make(workspace), path: EnvironmentFilePath.make(link) },
      { maxDirectories: 1_000, deadlineMs: BOUND_MS },
    );
    return { result, elapsedMs: (yield* Clock.currentTimeMillis) - started };
  });

describe("resolveEnvironmentFileLink when a file system call never returns", () => {
  it.effect("opens the link as written when its own location cannot be examined in time", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace;
      const link = NodePath.join(workspace, "missing/victim.md");
      vi.mocked(NodeFSP.lstat).mockImplementation(((path: string, ...rest: []) =>
        String(path) === link ? never() : native.lstat(path, ...rest)) as typeof NodeFSP.lstat);

      const { result, elapsedMs } = yield* resolveTimed(workspace, "missing/victim.md");
      expect(result).toEqual({ _tag: "literal", path: link });
      expect(elapsedMs).toBeLessThan(2_000);
    }).pipe(TestClock.withLive),
  );

  it.effect("is incomplete when the workspace root cannot be resolved in time", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace;
      vi.mocked(NodeFSP.realpath).mockImplementation(((path: string, ...rest: []) =>
        String(path) === workspace
          ? never()
          : native.realpath(path, ...rest)) as typeof NodeFSP.realpath);

      const { result, elapsedMs } = yield* resolveTimed(workspace, "missing/victim.md");
      expect(result).toMatchObject({ _tag: "incomplete", paths: [] });
      expect(elapsedMs).toBeLessThan(2_000);
    }).pipe(TestClock.withLive),
  );

  it.effect("is incomplete, not a match, when the found file cannot be re-checked in time", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace;
      const candidate = NodePath.join(workspace, "candidate/victim.md");
      vi.mocked(NodeFSP.lstat).mockImplementation(((path: string, ...rest: []) =>
        String(path) === candidate
          ? never()
          : native.lstat(path, ...rest)) as typeof NodeFSP.lstat);

      const { result, elapsedMs } = yield* resolveTimed(workspace, "missing/victim.md");
      expect(result).toMatchObject({ _tag: "incomplete", paths: [] });
      expect(elapsedMs).toBeLessThan(2_000);
    }).pipe(TestClock.withLive),
  );

  it.effect("recovers the file when nothing stalls", () =>
    Effect.gen(function* () {
      const workspace = yield* makeWorkspace;
      const { result } = yield* resolveTimed(workspace, "missing/victim.md");
      expect(result).toMatchObject({ _tag: "recovered", path: "candidate/victim.md" });
    }).pipe(TestClock.withLive),
  );
});
