import { advanceBase } from "./syncRules.ts";
import { fixture } from "./WorkspaceApplier.testkit.ts";
// @effect-diagnostics nodeBuiltinImport:off
import { fileExchangeTestHelper } from "../workspace/fileExchange.testkit.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { bytesRevision } from "../workspace/RetainedFileMutation.ts";
import { type WorkspaceApplyPlan } from "./WorkspaceApplier.ts";
const bytes = (s: string) => Buffer.from(s);
const helper = await fileExchangeTestHelper();
const available = helper !== undefined;
const tree = (s: Record<string, string>) =>
  new Map(Object.entries(s).map(([n, v]) => [n, bytesRevision(bytes(v))]));
const plan = (
  captured: Record<string, string>,
  target: Record<string, string>,
  renames: WorkspaceApplyPlan["renames"] = [],
  markerPaths: string[] = [],
): WorkspaceApplyPlan => ({
  base: tree(captured),
  remote: tree(target),
  captured: tree(captured),
  target: new Map(Object.entries(target).map(([n, v]) => [n, { bytes: bytes(v) }])),
  renames,
  conflicts: [],
  markerPaths,
});
async function put(cwd: string, files: Record<string, string>) {
  for (const [n, v] of Object.entries(files)) {
    await NodeFSP.mkdir(NodePath.dirname(NodePath.join(cwd, n)), { recursive: true });
    await NodeFSP.writeFile(NodePath.join(cwd, n), v);
  }
}
for (const native of [false, true])
  describe.skipIf(native && !available)(native ? "exchange applier" : "fallback applier", () => {
    it.live("applies a rename destination before removal and advances the whole identity", () =>
      fixture(async (h) => {
        await put(h.cwd, { "old.tex": "local" });
        const r = await h.apply(
          "rename",
          plan({ "old.tex": "local" }, { "new.tex": "merged" }, [
            { from: "old.tex", to: "new.tex" },
          ]),
          native,
        );
        expect(r).toMatchObject({ outcome: "complete", matchesTarget: true, interrupted: [] });
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "new.tex"), "utf8")).toBe("merged");
        expect(
          await NodeFSP.access(NodePath.join(h.cwd, "old.tex")).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
      }),
    );
    it.live("replans stale captures without touching any other file", () =>
      fixture(async (h) => {
        await put(h.cwd, { "a.tex": "later", "b.tex": "base" });
        const r = await h.apply(
          "stale",
          plan({ "a.tex": "base", "b.tex": "base" }, { "a.tex": "remote", "b.tex": "remote" }),
          native,
        );
        expect(r).toMatchObject({ outcome: "replan" });
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "b.tex"), "utf8")).toBe("base");
      }),
    );
    it.live.each(["file-folder", "folder-file"])("handles %s as one structural unit", (direction) =>
      fixture(async (h) => {
        const before =
          direction === "file-folder"
            ? { notes: "old" }
            : { "notes/a.tex": "A", "notes/b.tex": "B" };
        const after =
          direction === "file-folder"
            ? { "notes/a.tex": "A", "notes/b.tex": "B" }
            : { notes: "new" };
        await put(h.cwd, before);
        const r = await h.apply("structural", plan(before, after), native);
        expect(r).toMatchObject({ outcome: "complete", matchesTarget: true, interrupted: [] });
      }),
    );
    const recoveryCases = (
      ["recorded", "after-step", "step-recorded", "base-recorded"] as const
    ).flatMap((point) => [false, true].map((later) => ({ point, later })));
    it.live.each(recoveryCases)("recovers rename after $point later=$later", ({ point, later }) => {
      let once = false;
      return fixture(
        async (h) => {
          await put(h.cwd, { "old.tex": "base" });
          const p = plan({ "old.tex": "base" }, { "new.tex": "merged" }, [
            { from: "old.tex", to: "new.tex" },
          ]);
          await expect(h.apply("crash", p, native)).rejects.toBeTruthy();
          if (later) await put(h.cwd, { "new.tex": "later" });
          await h.restart();
          const r = await h.apply("crash", undefined, native);
          if (later && point !== "base-recorded") {
            expect([...r.base]).toEqual([...p.base]);
            expect(await NodeFSP.readFile(NodePath.join(h.cwd, "old.tex"), "utf8")).toBe("base");
          } else expect([...r.base]).toEqual([...p.remote]);
          if (later)
            expect(await NodeFSP.readFile(NodePath.join(h.cwd, "new.tex"), "utf8")).toBe("later");
          else expect(r).toMatchObject({ outcome: "complete", matchesTarget: true });
        },
        {
          at: async (p) => {
            if (p === point && !once) {
              once = true;
              throw new Error("synthetic crash");
            }
          },
        },
      );
    });
    it.live("leaves an interrupted rename's entire base unchanged", () => {
      let folder = "";
      return fixture(
        async (h) => {
          folder = h.cwd;
          await put(h.cwd, { "old.tex": "base" });
          const r = await h.apply(
            "partial",
            plan({ "old.tex": "base" }, { "new.tex": "remote" }, [
              { from: "old.tex", to: "new.tex" },
            ]),
            native,
          );
          expect(r).toMatchObject({ outcome: "attention", interrupted: [["old.tex", "new.tex"]] });
          expect([...r.base]).toEqual([...tree({ "old.tex": "base" })]);
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "old.tex"), "utf8")).toBe("later");
        },
        {
          at: async (p, name) => {
            if (p === "before-step" && name === "old.tex")
              await NodeFSP.writeFile(NodePath.join(folder, "old.tex"), "later");
          },
        },
      );
    });
  });
it.live("checks only recorded marker files, not ordinary Markdown headings", () =>
  fixture(async (h) => {
    await put(h.cwd, { "paper.tex": "base", "readme.md": "old" });
    const r = await h.apply(
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
    expect(r).toMatchObject({ outcome: "attention", markerPaths: ["paper.tex"] });
    await NodeFSP.writeFile(NodePath.join(h.cwd, "paper.tex"), "resolved\n");
    const recovered = await h.apply("markers");
    expect(recovered).toMatchObject({ markerPaths: [] });
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
    await expect(h.apply("link", plan({}, { "chapters/new.tex": "remote" }))).rejects.toBeTruthy();
    expect(await NodeFSP.readdir(NodePath.join(h.root, "outside"))).toEqual([]);
  }),
);

it.live("shares the mutation lock with editor saves", () => {
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
      const applying = h.apply("locked", plan({ "main.tex": "base" }, { "main.tex": "incoming" }));
      await started;
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
      release();
      await applying;
      const outcome = await save;
      expect(outcome._tag).toBe("Failure");
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("incoming");
      await h.run(
        h.files.writeFile({
          cwd: h.cwd,
          relativePath: "main.tex",
          contents: "editor after",
          expectedRevision: bytesRevision(bytes("incoming")),
        }),
      );
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("editor after");
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
      const r = await h.apply(
        "save-first",
        plan({ "main.tex": "base" }, { "main.tex": "incoming" }),
      );
      expect(r.outcome).toBe("attention");
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, "main.tex"), "utf8")).toBe("editor draft");
    },
    {
      at: async (p) => {
        if (p === "before-step") await saveBefore();
      },
    },
  );
});

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
        at: async (p) => {
          if (p === point && ++steps === position && !crashed) {
            crashed = true;
            throw new Error("crash");
          }
        },
      },
    );
  },
);

it.live("does not confuse manuscript names with Object.prototype", () =>
  fixture(async (h) => {
    await put(h.cwd, { constructor: "local", toString: "base" });
    const result = await h.apply(
      "prototype-names",
      plan(
        { constructor: "local", toString: "base" },
        { constructor: "incoming", "new.tex": "new" },
      ),
    );
    expect(result).toMatchObject({ outcome: "complete", matchesTarget: true });
  }),
);

it.live.each(["delete", "replace"])(
  "interrupts recovered rename when destination has a later $0",
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
        expect([...result.base]).toEqual([...p.base]);
        expect(await NodeFSP.readFile(NodePath.join(h.cwd, "old.tex"), "utf8")).toBe("base");
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
      expect(await NodeFSP.readFile(NodePath.join(outside, "main.tex"), "utf8")).toBe("base");
    },
    {
      at: async (point) => {
        if (point === "before-step") {
          await NodeFSP.rename(folder, folder + "-old");
          await NodeFSP.symlink(outside, folder);
        }
      },
    },
  );
});
it.live("keeps a structural source inside the manuscript across a crash", () => {
  let crash = true;
  return fixture(
    async (h) => {
      await put(h.cwd, { notes: "original" });
      await expect(
        h.apply("structural-stage", plan({ notes: "original" }, { "notes/sub/a.tex": "remote" })),
      ).rejects.toBeTruthy();
      const stage = (await NodeFSP.readdir(h.cwd)).find((n) =>
        n.startsWith(".scient-overleaf-apply-"),
      );
      expect(stage).toBeDefined();
      expect(await NodeFSP.readFile(NodePath.join(h.cwd, stage!), "utf8")).toBe("original");
      const result = await h.apply("structural-stage");
      expect(result.outcome).toBe("complete");
      expect(result.stagingPaths).toContain(stage);
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
    expect(await NodeFSP.readFile(NodePath.join(h.cwd, "b/x"), "utf8")).toBe("A");
  }),
);
it.live("replays a transient primitive failure instead of completing its outer journal", () => {
  let fail = true;
  return fixture(
    async (h) => {
      await put(h.cwd, { "main.tex": "base" });
      const p = plan({ "main.tex": "base" }, { "main.tex": "remote" });
      await expect(h.apply("retry", p)).rejects.toBeTruthy();
      const result = await h.apply("retry");
      expect(result).toMatchObject({ outcome: "complete", matchesTarget: true });
    },
    {},
    {
      at: async (point) => {
        if (point === "displaced" && fail) {
          fail = false;
          throw new Error("transient I/O fault");
        }
      },
    },
  );
});

const modelCases = (["after-step", "step-recorded"] as const).flatMap((point) =>
  (["none", "source-edit", "destination-edit", "destination-delete"] as const).flatMap((action) =>
    [false, true].map((native) => ({ point, action, native })),
  ),
);
it.live.each(modelCases)(
  "agrees with grouped base model after $point/$action native=$native",
  ({ point, action, native }) => {
    let crash = true;
    return fixture(
      async (h) => {
        const before = { "old.tex": "captured local" },
          after = { "new.tex": "merged remote" };
        const renames = [{ from: "old.tex", to: "new.tex" }];
        const p = plan(before, after, renames);
        await put(h.cwd, before);
        await expect(h.apply("model", p, native)).rejects.toBeTruthy();
        if (action === "source-edit") await put(h.cwd, { "old.tex": "late local" });
        if (action === "destination-edit") await put(h.cwd, { "new.tex": "late local" });
        if (action === "destination-delete") await NodeFSP.unlink(NodePath.join(h.cwd, "new.tex"));
        await h.restart();
        const actual = await h.apply("model", undefined, native);
        const expected = advanceBase({
          before: p.base,
          remote: p.remote,
          renames,
          undonePaths: action === "none" ? [] : ["old.tex", "new.tex"],
        });
        expect([...actual.base]).toEqual([...expected]);
        expect(actual.outcome).toBe(action === "none" ? "complete" : "attention");
        if (action !== "none") expect(actual.interrupted).toHaveLength(1);
        if (action === "source-edit")
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "old.tex"), "utf8")).toBe(
            "late local",
          );
        if (action === "destination-edit")
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "new.tex"), "utf8")).toBe(
            "late local",
          );
        if (action === "destination-delete")
          expect(await NodeFSP.readFile(NodePath.join(h.cwd, "old.tex"), "utf8")).toBe(
            "captured local",
          );
      },
      {
        at: async (p, name) => {
          if (p === point && name === "new.tex" && crash) {
            crash = false;
            throw new Error("crash");
          }
        },
      },
    );
  },
);
