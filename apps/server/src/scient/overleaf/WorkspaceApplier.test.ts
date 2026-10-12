import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off
import { fixture } from "./WorkspaceApplier.testkit.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { bytesRevision, fileIdentity } from "../workspace/RetainedFileMutation.ts";
import { type WorkspaceApplyPlan } from "./WorkspaceApplier.ts";
const bytes = (text: string) => Buffer.from(text);
const tree = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([name, text]) => [name, bytesRevision(bytes(text))]));
const plan = (
  captured: Record<string, string>,
  target: Record<string, string>,
  renames: WorkspaceApplyPlan["renames"] = [],
): WorkspaceApplyPlan => ({
  base: tree(captured),
  remote: tree(target),
  captured: tree(captured),
  target: new Map(Object.entries(target).map(([name, text]) => [name, { bytes: bytes(text) }])),
  renames,
  conflicts: [],
  markerPaths: [],
});
async function put(cwd: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, name), text);
  }
}
describe("Overleaf publication admission", () => {
  it.live(
    "refuses unqualified replacement without changing existing manuscript bytes or permissions",
    () =>
      fixture(async (h) => {
        await put(h.cwd, { "main.tex": "A" });
        const target = NodePath.join(h.cwd, "main.tex");
        await NodeFSP.chmod(target, 0o600);
        const identity = await fileIdentity(target);
        await expect(
          h.apply("replace", plan({ "main.tex": "A" }, { "main.tex": "C" })),
        ).rejects.toMatchObject({ _tag: "WorkspaceApplyError" });
        expect(await NodeFSP.readFile(target, "utf8")).toBe("A");
        expect(await fileIdentity(target)).toEqual(identity);
        expect((await NodeFSP.stat(target)).mode & 0o777).toBe(0o600);
      }),
  );
  if (HostProcess.Platform.defaultValue() === "darwin") {
    it.live(
      "publishes a rename destination before retaining its original source and advances the identity",
      () =>
        fixture(async (h) => {
          await put(h.cwd, { "old.tex": "local" });
          const result = await h.apply(
            "rename",
            plan({ "old.tex": "local" }, { "new.tex": "merged" }, [
              { from: "old.tex", to: "new.tex" },
            ]),
          );
          expect(result).toMatchObject({
            outcome: "complete",
            matchesTarget: true,
            interrupted: [],
          });
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "new.tex"), "utf8")).toBe("merged");
          await expect(NodeFSP.lstat(NodePath.join(h.cwd, "old.tex"))).rejects.toMatchObject({
            code: "ENOENT",
          });
          const history = await h.run(
            h.files.listFileVersions({ cwd: h.cwd, relativePath: "old.tex" }),
          );
          expect(
            await Promise.all(
              history.versions.map((version) => NodeFSP.readFile(version.retainedPath, "utf8")),
            ),
          ).toEqual(expect.arrayContaining(["local"]));
        }),
    );
    it.live("replans stale captures before changing any other file", () =>
      fixture(async (h) => {
        await put(h.cwd, { "a.tex": "later", "b.tex": "base" });
        expect(
          await h.apply(
            "stale",
            plan({ "a.tex": "base", "b.tex": "base" }, { "a.tex": "remote", "b.tex": "remote" }),
          ),
        ).toMatchObject({ outcome: "replan" });
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "b.tex"), "utf8")).toBe("base");
      }),
    );
    it.live.each(["file-folder", "folder-file"] as const)(
      "handles %s using only exclusive creates and retained removals",
      (direction) =>
        fixture(async (h) => {
          const before: Record<string, string> =
              direction === "file-folder"
                ? { notes: "old" }
                : { "notes/sub/a.tex": "A", "notes/sub/b.tex": "B" },
            after: Record<string, string> =
              direction === "file-folder"
                ? { "notes/sub/a.tex": "A", "notes/sub/b.tex": "B" }
                : { notes: "new" };
          await put(h.cwd, before);
          const result = await h.apply("structural", plan(before, after));
          expect(result).toMatchObject({
            outcome: "complete",
            matchesTarget: true,
            interrupted: [],
          });
          for (const [name, text] of Object.entries(after))
            expect(await NodeFSP.readFile(NodePath.join(h.cwd, name), "utf8")).toBe(text);
        }),
    );
    it.live.each(["recorded", "after-step", "step-recorded", "base-recorded"] as const)(
      "resumes an addition after %s without replacing outside D",
      (point) => {
        let crash = true;
        return fixture(
          async (h) => {
            await expect(h.apply("add", plan({}, { "main.tex": "C" }))).rejects.toBeTruthy();
            if (point !== "recorded")
              await NodeFSP.writeFile(NodePath.join(h.cwd, "main.tex"), "D");
            await h.restart();
            const result = await h.apply("add");
            if (point === "recorded") {
              expect(result.outcome).toBe("complete");
              expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("C");
            } else {
              expect(result.matchesTarget).toBe(false);
              expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("D");
            }
          },
          {
            at: async (at) => {
              if (at === point && crash) {
                crash = false;
                throw new Error("owned process died");
              }
            },
          },
        );
      },
    );
    it.live("preserves late writes to the actual retained removal object", () =>
      fixture(async (h) => {
        await put(h.cwd, { "main.tex": "A" });
        const handle = await NodeFSP.open(NodePath.join(h.cwd, "main.tex"), "r+");
        try {
          expect((await h.apply("remove", plan({ "main.tex": "A" }, {}))).outcome).toBe("complete");
          await handle.truncate(0);
          await handle.writeFile("late B");
          await handle.sync();
          const history = await h.run(
            h.files.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
          );
          expect(await NodeFSP.readFile(history.versions[0]!.retainedPath, "utf8")).toBe("late B");
        } finally {
          await handle.close();
        }
      }),
    );
    it.live(
      "retires admitted primitive failure to attention instead of automatically blessing the outer plan",
      () => {
        let crash = true;
        return fixture(
          async (h) => {
            await put(h.cwd, { "main.tex": "A" });
            await expect(h.apply("remove", plan({ "main.tex": "A" }, {}))).rejects.toMatchObject({
              _tag: "WorkspaceApplyError",
            });
            await h.restart();
            await expect(h.run(h.files.getMutationEpoch({ cwd: h.cwd }))).rejects.toMatchObject({
              _tag: "WorkspaceFileRecoveryRequiredError",
            });
            const history = await h.run(
              h.files.listFileVersions({ cwd: h.cwd, relativePath: "main.tex" }),
            );
            expect(history.attention).not.toBeNull();
            expect(await NodeFSP.readFile(history.versions[0]!.retainedPath, "utf8")).toBe("A");
          },
          {},
          {
            at: async (point) => {
              if (point === "displaced" && crash) {
                crash = false;
                throw new Error("native retirement failed");
              }
            },
          },
        );
      },
    );
  }
});
