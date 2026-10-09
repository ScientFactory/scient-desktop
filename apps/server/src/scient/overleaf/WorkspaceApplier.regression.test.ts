// Regression cases from the independent review of PR #486.
import { fixture } from "./WorkspaceApplier.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import { type WorkspaceApplyPlan } from "./WorkspaceApplier.ts";
const bytes = (s: string | Buffer) => Buffer.from(s);
const tree = (s: Record<string, string | Buffer>) =>
  new Map(Object.entries(s).map(([n, v]) => [n, bytesRevision(bytes(v))]));
const plan = (
  captured: Record<string, string | Buffer>,
  target: Record<string, string | Buffer>,
): WorkspaceApplyPlan => ({
  base: tree(captured),
  remote: tree(target),
  captured: tree(captured),
  target: new Map(Object.entries(target).map(([n, v]) => [n, { bytes: bytes(v) }])),
  renames: [],
  conflicts: [],
  markerPaths: [],
});
async function put(cwd: string, files: Record<string, string | Buffer>) {
  for (const [n, v] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, n)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, n), v);
  }
}

describe("WorkspaceApplier review regressions", () => {
  it.live("writes payload once and keeps progress small across steps and resume", () => {
    let owner = "";
    let immutable: { ino: number; mtimeMs: number } | undefined;
    let checks = 0;
    return fixture(
      async (h) => {
        owner = h.owner;
        const captured: Record<string, Buffer> = {},
          target: Record<string, Buffer> = {};
        for (let i = 0; i < 20; i++) {
          captured[`fig${i}.pdf`] = Buffer.alloc(1024 * 1024, i);
          target[`fig${i}.pdf`] = Buffer.alloc(1024 * 1024, i + 100);
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
        const r = await h.apply("skip", p);
        expect(r).toMatchObject({ outcome: "attention", interrupted: [] });
        expect(r.base.get("a.tex")).toBe(p.remote.get("a.tex"));
        expect(r.base.get("b.tex")).toBe(p.base.get("b.tex"));
        expect(await NodeFSP.readFile(NodePath.join(cwd, "b.tex"), "utf8")).toBe(
          "later local edit",
        );
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

  it.live("ignores executable metadata on unchanged and changed local files", () =>
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
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("remote");
    }),
  );

  it.live("resumes a crash after intent persistence without rewriting the payload", () => {
    let crash = true;
    return fixture(
      async (h) => {
        await put(h.cwd, { "a.tex": "base" });
        await expect(
          h.apply("intent", plan({ "a.tex": "base" }, { "a.tex": "remote" })),
        ).rejects.toBeTruthy();
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "a.tex"), "utf8")).toBe("base");
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

  it.live("refuses missing or altered intent before further local mutation", () =>
    fixture(async (h) => {
      await h.apply("altered", plan({}, {}));
      const file = NodePath.join(h.owner, "altered/plan.json");
      const original = await NodeFSP.readFile(file, "utf8");
      await NodeFSP.writeFile(file, original + " ");
      await expect(h.apply("altered")).rejects.toBeTruthy();
      await NodeFSP.unlink(file);
      await expect(h.apply("altered", plan({}, {}))).rejects.toBeTruthy();
    }),
  );
  it.live.each([false, true])(
    "upgrades old records and resumes an interrupted upgrade ($0)",
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
          // A later writer is never replayed over just because a record is upgraded.
          await put(h.cwd, { "a.tex": "later" });
          await h.restart();
          expect((await h.apply("legacy")).outcome).toBe("attention");
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "a.tex"), "utf8")).toBe("later");
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
  it.live.each(["after-step", "displaced"] as const)(
    "recovers completed removals before outer progress at $0",
    (point) => {
      let crash = true;
      return fixture(
        async (h) => {
          await put(h.cwd, { "old.tex": "old", "new.tex": "merged" });
          const p = {
            ...plan({ "old.tex": "old", "new.tex": "merged" }, { "new.tex": "merged" }),
            renames: [{ from: "old.tex", to: "new.tex" }],
          };
          await expect(h.apply("hidden-remove", p)).rejects.toBeTruthy();
          await put(h.cwd, { "new.tex": "later" });
          await h.restart();
          const result = await h.apply("hidden-remove");
          expect(result.interrupted).toEqual([["old.tex", "new.tex"]]);
          expect(result.base).toEqual(p.base);
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "new.tex"), "utf8")).toBe("later");
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

  it.live.each([false, true])(
    "recovers exchanges not yet represented in outer progress (legacy=$0)",
    (legacy) => {
      let crash = true;
      return fixture(
        async (h) => {
          await put(h.cwd, { "a.tex": "base", "guard.tex": "guard" });
          const p = {
            ...plan(
              { "a.tex": "base", "guard.tex": "guard" },
              { "a.tex": "remote", "guard.tex": "guard" },
            ),
            conflicts: [
              { paths: ["a.tex", "guard.tex"], types: ["content"], origins: ["merge" as const] },
            ],
          };
          await expect(h.apply("hidden-exchange", p, true)).rejects.toBeTruthy();
          if (legacy) {
            const directory = NodePath.join(h.owner, "hidden-exchange");
            const intent = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "plan.json"), "utf8"),
            );
            const saved = JSON.parse(
              await NodeFSP.readFile(NodePath.join(directory, "apply.json"), "utf8"),
            );
            delete saved.intentRevision;
            await NodeFSP.writeFile(
              NodePath.join(directory, "apply.json"),
              JSON.stringify({ ...intent, ...saved, version: 1 }),
            );
            await NodeFSP.unlink(NodePath.join(directory, "plan.json"));
          }
          await put(h.cwd, { "guard.tex": "later" });
          await h.restart();
          const result = await h.apply("hidden-exchange", undefined, true);
          expect(result.interrupted).toEqual([["a.tex", "guard.tex"]]);
          expect(result.base).toEqual(p.base);
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "guard.tex"), "utf8")).toBe("later");
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
    },
  );
  it.live.each(["intent", "prepared"] as const)(
    "does not force a conflict for staging-only crash at $0",
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
            conflicts: [
              { paths: ["a.tex", "guard.tex"], types: ["content"], origins: ["merge" as const] },
            ],
          };
          await expect(h.apply("staging-only", p, true)).rejects.toBeTruthy();
          await put(h.cwd, { "guard.tex": "later" });
          await h.restart();
          const result = await h.apply("staging-only", undefined, true);
          expect(result.interrupted).toEqual([]);
          expect(result.base).toEqual(p.base);
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "a.tex"), "utf8")).toBe("base");
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
  it.live("recognizes a fallback addition installed before its phase write", () => {
    let crash = true;
    return fixture(
      async (h) => {
        await put(h.cwd, { "guard.tex": "guard" });
        const p = {
          ...plan({ "guard.tex": "guard" }, { "a.tex": "remote", "guard.tex": "guard" }),
          conflicts: [
            { paths: ["a.tex", "guard.tex"], types: ["content"], origins: ["merge" as const] },
          ],
        };
        await expect(h.apply("hidden-addition", p)).rejects.toBeTruthy();
        await put(h.cwd, { "guard.tex": "later" });
        await h.restart();
        const result = await h.apply("hidden-addition");
        expect(result.interrupted).toEqual([["a.tex", "guard.tex"]]);
        expect(result.base).toEqual(p.base);
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "guard.tex"), "utf8")).toBe("later");
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
  });
});
