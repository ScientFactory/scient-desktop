import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off
import { fixture } from "./WorkspaceApplier.testkit.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { bytesRevision, fileIdentity } from "../workspace/RetainedFileMutation.ts";
import type { WorkspaceApplyPlan } from "./WorkspaceApplier.ts";
const bytes = (value: string) => Buffer.from(value);
const tree = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([name, value]) => [name, bytesRevision(bytes(value))]));
const plan = (
  captured: Record<string, string>,
  target: Record<string, string>,
): WorkspaceApplyPlan => ({
  base: tree(captured),
  remote: tree(target),
  captured: tree(captured),
  target: new Map(Object.entries(target).map(([name, value]) => [name, { bytes: bytes(value) }])),
  renames: [],
  conflicts: [],
  markerPaths: [],
});
async function put(cwd: string, files: Record<string, string>) {
  for (const [name, value] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, name), value);
  }
}

describe("WorkspaceApplier immutable intent and original receipt regressions", () => {
  if (HostProcess.Platform.defaultValue() === "darwin") {
    it.live(
      "resumes a persisted removal plan without replaying its original deletion over outside D",
      () => {
        let crash = true;
        return fixture(
          async (h) => {
            await put(h.cwd, { "a.tex": "A" });
            await expect(h.apply("intent", plan({ "a.tex": "A" }, {}))).rejects.toMatchObject({
              _tag: "WorkspaceApplyError",
            });
            expect(await NodeFSP.readFile(NodePath.join(h.cwd, "a.tex"), "utf8")).toBe("A");
            await h.restart();
            expect((await h.apply("intent")).outcome).toBe("complete");
            await put(h.cwd, { "a.tex": "outside D" });
            await h.restart();
            expect((await h.apply("intent")).matchesTarget).toBe(false);
            expect(await NodeFSP.readFile(NodePath.join(h.cwd, "a.tex"), "utf8")).toBe("outside D");
            const history = await h.run(
              h.files.listFileVersions({ cwd: h.cwd, relativePath: "a.tex" }),
            );
            expect(
              await Promise.all(
                history.versions.map((version) => NodeFSP.readFile(version.retainedPath, "utf8")),
              ),
            ).toContain("A");
          },
          {
            at: async (point) => {
              if (point === "plan-recorded" && crash) {
                crash = false;
                throw new Error("process died after durable plan");
              }
            },
          },
        );
      },
    );
    it.live("refuses missing or altered immutable intent without touching later source data", () =>
      fixture(async (h) => {
        await h.apply("altered", plan({}, {}));
        await put(h.cwd, { "a.tex": "outside D" });
        const file = NodePath.join(h.owner, "altered/plan.json"),
          original = await NodeFSP.readFile(file, "utf8");
        await NodeFSP.writeFile(file, original + " ");
        await expect(h.apply("altered")).rejects.toMatchObject({ _tag: "WorkspaceApplyError" });
        await NodeFSP.unlink(file);
        await expect(h.apply("altered", plan({}, {}))).rejects.toMatchObject({
          _tag: "WorkspaceApplyError",
        });
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "a.tex"), "utf8")).toBe("outside D");
      }),
    );
    it.live(
      "leaves a newly changed removal target on its old base while retaining completed units",
      () => {
        let cwd = "",
          changed = false;
        return fixture(
          async (h) => {
            cwd = h.cwd;
            await put(cwd, { "a.tex": "A", "b.tex": "B" });
            const requested = plan({ "a.tex": "A", "b.tex": "B" }, {});
            const result = await h.apply("skip", requested);
            expect(result.outcome).toBe("attention");
            expect(result.base.has("a.tex")).toBe(false);
            expect(result.base.get("b.tex")).toBe(requested.base.get("b.tex"));
            expect(await NodeFSP.readFile(NodePath.join(cwd, "b.tex"), "utf8")).toBe("outside D");
            await expect(NodeFSP.lstat(NodePath.join(cwd, "a.tex"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            await h.restart();
            expect((await h.apply("skip")).outcome).toBe("attention");
            expect(await NodeFSP.readFile(NodePath.join(cwd, "b.tex"), "utf8")).toBe("outside D");
          },
          {
            at: async (point, name) => {
              if (point === "before-step" && name === "b.tex" && !changed) {
                changed = true;
                await NodeFSP.writeFile(NodePath.join(cwd, name), "outside D");
              }
            },
          },
        );
      },
    );
    it.live("does not change an existing inode or executable policy for unchanged bytes", () =>
      fixture(async (h) => {
        await put(h.cwd, { "main.tex": "A" });
        const file = NodePath.join(h.cwd, "main.tex");
        await NodeFSP.chmod(file, 0o600);
        const identity = await fileIdentity(file);
        const requested = {
          ...plan({ "main.tex": "A" }, { "main.tex": "A" }),
          target: new Map([["main.tex", { bytes: bytes("A"), executable: true }]]),
        };
        expect((await h.apply("same", requested)).outcome).toBe("complete");
        expect(await fileIdentity(file)).toEqual(identity);
        expect((await NodeFSP.stat(file)).mode & 0o777).toBe(0o600);
      }),
    );
    it.live(
      "keeps an ambiguous creation at attention rather than blessing a foreign same-content inode",
      () => {
        let cwd = "",
          crash = true;
        return fixture(
          async (h) => {
            cwd = h.cwd;
            await expect(
              h.apply("create-gap", plan({}, { "main.tex": "C" })),
            ).rejects.toMatchObject({ _tag: "WorkspaceApplyError" });
            await put(cwd, { "main.tex": "C" });
            const foreign = await fileIdentity(NodePath.join(cwd, "main.tex"));
            await h.restart();
            await expect(h.apply("create-gap")).rejects.toMatchObject({
              _tag: "WorkspaceApplyError",
            });
            expect(await fileIdentity(NodePath.join(cwd, "main.tex"))).toEqual(foreign);
            expect(await NodeFSP.readFile(NodePath.join(cwd, "main.tex"), "utf8")).toBe("C");
            const history = await h.run(
              h.files.listFileVersions({ cwd, relativePath: "main.tex" }),
            );
            expect(history.attention).not.toBeNull();
            expect(
              await Promise.all(
                history.versions.map((version) => NodeFSP.readFile(version.retainedPath, "utf8")),
              ),
            ).toContain("C");
          },
          {},
          {
            at: async (point) => {
              if (point === "install-intent" && crash) {
                crash = false;
                throw new Error("process died before native creation receipt");
              }
            },
          },
        );
      },
    );
  }
});
