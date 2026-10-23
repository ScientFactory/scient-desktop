// @effect-diagnostics nodeBuiltinImport:off
/**
 * Cases from the independent reviews of #486, restored after #353 moved the
 * applier onto the shared file layer. The applier publishes only through the
 * native helper, so these run where that helper qualifies.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeDiagnosticsChannel from "node:diagnostics_channel";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  filePublicationTestHelper,
  nativePublicationHost,
} from "../workspace/fileExchange.testkit.ts";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import { advanceBase } from "./syncRules.ts";
import { WorkspaceFileSystem } from "../../workspace/WorkspaceFileSystem.ts";
import { make, type WorkspaceApplyPlan } from "./WorkspaceApplier.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";

const canPublish = await nativePublicationHost();
const bytes = (value: string | Buffer) => Buffer.from(value);
const tree = (files: Record<string, string | Buffer>) =>
  new Map(Object.entries(files).map(([name, value]) => [name, bytesRevision(bytes(value))]));
const plan = (
  captured: Record<string, string | Buffer>,
  target: Record<string, string | Buffer>,
  renames: WorkspaceApplyPlan["renames"] = [],
  markerPaths: string[] = [],
): WorkspaceApplyPlan => ({
  base: tree(captured),
  remote: tree(target),
  captured: tree(captured),
  target: new Map(Object.entries(target).map(([name, value]) => [name, { bytes: bytes(value) }])),
  renames,
  conflicts: [],
  markerPaths,
});
async function put(cwd: string, files: Record<string, string | Buffer>) {
  for (const [name, value] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, name)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, name), value);
  }
}
const read = (cwd: string, name: string) => NodeFSP.readFile(NodePath.join(cwd, name), "utf8");

describe.skipIf(!canPublish)("WorkspaceApplier review cases", () => {
  describe("renames", () => {
    const recoveryCases = (
      ["recorded", "after-step", "step-recorded", "base-recorded"] as const
    ).flatMap((point) => [false, true].map((later) => ({ point, later })));
    it.live.each(recoveryCases)(
      "recovers a rename after $point, later=$later",
      ({ point, later }) => {
        let once = false;
        return fixture(
          async (h) => {
            await put(h.cwd, { "old.tex": "base" });
            const p = plan({ "old.tex": "base" }, { "new.tex": "merged" }, [
              { from: "old.tex", to: "new.tex" },
            ]);
            await expect(h.apply("crash", p)).rejects.toBeTruthy();
            if (later) await put(h.cwd, { "new.tex": "later" });
            await h.restart();
            const result = await h.apply("crash");
            if (later && point !== "base-recorded") {
              expect([...result.base]).toEqual([...p.base]);
              expect(await read(h.cwd, "old.tex")).toBe("base");
            } else expect([...result.base]).toEqual([...p.remote]);
            if (later) expect(await read(h.cwd, "new.tex")).toBe("later");
            else expect(result).toMatchObject({ outcome: "complete", matchesTarget: true });
          },
          {
            at: async (at) => {
              if (at === point && !once) {
                once = true;
                throw new Error("synthetic crash");
              }
            },
          },
        );
      },
    );

    it.live("leaves an interrupted rename's entire base unchanged", () => {
      let folder = "";
      return fixture(
        async (h) => {
          folder = h.cwd;
          await put(h.cwd, { "old.tex": "base" });
          const result = await h.apply(
            "partial",
            plan({ "old.tex": "base" }, { "new.tex": "remote" }, [
              { from: "old.tex", to: "new.tex" },
            ]),
          );
          expect(result).toMatchObject({
            outcome: "attention",
            interrupted: [["old.tex", "new.tex"]],
          });
          expect([...result.base]).toEqual([...tree({ "old.tex": "base" })]);
          expect(await read(h.cwd, "old.tex")).toBe("later");
        },
        {
          at: async (point, name) => {
            if (point === "before-step" && name === "old.tex")
              await NodeFSP.writeFile(NodePath.join(folder, "old.tex"), "later");
          },
        },
      );
    });

    it.live.each(["delete", "replace"])(
      "interrupts a recovered rename when its destination has a later %s",
      (change) => {
        let crash = true;
        return fixture(
          async (h) => {
            await put(h.cwd, { "old.tex": "base" });
            const p = plan({ "old.tex": "base" }, { "new.tex": "merged" }, [
              { from: "old.tex", to: "new.tex" },
            ]);
            await expect(h.apply("destination-change", p)).rejects.toBeTruthy();
            if (change === "delete") await NodeFSP.unlink(NodePath.join(h.cwd, "new.tex"));
            else await put(h.cwd, { "new.tex": "later" });
            await h.restart();
            const result = await h.apply("destination-change");
            expect(result.outcome).toBe("attention");
            expect(result.interrupted).toHaveLength(1);
            expect(result.base).toEqual(p.base);
            expect(await read(h.cwd, "old.tex")).toBe("base");
          },
          {
            at: async (point, name) => {
              if (point === "step-recorded" && name === "new.tex" && crash) {
                crash = false;
                throw new Error("crash");
              }
            },
          },
        );
      },
    );

    it.live("guards an unchanged rename destination before deleting its source", () => {
      let folder = "";
      return fixture(
        async (h) => {
          folder = h.cwd;
          const before = { "old.tex": "old", "new.tex": "merged" };
          await put(h.cwd, before);
          const p = plan(before, { "new.tex": "merged" }, [{ from: "old.tex", to: "new.tex" }]);
          const result = await h.apply("unchanged-destination", p);
          expect(result.outcome).toBe("attention");
          expect(result.base).toEqual(p.base);
          expect(await read(h.cwd, "old.tex")).toBe("old");
        },
        {
          at: async (point, name) => {
            if (point === "before-step" && name === "old.tex")
              await NodeFSP.unlink(NodePath.join(folder, "new.tex"));
          },
        },
      );
    });

    const modelCases = (["after-step", "step-recorded"] as const).flatMap((point) =>
      (["none", "source-edit", "destination-edit", "destination-delete"] as const).map(
        (action) => ({ point, action }),
      ),
    );
    it.live.each(modelCases)(
      "agrees with the grouped base model after $point and $action",
      ({ point, action }) => {
        let crash = true;
        return fixture(
          async (h) => {
            const before = { "old.tex": "captured local" },
              after = { "new.tex": "merged remote" };
            const renames = [{ from: "old.tex", to: "new.tex" }];
            const p = plan(before, after, renames);
            await put(h.cwd, before);
            await expect(h.apply("model", p)).rejects.toBeTruthy();
            if (action === "source-edit") await put(h.cwd, { "old.tex": "late local" });
            if (action === "destination-edit") await put(h.cwd, { "new.tex": "late local" });
            if (action === "destination-delete")
              await NodeFSP.unlink(NodePath.join(h.cwd, "new.tex"));
            await h.restart();
            const actual = await h.apply("model");
            const expected = advanceBase({
              before: p.base,
              remote: p.remote,
              renames,
              undonePaths: action === "none" ? [] : ["old.tex", "new.tex"],
            });
            expect([...actual.base]).toEqual([...expected]);
            expect(actual.outcome).toBe(action === "none" ? "complete" : "attention");
            if (action !== "none") expect(actual.interrupted).toHaveLength(1);
            if (action === "source-edit") expect(await read(h.cwd, "old.tex")).toBe("late local");
            if (action === "destination-edit")
              expect(await read(h.cwd, "new.tex")).toBe("late local");
            if (action === "destination-delete")
              expect(await read(h.cwd, "old.tex")).toBe("captured local");
          },
          {
            at: async (at, name) => {
              if (at === point && name === "new.tex" && crash) {
                crash = false;
                throw new Error("crash");
              }
            },
          },
        );
      },
    );

    it.live.each(["after-step", "displaced"] as const)(
      "recovers a completed removal before outer progress at %s",
      (point) => {
        let crash = true;
        return fixture(
          async (h) => {
            await put(h.cwd, { "old.tex": "old", "new.tex": "merged" });
            const p = plan({ "old.tex": "old", "new.tex": "merged" }, { "new.tex": "merged" }, [
              { from: "old.tex", to: "new.tex" },
            ]);
            await expect(h.apply("hidden-remove", p)).rejects.toBeTruthy();
            await put(h.cwd, { "new.tex": "later" });
            await h.restart();
            const result = await h.apply("hidden-remove");
            expect(result.interrupted).toEqual([["old.tex", "new.tex"]]);
            expect(result.base).toEqual(p.base);
            expect(await read(h.cwd, "new.tex")).toBe("later");
          },
          {
            at: async (at) => {
              if (point === "after-step" && at === point && crash) {
                crash = false;
                throw new Error("crash");
              }
            },
          },
          {
            at: async (at) => {
              if (point === "displaced" && at === point && crash) {
                crash = false;
                throw new Error("crash");
              }
            },
          },
        );
      },
    );
  });

  describe("crash recovery", () => {
    const sequences = (["rename", "file-folder", "folder-file", "binary"] as const).flatMap(
      (scenario) =>
        (["after-step", "step-recorded"] as const).flatMap((point) =>
          [1, 2].map((position) => ({ scenario, point, position })),
        ),
    );
    it.live.each(sequences)(
      "resumes $scenario after $point at step $position",
      ({ scenario, point, position }) => {
        let steps = 0,
          crashed = false;
        return fixture(
          async (h) => {
            let before: Record<string, string>, after: Record<string, string>;
            if (scenario === "rename") {
              before = { "old.tex": "local edit" };
              after = { "new.tex": "local edit + remote" };
            } else if (scenario === "file-folder") {
              before = { notes: "local edit" };
              after = { "notes/a.tex": "local edit", "notes/b.tex": "remote" };
            } else if (scenario === "folder-file") {
              before = { "notes/a.tex": "local edit", "notes/b.tex": "remote" };
              after = { notes: "merged" };
            } else {
              before = { "a.bin": "\0local", "b.bin": "\0base" };
              after = { "a.bin": "\0merged", "b.bin": "\0remote" };
            }
            await put(h.cwd, before);
            const p = plan(
              before,
              after,
              scenario === "rename" ? [{ from: "old.tex", to: "new.tex" }] : [],
            );
            await expect(h.apply("sequence", p)).rejects.toBeTruthy();
            await h.restart();
            const recovered = await h.apply("sequence");
            expect(recovered).toMatchObject({
              outcome: "complete",
              matchesTarget: true,
              interrupted: [],
            });
            expect([...recovered.base]).toEqual([...tree(after)]);
          },
          {
            at: async (at) => {
              if (at === point && ++steps === position && !crashed) {
                crashed = true;
                throw new Error("crash");
              }
            },
          },
        );
      },
    );

    it.live("keeps a structural source recoverable across a crash", () => {
      let crash = true;
      return fixture(
        async (h) => {
          await put(h.cwd, { notes: "original" });
          await expect(
            h.apply(
              "structural-stage",
              plan({ notes: "original" }, { "notes/sub/a.tex": "remote" }),
            ),
          ).rejects.toBeTruthy();
          await h.restart();
          const result = await h.apply("structural-stage");
          expect(result).toMatchObject({ outcome: "complete", matchesTarget: true });
          expect(await read(h.cwd, "notes/sub/a.tex")).toBe("remote");
          const history = await h.run(
            h.files.listFileVersions({ cwd: h.cwd, relativePath: "notes" }),
          );
          expect(
            await Promise.all(
              history.versions.map((version) => NodeFSP.readFile(version.retainedPath, "utf8")),
            ),
          ).toContain("original");
        },
        {
          at: async (point, name) => {
            if (point === "after-step" && name === "notes" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        },
      );
    });

    it.live("interrupts a structural replay if its blocker was recreated", () => {
      let once = true;
      return fixture(
        async (h) => {
          const before = { notes: "old" },
            after = { "notes/a.tex": "new" };
          await put(h.cwd, before);
          const p = plan(before, after);
          await expect(h.apply("recreated-blocker", p)).rejects.toBeTruthy();
          await put(h.cwd, { notes: "later" });
          await h.restart();
          const result = await h.apply("recreated-blocker");
          expect(result.outcome).toBe("attention");
          expect(result.base).toEqual(p.base);
          expect(await read(h.cwd, "notes")).toBe("later");
        },
        {
          at: async (point, name) => {
            if (point === "step-recorded" && name === "notes" && once) {
              once = false;
              throw new Error("crash");
            }
          },
        },
      );
    });

    it.live("recovers a manuscript path named __proto__ without losing journal keys", () => {
      let once = true;
      return fixture(
        async (h) => {
          const before = Object.fromEntries([["__proto__", "base"]]),
            after = Object.fromEntries([["__proto__", "remote"]]);
          await put(h.cwd, before);
          await expect(h.apply("proto-key", plan(before, after))).rejects.toBeTruthy();
          await h.restart();
          expect(await h.apply("proto-key")).toMatchObject({
            outcome: "complete",
            matchesTarget: true,
          });
        },
        {
          at: async (point) => {
            if (point === "step-recorded" && once) {
              once = false;
              throw new Error("crash");
            }
          },
        },
      );
    });

    it.live("writes the payload once and keeps progress small across steps and resume", () => {
      let owner = "";
      let immutable: { ino: number; mtimeMs: number } | undefined;
      let checks = 0;
      return fixture(
        async (h) => {
          owner = h.owner;
          const captured: Record<string, Buffer> = {},
            target: Record<string, Buffer> = {};
          for (let index = 0; index < 20; index++) {
            captured[`fig${index}.pdf`] = Buffer.alloc(1024 * 1024, index);
            target[`fig${index}.pdf`] = Buffer.alloc(1024 * 1024, index + 100);
          }
          await put(h.cwd, captured);
          expect((await h.apply("big", plan(captured, target))).outcome).toBe("complete");
          expect(checks).toBe(22);
          await h.restart();
          expect((await h.apply("big")).outcome).toBe("complete");
          const stat = await NodeFSP.stat(NodePath.join(owner, "big/plan.json"));
          expect(stat.ino).toBe(immutable!.ino);
          expect(stat.mtimeMs).toBe(immutable!.mtimeMs);
        },
        {
          at: async (point) => {
            if (!["recorded", "step-recorded", "base-recorded"].includes(point)) return;
            const stat = await NodeFSP.stat(NodePath.join(owner, "big/plan.json"));
            expect(stat.size).toBeGreaterThan(20 * 1024 * 1024);
            immutable ??= { ino: stat.ino, mtimeMs: stat.mtimeMs };
            expect(stat.ino).toBe(immutable.ino);
            expect(stat.mtimeMs).toBe(immutable.mtimeMs);
            const progress = await NodeFSP.readFile(NodePath.join(owner, "big/apply.json"), "utf8");
            expect(Buffer.byteLength(progress)).toBeLessThan(32 * 1024);
            expect(JSON.parse(progress)).not.toHaveProperty("plan");
            checks++;
          },
        },
      );
    });

    it.live("resumes a crash after intent persistence without rewriting the payload", () => {
      let crash = true;
      return fixture(
        async (h) => {
          await put(h.cwd, { "a.tex": "base" });
          await expect(
            h.apply("intent", plan({ "a.tex": "base" }, { "a.tex": "remote" })),
          ).rejects.toBeTruthy();
          expect(await read(h.cwd, "a.tex")).toBe("base");
          const before = await NodeFSP.stat(NodePath.join(h.owner, "intent/plan.json"));
          await h.restart();
          expect((await h.apply("intent")).outcome).toBe("complete");
          expect((await NodeFSP.stat(NodePath.join(h.owner, "intent/plan.json"))).ino).toBe(
            before.ino,
          );
        },
        {
          at: async (point) => {
            if (point === "plan-recorded" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        },
      );
    });

    it.live.each([false, true])(
      "upgrades a version 1 record, interrupted=%s, without replaying over a later write",
      (interrupt) => {
        let armed = false;
        return fixture(
          async (h) => {
            await put(h.cwd, { "a.tex": "base" });
            await h.apply("legacy", plan({ "a.tex": "base" }, { "a.tex": "remote" }));
            const directory = NodePath.join(h.owner, "legacy");
            const intent = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "plan.json"), "utf8"),
            );
            const saved = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "apply.json"), "utf8"),
            );
            const { intentRevision: _revision, ...oldProgress } = saved;
            await NodeFSP.writeFile(
              NodePath.join(directory, "apply.json"),
              JSON.stringify({ ...intent, ...oldProgress, version: 1 }),
            );
            await NodeFSP.unlink(NodePath.join(directory, "plan.json"));
            armed = interrupt;
            if (interrupt) await expect(h.apply("legacy")).rejects.toBeTruthy();
            await put(h.cwd, { "a.tex": "later" });
            await h.restart();
            expect((await h.apply("legacy")).outcome).toBe("attention");
            expect(await read(h.cwd, "a.tex")).toBe("later");
            expect(
              JSON.parse(await NodeFSP.readFile(NodePath.join(directory, "apply.json"), "utf8")),
            ).toMatchObject({ version: 2 });
          },
          {
            at: async (point) => {
              if (point === "plan-recorded" && armed) {
                armed = false;
                throw new Error("upgrade crash");
              }
            },
          },
        );
      },
    );

    const guarded = (paths: [string, string]) => ({
      paths,
      types: ["content"],
      origins: ["merge" as const],
    });
    it.live("recovers a publication not yet in outer progress", () => {
      let crash = true;
      return fixture(
        async (h) => {
          await put(h.cwd, { "a.tex": "base", "guard.tex": "guard" });
          const p = {
            ...plan(
              { "a.tex": "base", "guard.tex": "guard" },
              { "a.tex": "remote", "guard.tex": "guard" },
            ),
            conflicts: [guarded(["a.tex", "guard.tex"])],
          };
          await expect(h.apply("hidden-exchange", p)).rejects.toBeTruthy();
          await put(h.cwd, { "guard.tex": "later" });
          await h.restart();
          const result = await h.apply("hidden-exchange");
          expect(result.interrupted).toEqual([["a.tex", "guard.tex"]]);
          expect(result.base).toEqual(p.base);
          expect(await read(h.cwd, "guard.tex")).toBe("later");
        },
        {},
        {
          at: async (point) => {
            if (point === "displaced" && crash) {
              crash = false;
              throw new Error("crash");
            }
          },
        },
      );
    });

    // #486 kept such a unit out of conflict after a crash. Since #353 a failure inside
    // the native publication retires its record for review, so the unit is reported;
    // what must hold is that nothing changed and nothing later is overwritten.
    it.live.each(["intent", "prepared"] as const)(
      "changes nothing and keeps a later edit after a failure at %s",
      (at) => {
        let crash = true;
        return fixture(
          async (h) => {
            await put(h.cwd, { "a.tex": "base", "guard.tex": "guard" });
            const p = {
              ...plan(
                { "a.tex": "base", "guard.tex": "guard" },
                { "a.tex": "remote", "guard.tex": "guard" },
              ),
              conflicts: [guarded(["a.tex", "guard.tex"])],
            };
            await expect(h.apply("staging-only", p)).rejects.toBeTruthy();
            await put(h.cwd, { "guard.tex": "later" });
            await h.restart();
            const result = await h.apply("staging-only");
            expect(result).toMatchObject({
              outcome: "attention",
              interrupted: [["a.tex", "guard.tex"]],
            });
            expect(result.base).toEqual(p.base);
            expect(await read(h.cwd, "a.tex")).toBe("base");
            expect(await read(h.cwd, "guard.tex")).toBe("later");
          },
          {},
          {
            at: async (point) => {
              if (point === at && crash) {
                crash = false;
                throw new Error("crash");
              }
            },
          },
        );
      },
    );

    it.live.each(["none", "replace", "delete"] as const)(
      "recognizes an installed addition after a later target change: %s",
      (change) => {
        let crash = true;
        return fixture(
          async (h) => {
            await put(h.cwd, { "guard.tex": "guard" });
            const p = {
              ...plan({ "guard.tex": "guard" }, { "a.tex": "remote", "guard.tex": "guard" }),
              conflicts: [guarded(["a.tex", "guard.tex"])],
            };
            await expect(h.apply("hidden-addition", p)).rejects.toBeTruthy();
            if (change === "replace") {
              await NodeFSP.writeFile(NodePath.join(h.cwd, "replacement"), "later target");
              await NodeFSP.rename(
                NodePath.join(h.cwd, "replacement"),
                NodePath.join(h.cwd, "a.tex"),
              );
            } else if (change === "delete") await NodeFSP.unlink(NodePath.join(h.cwd, "a.tex"));
            await put(h.cwd, { "guard.tex": "later" });
            await h.restart();
            const result = await h.apply("hidden-addition");
            expect(result.interrupted).toEqual([["a.tex", "guard.tex"]]);
            expect(result.base).toEqual(p.base);
            expect(await read(h.cwd, "guard.tex")).toBe("later");
          },
          {},
          {
            at: async (point) => {
              if (point === "installed" && crash) {
                crash = false;
                throw new Error("crash");
              }
            },
          },
        );
      },
    );

    it.live.each(["replace", "delete"] as const)(
      "does not replay an installed addition after a later %s",
      (change) => {
        let crash = true;
        return fixture(
          async (h) => {
            await expect(
              h.apply("add-replay", plan({}, { "a.tex": "remote" })),
            ).rejects.toBeTruthy();
            if (change === "replace") {
              await NodeFSP.writeFile(NodePath.join(h.cwd, "replacement"), "later target");
              await NodeFSP.rename(
                NodePath.join(h.cwd, "replacement"),
                NodePath.join(h.cwd, "a.tex"),
              );
            } else await NodeFSP.unlink(NodePath.join(h.cwd, "a.tex"));
            await h.restart();
            expect((await h.apply("add-replay")).outcome).toBe("attention");
            if (change === "replace") expect(await read(h.cwd, "a.tex")).toBe("later target");
            else
              await expect(NodeFSP.stat(NodePath.join(h.cwd, "a.tex"))).rejects.toMatchObject({
                code: "ENOENT",
              });
          },
          {},
          {
            at: async (point) => {
              if (point === "installed" && crash) {
                crash = false;
                throw new Error("crash");
              }
            },
          },
        );
      },
    );
    it.live.each(["replace", "delete"] as const)(
      "refuses to replay a replacement over a later %s after a failure at installed",
      (change) => {
        let crash = true;
        return fixture(
          async (h) => {
            await put(h.cwd, { "a.tex": "base" });
            await expect(
              h.apply("replace-replay", plan({ "a.tex": "base" }, { "a.tex": "remote" })),
            ).rejects.toBeTruthy();
            if (change === "replace") {
              await NodeFSP.writeFile(NodePath.join(h.cwd, "replacement"), "later target");
              await NodeFSP.rename(
                NodePath.join(h.cwd, "replacement"),
                NodePath.join(h.cwd, "a.tex"),
              );
            } else await NodeFSP.unlink(NodePath.join(h.cwd, "a.tex"));
            await h.restart();
            expect((await h.apply("replace-replay")).outcome).toBe("attention");
            if (change === "replace") expect(await read(h.cwd, "a.tex")).toBe("later target");
            else
              await expect(NodeFSP.stat(NodePath.join(h.cwd, "a.tex"))).rejects.toMatchObject({
                code: "ENOENT",
              });
          },
          {},
          {
            at: async (point) => {
              if (point === "installed" && crash) {
                crash = false;
                throw new Error("crash");
              }
            },
          },
        );
      },
    );
  });

  describe("guards", () => {
    it.live("checks only recorded marker files, not ordinary Markdown headings", () =>
      fixture(async (h) => {
        await put(h.cwd, { "paper.tex": "base", "readme.md": "old" });
        const result = await h.apply(
          "markers",
          plan(
            { "paper.tex": "base", "readme.md": "old" },
            {
              "paper.tex": "<<<<<<< Scient\nmine\n=======\ntheirs\n>>>>>>> Overleaf\n",
              "readme.md": "Title\n=======\n",
            },
            [],
            ["paper.tex"],
          ),
        );
        expect(result).toMatchObject({ outcome: "attention", markerPaths: ["paper.tex"] });
        await NodeFSP.writeFile(NodePath.join(h.cwd, "paper.tex"), "resolved\n");
        expect(await h.apply("markers")).toMatchObject({ markerPaths: [] });
      }),
    );

    it.live("rejects a changed id's plan and corrupt durable state", () =>
      fixture(async (h) => {
        await h.apply("record", plan({}, {}));
        await expect(h.apply("record", plan({}, { "new.tex": "new" }))).rejects.toBeTruthy();
        await NodeFSP.writeFile(NodePath.join(h.owner, "record/apply.json"), "{}");
        await expect(h.apply("record")).rejects.toBeTruthy();
      }),
    );

    it.live("rejects a parent link before the mutation", () =>
      fixture(async (h) => {
        await NodeFSP.mkdir(NodePath.join(h.root, "outside"));
        await NodeFSP.symlink(NodePath.join(h.root, "outside"), NodePath.join(h.cwd, "chapters"));
        await expect(
          h.apply("link", plan({}, { "chapters/new.tex": "remote" })),
        ).rejects.toBeTruthy();
        expect(await NodeFSP.readdir(NodePath.join(h.root, "outside"))).toEqual([]);
      }),
    );

    it.live("refuses a root replaced by a link after preflight", () => {
      let folder = "",
        outside = "";
      return fixture(
        async (h) => {
          folder = h.cwd;
          outside = NodePath.join(h.root, "outside");
          await put(h.cwd, { "main.tex": "base" });
          await put(outside, { "main.tex": "base" });
          await expect(
            h.apply("root-link", plan({ "main.tex": "base" }, { "main.tex": "remote" })),
          ).rejects.toBeTruthy();
          expect(await read(outside, "main.tex")).toBe("base");
        },
        {
          at: async (point) => {
            if (point === "before-step") {
              await NodeFSP.rename(folder, `${folder}-old`);
              await NodeFSP.symlink(outside, folder);
            }
          },
        },
      );
    });

    // The file layer binds the root it finds; only the applier knows the root it planned for.
    it.live("refuses a root replaced by a regular folder at the file layer's entry", () =>
      fixture(async (h) => {
        await put(h.cwd, { "a.tex": "base" });
        let once = true;
        const substituting = {
          ...h.files,
          replaceFileRetained: (input: Parameters<typeof h.files.replaceFileRetained>[0]) =>
            Effect.gen(function* () {
              if (once) {
                once = false;
                yield* Effect.promise(async () => {
                  await NodeFSP.rename(h.cwd, `${h.cwd}-old`);
                  await put(h.cwd, { "a.tex": "base" });
                });
              }
              return yield* h.files.replaceFileRetained(input);
            }),
        };
        const applier = await h.run(
          make().pipe(Effect.provideService(WorkspaceFileSystem, substituting)),
        );
        await expect(
          h.run(
            applier.apply({
              cwd: h.cwd,
              applicationDirectory: h.owner,
              id: "substituted-root",
              plan: plan({ "a.tex": "base" }, { "a.tex": "remote" }),
            }),
          ),
        ).rejects.toBeTruthy();
        expect(await read(h.cwd, "a.tex")).toBe("base");
      }),
    );

    it.live("does not confuse manuscript names with Object.prototype", () =>
      fixture(async (h) => {
        await put(h.cwd, { constructor: "local", toString: "base" });
        expect(
          await h.apply(
            "prototype-names",
            plan(
              { constructor: "local", toString: "base" },
              { constructor: "incoming", "new.tex": "new" },
            ),
          ),
        ).toMatchObject({ outcome: "complete", matchesTarget: true });
      }),
    );

    it.live("handles nested folder replacement and a rename into a blocked subtree", () =>
      fixture(async (h) => {
        await put(h.cwd, { "notes/sub/a.tex": "A" });
        expect(
          (await h.apply("nested", plan({ "notes/sub/a.tex": "A" }, { notes: "B" }))).outcome,
        ).toBe("complete");
        await put(h.cwd, { a: "A", b: "B" });
        const result = await h.apply(
          "blocked-rename",
          plan({ a: "A", b: "B" }, { "b/x": "A" }, [{ from: "a", to: "b/x" }]),
        );
        expect(result.outcome).toBe("complete");
        expect(await read(h.cwd, "b/x")).toBe("A");
      }),
    );

    it.live("keeps an untouched skipped file on its old base without a forced conflict", () => {
      let cwd = "";
      return fixture(
        async (h) => {
          cwd = h.cwd;
          await put(cwd, { "a.tex": "base a", "b.tex": "base b" });
          const p = plan(
            { "a.tex": "base a", "b.tex": "base b" },
            { "a.tex": "remote a", "b.tex": "remote b" },
          );
          const result = await h.apply("skip", p);
          expect(result).toMatchObject({ outcome: "attention", interrupted: [] });
          expect(result.base.get("a.tex")).toBe(p.remote.get("a.tex"));
          expect(result.base.get("b.tex")).toBe(p.base.get("b.tex"));
          expect(await read(cwd, "b.tex")).toBe("later local edit");
          await h.restart();
          expect((await h.apply("skip")).interrupted).toEqual([]);
        },
        {
          at: async (point, name) => {
            if (point === "before-step" && name === "b.tex")
              await NodeFSP.writeFile(NodePath.join(cwd, name), "later local edit");
          },
        },
      );
    });

    it.live("keeps an unchanged file's executable bit while another file changes", () =>
      fixture(async (h) => {
        await put(h.cwd, { "main.tex": "base", latexmkrc: "$pdf_mode = 1;" });
        await NodeFSP.chmod(NodePath.join(h.cwd, "latexmkrc"), 0o755);
        await NodeFSP.chmod(NodePath.join(h.cwd, "main.tex"), 0o755);
        const p = plan(
          { "main.tex": "base", latexmkrc: "$pdf_mode = 1;" },
          { "main.tex": "remote", latexmkrc: "$pdf_mode = 1;" },
        );
        const executable = {
          ...p,
          target: new Map(p.target).set("main.tex", { bytes: bytes("remote"), executable: true }),
        };
        expect((await h.apply("exec", executable)).outcome).toBe("complete");
        expect((await NodeFSP.stat(NodePath.join(h.cwd, "latexmkrc"))).mode & 0o111).toBe(0o111);
        expect(await read(h.cwd, "main.tex")).toBe("remote");
      }),
    );
  });

  describe("editor saves", () => {
    it.live("checks an editor save's revision after an overlapping apply", () => {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
          entered = resolve;
        }),
        hold = new Promise<void>((resolve) => {
          release = resolve;
        });
      let once = false;
      return fixture(
        async (h) => {
          await put(h.cwd, { "main.tex": "base" });
          const applying = h.apply(
            "locked",
            plan({ "main.tex": "base" }, { "main.tex": "incoming" }),
          );
          let saving: Promise<unknown> | undefined;
          try {
            // An apply that fails before holding the lock ends the test at once.
            await Promise.race([
              started,
              applying.then(() => {
                throw new Error("The apply finished before holding the lock.");
              }),
            ]);
            const helper = await filePublicationTestHelper();
            if (!helper) throw new Error("The native publication helper is required.");
            const root = await NodeFSP.stat(h.cwd, { bigint: true });
            const expectedBinding = [
              h.cwd,
              ".",
              String(root.dev),
              String(root.ino),
              String(root.dev),
              String(root.ino),
              "exclusive",
            ];
            const requested = Promise.withResolvers<void>();
            using observer = new DisposableStack();
            const onChild = (message: unknown) => {
              if (
                typeof message !== "object" ||
                message === null ||
                !("process" in message) ||
                !(message.process instanceof NodeChildProcess.ChildProcess)
              )
                return;
              const child = message.process;
              // The diagnostics channel publishes before spawnfile/spawnargs are populated.
              const onSpawn = () => {
                const args = child.spawnargs;
                if (child.spawnfile !== helper || args[1] !== "--lease=1" || args[2] !== "shared")
                  return;
                for (let offset = 3; offset + 6 < args.length; offset += 7) {
                  if (!expectedBinding.every((value, index) => args[offset + index] === value))
                    continue;
                  requested.resolve();
                  return;
                }
              };
              const onError = (error: Error) => requested.reject(error);
              child.once("spawn", onSpawn);
              child.once("error", onError);
              observer.defer(() => {
                child.removeListener("spawn", onSpawn);
                child.removeListener("error", onError);
              });
            };
            NodeDiagnosticsChannel.subscribe("child_process", onChild);
            observer.defer(() => {
              NodeDiagnosticsChannel.unsubscribe("child_process", onChild);
            });
            const save = h.run(
              Effect.result(
                h.files.writeFile({
                  cwd: h.cwd,
                  relativePath: "main.tex",
                  contents: "editor draft",
                  expectedRevision: bytesRevision(bytes("base")),
                }),
              ),
            );
            saving = save;
            // Lease requests are complete in argv. Observe the real request's successful
            // spawn while the apply is held, then check the editor's revision after release.
            await Promise.race([
              requested.promise,
              save.then(() => {
                throw new Error("The editor save finished before its lease request was observed.");
              }),
            ]);
            release();
            await applying;
            expect(await save).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "WorkspaceFileRevisionConflictError" },
            });
          } finally {
            release();
            await Promise.allSettled(saving ? [applying, saving] : [applying]);
          }
          expect(await read(h.cwd, "main.tex")).toBe("incoming");
          await h.run(
            h.files.writeFile({
              cwd: h.cwd,
              relativePath: "main.tex",
              contents: "editor after",
              expectedRevision: bytesRevision(bytes("incoming")),
            }),
          );
          expect(await read(h.cwd, "main.tex")).toBe("editor after");
        },
        {},
        {
          at: async (point) => {
            if (point === "checked" && !once) {
              once = true;
              entered();
              await hold;
            }
          },
        },
      );
    });

    it.live("never overwrites an editor save completed just before apply", () => {
      let saveBefore = async () => {};
      return fixture(
        async (h) => {
          saveBefore = async () => {
            await h.run(
              h.files.writeFile({
                cwd: h.cwd,
                relativePath: "main.tex",
                contents: "editor draft",
                expectedRevision: bytesRevision(bytes("base")),
              }),
            );
          };
          await put(h.cwd, { "main.tex": "base" });
          const result = await h.apply(
            "save-first",
            plan({ "main.tex": "base" }, { "main.tex": "incoming" }),
          );
          expect(result.outcome).toBe("attention");
          expect(await read(h.cwd, "main.tex")).toBe("editor draft");
        },
        {
          at: async (point) => {
            if (point === "before-step") await saveBefore();
          },
        },
      );
    });

    it.live("lists a late edit through a held handle after restoration", () => {
      let folder = "",
        handle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
      return fixture(
        async (h) => {
          folder = h.cwd;
          await put(h.cwd, { "main.tex": "base" });
          try {
            const result = await h.apply(
              "staged-handle",
              plan({ "main.tex": "base" }, { "main.tex": "remote" }),
            );
            expect(result.outcome).toBe("attention");
            // The direct write is put back, and the staged copy the handle reached is kept.
            expect(await read(h.cwd, "main.tex")).toBe("direct A");
            const kept = await Promise.all(
              result.retained
                .filter((retained) => retained.changed && retained.retainedPath !== null)
                .map((retained) => NodeFSP.readFile(retained.retainedPath!, "utf8")),
            );
            expect(kept).toContain("late staged edit");
          } finally {
            await handle?.close();
          }
        },
        {
          at: async (point) => {
            if (point === "after-step") {
              await handle!.truncate(0);
              await handle!.writeFile("late staged edit");
              await handle!.sync();
            }
          },
        },
        {
          at: async (point) => {
            if (point === "checked")
              await NodeFSP.writeFile(NodePath.join(folder, "main.tex"), "direct A");
            if (point === "displaced")
              handle = await NodeFSP.open(NodePath.join(folder, "main.tex"), "r+");
          },
        },
      );
    });
  });
});
