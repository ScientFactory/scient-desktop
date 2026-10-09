// @effect-diagnostics nodeBuiltinImport:off
import { fileExchangeTestHelper } from "./fileExchange.testkit.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import {
  bytesRevision,
  fileIdentity,
  mutateRetainedFile,
  recheckRetainedFile,
  type MutationPoint,
  type RetainedMutationInput,
} from "./RetainedFileMutation.ts";
const bytes = (text: string) => Buffer.from(text);
const helper = await fileExchangeTestHelper();
const available = helper !== undefined;
async function fixture(
  body: (input: RetainedMutationInput, target: string, root: string) => Promise<void>,
  native = false,
  remove = false,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-retained-")),
    target = NodePath.join(root, "paper/main.tex");
  await NodeFSP.mkdir(NodePath.dirname(target));
  await NodeFSP.mkdir(NodePath.join(root, "records"));
  await NodeFSP.writeFile(target, "captured");
  try {
    await body(
      {
        cwd: NodePath.dirname(target),
        relativePath: "main.tex",
        retentionDirectory: NodePath.join(root, "records"),
        id: "one",
        expectedRevision: bytesRevision(bytes("captured")),
        bytes: remove ? null : bytes("incoming"),
        ...(native && helper ? { exchangeHelper: helper } : {}),
      },
      target,
      root,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}
for (const native of [false, true])
  describe.skipIf(native && !available)(native ? "exchange" : "move-aside", () => {
    it("retains the exact displaced inode", () =>
      fixture(async (input, target) => {
        const id = await fileIdentity(target),
          r = await mutateRetainedFile(input, target);
        expect(r.outcome).toBe("done");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("incoming");
        expect(r.retainedIdentity).toEqual(id);
        expect(await NodeFSP.readFile(r.retainedPath!, "utf8")).toBe("captured");
      }, native));
    it.each([false, true])("preserves whole-file=%s writes after the check", (swap) =>
      fixture(async (input, target, root) => {
        let wrote = false;
        const r = await mutateRetainedFile(input, target, {
          at: async (p) => {
            if (p === "checked" && !wrote) {
              wrote = true;
              if (swap) {
                await NodeFSP.writeFile(NodePath.join(root, "external"), "later");
                await NodeFSP.rename(NodePath.join(root, "external"), target);
              } else await NodeFSP.writeFile(target, "later");
            }
          },
        });
        expect(await NodeFSP.readFile(target, "utf8")).toBe("later");
        expect(r.outcome).not.toBe("done");
      }, native),
    );
    it("retains late writes through an open handle", () =>
      fixture(async (input, target) => {
        const h = await NodeFSP.open(target, "r+");
        try {
          const r = await mutateRetainedFile(input, target);
          await h.truncate(0);
          await h.writeFile("late handle");
          await h.sync();
          const checked = await recheckRetainedFile(r, input.expectedRevision);
          expect(checked.changed).toBe(true);
          expect(await NodeFSP.readFile(checked.retainedPath!, "utf8")).toBe("late handle");
          expect(await NodeFSP.readFile(target, "utf8")).toBe("incoming");
        } finally {
          await h.close();
        }
      }, native));
    const crashCases = [false, true].flatMap((remove) =>
      (
        [
          "intent",
          "staged",
          "prepared",
          "checked",
          "displaced",
          "installed",
          "done",
        ] as MutationPoint[]
      )
        .filter((point) => !remove || point !== "staged")
        .map((point) => ({ remove, point })),
    );
    it.each(crashCases)("recovers removal=$remove after $point", ({ remove, point }) =>
      fixture(
        async (input, target) => {
          let crashed = false;
          try {
            await mutateRetainedFile(input, target, {
              at: async (p) => {
                if (p === point && !crashed) {
                  crashed = true;
                  throw new Error("synthetic crash");
                }
              },
            });
          } catch (e) {
            expect(String(e)).toContain("synthetic crash");
          }
          const r = await mutateRetainedFile(input, target);
          const text = await NodeFSP.readFile(target, "utf8").catch((e) =>
            e.code === "ENOENT" ? null : Promise.reject(e),
          );
          expect(remove ? ["captured", null] : ["captured", "incoming"]).toContain(text);
          if (r.retainedPath)
            expect(await NodeFSP.readFile(r.retainedPath, "utf8")).toBe("captured");
        },
        native,
        remove,
      ),
    );
    it("preserves a foreign same-content file after a crash", () =>
      fixture(async (input, target, root) => {
        await expect(
          mutateRetainedFile(input, target, {
            at: async (p) => {
              if (p === "displaced") throw new Error("crash");
            },
          }),
        ).rejects.toThrow("crash");
        await NodeFSP.writeFile(NodePath.join(root, "foreign"), "incoming");
        await NodeFSP.rename(NodePath.join(root, "foreign"), target);
        const id = await fileIdentity(target),
          r = await mutateRetainedFile(input, target);
        expect(await fileIdentity(target)).toEqual(id);
        expect(r.outcome).toBe("attention");
        expect(r.retainedPath).not.toBeNull();
      }, native));
    it("rejects reused ids with other bytes", () =>
      fixture(async (input, target) => {
        await mutateRetainedFile(input, target);
        await expect(
          mutateRetainedFile({ ...input, bytes: bytes("other") }, target),
        ).rejects.toThrow("different intent");
      }, native));
  });
it("refuses a create in the fallback gap", () =>
  fixture(async (input, target) => {
    const r = await mutateRetainedFile(input, target, {
      at: async (p) => {
        if (p === "displaced") await NodeFSP.writeFile(target, "gap writer");
      },
    });
    expect(r.outcome).toBe("attention");
    expect(await NodeFSP.readFile(target, "utf8")).toBe("gap writer");
    expect(await NodeFSP.readFile(r.retainedPath!, "utf8")).toBe("captured");
  }));

describe.skipIf(!available)("restoration recovery", () => {
  it.each(["restore-intent", "restored", "return-intent", "returned"] as MutationPoint[])(
    "recovers %s with competing newer versions",
    (point) =>
      fixture(async (input, target, root) => {
        let crashed = false,
          wroteA = false,
          wroteB = false;
        const swap = async (text: string) => {
          const path = NodePath.join(root, "writer");
          await NodeFSP.writeFile(path, text);
          await NodeFSP.rename(path, target);
        };
        await expect(
          mutateRetainedFile(input, target, {
            at: async (p) => {
              if (p === "checked" && !wroteA) {
                wroteA = true;
                await swap("A");
              }
              if (p === "restore-intent" && !wroteB) {
                wroteB = true;
                await swap("B");
              }
              if (p === point && !crashed) {
                crashed = true;
                throw new Error("crash");
              }
            },
          }),
        ).rejects.toThrow("crash");
        const result = await mutateRetainedFile(input, target);
        expect(await NodeFSP.readFile(target, "utf8")).toBe("B");
        expect(result.outcome).toBe("attention");
      }, true),
  );
  it("returns the third writer displaced during the second exchange", () =>
    fixture(async (input, target, root) => {
      const swap = async (text: string) => {
        const path = NodePath.join(root, "writer");
        await NodeFSP.writeFile(path, text);
        await NodeFSP.rename(path, target);
      };
      let first = true;
      const result = await mutateRetainedFile(input, target, {
        at: async (p) => {
          if (p === "checked") await swap("A");
          if (p === "restore-intent") await swap("B");
          if (p === "return-intent" && first) {
            first = false;
            await swap("C");
          }
        },
      });
      expect(result.outcome).toBe("attention");
      expect(await NodeFSP.readFile(target, "utf8")).toBe("C");
    }, true));
});

it.skipIf(!available)("returns a newer in-place write displaced by the return exchange", () =>
  fixture(async (input, target, root) => {
    const swap = async (value: string) => {
      const writer = NodePath.join(root, "writer");
      await NodeFSP.writeFile(writer, value);
      await NodeFSP.rename(writer, target);
    };
    let once = true;
    const result = await mutateRetainedFile(input, target, {
      at: async (point) => {
        if (point === "checked") await swap("A");
        if (point === "restore-intent") await swap("B");
        if (point === "return-intent" && once) {
          once = false;
          await NodeFSP.writeFile(target, "C in place");
        }
      },
    });
    expect(result.outcome).toBe("attention");
    expect(await NodeFSP.readFile(target, "utf8")).toBe("C in place");
  }, true),
);

it.skipIf(!available)("reports late writes through a handle to a restored staged file", () =>
  fixture(async (input, target) => {
    let handle: Awaited<ReturnType<typeof NodeFSP.open>> | undefined;
    try {
      await mutateRetainedFile(input, target, {
        at: async (point) => {
          if (point === "checked") await NodeFSP.writeFile(target, "A");
          if (point === "displaced") handle = await NodeFSP.open(target, "r+");
        },
      });
      await handle!.truncate(0);
      await handle!.writeFile("held staged user edit");
      await handle!.sync();
      const recovered = await mutateRetainedFile(input, target);
      expect(recovered.retainedPath).not.toBeNull();
      expect(await NodeFSP.readFile(recovered.retainedPath!, "utf8")).toBe("held staged user edit");
    } finally {
      await handle?.close();
    }
  }, true),
);

describe.skipIf(!available)("restoration revision continuity", () => {
  it.each(["between-rounds", "round-admitted", "crash-intent"])(
    "keeps C written at %s without blessing it as harmless displacement",
    (point) =>
      fixture(async (input, target, root) => {
        const swap = async (value: string) => {
          const writer = NodePath.join(root, "writer");
          await NodeFSP.writeFile(writer, value);
          await NodeFSP.rename(writer, target);
        };
        let wrote = false,
          crashed = false;
        const applying = mutateRetainedFile(input, target, {
          at: async (p) => {
            if (p === "checked") await swap("A");
            if (p === "restore-intent") await swap("B");
            if (
              !wrote &&
              p === (point === "between-rounds" ? "between-rounds" : "round-admitted")
            ) {
              wrote = true;
              await NodeFSP.writeFile(target, "C newest");
            }
            if (point === "crash-intent" && p === "return-intent" && !crashed) {
              crashed = true;
              throw new Error("crash");
            }
          },
        });
        if (point === "crash-intent") await expect(applying).rejects.toThrow("crash");
        else await applying;
        const recovered = await mutateRetainedFile(input, target);
        expect(recovered.outcome).toBe("attention");
        expect(await NodeFSP.readFile(target, "utf8")).toBe("C newest");
      }, true),
  );
});
