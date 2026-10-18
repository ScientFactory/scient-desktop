import { EnvironmentId } from "@t3tools/contracts";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MarkdownPersistenceRegistry,
  keepBothVersions,
} from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { createTestCheckpointStore } from "../markdownEditor/persistence/markdownDraftCheckpointTestkit";
import { changeLatexDocumentCompiler } from "./changeLatexDocumentCompiler";
import { LatexDocumentInputs } from "./latexDocumentInputs";
import { prepareLatexDocument } from "./prepareLatexDocument";

vi.mock("../markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
}));
vi.mock("~/components/files/projectFilesQueryState", () => ({
  getOptimisticProjectFileQueryData: () => null,
  getPendingOptimisticProjectFilePaths: () => [],
}));

const target = {
  environmentId: EnvironmentId.make("compiler-transaction-test"),
  cwd: "/compiler-transaction",
  relativePath: "main.tex",
};
const body = "\\documentclass{article}\r\n\\begin{document}\r\nשלום $x=1$\r\n\\end{document}\r\n";
const source = `% !TEX program = pdflatex\r\n% !TEX root = main.tex\r\n${body}`;
const updated = source.replace("program = pdflatex", "program = xelatex");
const revision = (text: string) => `revision:${text}`;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function setup(initial = source) {
  const disk = { source: initial, revision: revision(initial) };
  const writes: MarkdownSaveIntent[] = [];
  const controls = {
    beforeRead: async () => {},
    beforeWrite: async (_intent: MarkdownSaveIntent) => {},
    failure: null as null | "terminal" | "recovery_required",
  };
  const registry = new MarkdownPersistenceRegistry({
    checkpointStore: createTestCheckpointStore(),
    debounceMs: 60_000,
    reconcile: () => keepBothVersions,
    createTransport: () => ({
      read: async () => {
        await controls.beforeRead();
        return { ...disk };
      },
      write: async (intent) => {
        await controls.beforeWrite(intent);
        if (controls.failure !== null) throw controls.failure;
        if (disk.revision !== intent.expectedRevision) throw "conflict";
        disk.source = intent.source;
        disk.revision = revision(intent.source);
        writes.push(intent);
        return { revision: disk.revision };
      },
      classifyFailure: (error) =>
        error === "conflict"
          ? "conflict"
          : error === "recovery_required"
            ? "recovery_required"
            : "terminal",
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const lease = await registry.open(target, {});
  const inputs = new LatexDocumentInputs();
  const prepare = async () => {
    const prepared = await prepareLatexDocument(target, {
      selected: lease,
      registry,
      inputs,
      pendingPaths: () => [],
      optimistic: () => null,
    });
    return prepared.ok ? prepared : null;
  };
  const run = (overrides: Partial<Parameters<typeof changeLatexDocumentCompiler>[0]> = {}) =>
    changeLatexDocumentCompiler({
      target,
      lease,
      compiler: "xelatex",
      blocked: () => false,
      isActive: () => true,
      prepare,
      ...overrides,
    });
  return { disk, writes, controls, registry, lease, inputs, prepare, run };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("compiler transaction boundaries", () => {
  it("edits only the directive range after saving the latest input that arrived during settlement", async () => {
    const h = await setup();
    const first = source.replace("$x=1$", "$x=2$");
    const latest = source.replace("$x=1$", "$x=3$ — latest user edit");
    expect(h.lease.change(first, h.lease.getSnapshot().editVersion)).toBe(true);
    const entered = deferred<void>();
    const gate = deferred<void>();
    h.controls.beforeWrite = async () => {
      h.controls.beforeWrite = async () => {};
      entered.resolve();
      await gate.promise;
    };
    const apply = vi.spyOn(h.lease, "applyEdit");
    const result = h.run();
    await entered.promise;
    expect(apply).not.toHaveBeenCalled();
    expect(h.lease.change(latest, h.lease.getSnapshot().editVersion)).toBe(true);
    gate.resolve();
    expect(await result).toEqual({ ok: true });
    const expected = latest.replace("program = pdflatex", "program = xelatex");
    expect(h.writes.map((intent) => intent.source)).toEqual([first, latest, expected]);
    expect(h.disk.source).toBe(expected);
    expect(h.lease.getSnapshot()).toMatchObject({ draftSource: expected, pending: false });
    expect(apply).toHaveBeenCalledOnce();
    const edit = apply.mock.calls[0]![0];
    expect(edit.patches).toEqual([{ start: 17, end: 20, replacement: "xe", expected: "pdf" }]);
    h.lease.release();
  });

  it.each([
    { environmentId: EnvironmentId.make("other-environment") },
    { cwd: "/another-workspace" },
  ])("refuses a same-named root in a different ownership scope %j", async (scope) => {
    const h = await setup();
    const prepare = vi.fn(h.prepare);
    expect((await h.run({ target: { ...target, ...scope }, prepare })).ok).toBe(false);
    expect(prepare).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
    expect(h.disk.source).toBe(source);
    expect(h.lease.getSnapshot().draftSource).toBe(source);
    h.lease.release();
  });

  it("refuses navigation away while the initial preparation read is in flight", async () => {
    const h = await setup();
    const entered = deferred<void>();
    const gate = deferred<void>();
    h.controls.beforeRead = async () => {
      entered.resolve();
      await gate.promise;
    };
    let active = true;
    const result = h.run({ isActive: () => active });
    await entered.promise;
    active = false;
    gate.resolve();
    expect((await result).ok).toBe(false);
    expect(h.writes).toEqual([]);
    expect(h.disk.source).toBe(source);
    expect(h.lease.getSnapshot().draftSource).toBe(source);
    h.lease.release();
  });

  it("refuses a lease that has rebound to a renamed root after preparation", async () => {
    const h = await setup();
    const destination = { ...target, relativePath: "renamed.tex" };
    expect(
      (
        await h.run({
          prepare: async () => {
            const prepared = await h.prepare();
            const move = h.lease.beginMove(destination);
            expect(move).not.toBeNull();
            expect(await move!.preflight()).toBe("empty");
            const intent = await move!.admitRename();
            expect(
              await move!.acknowledgeRename({
                destinationRelativePath: destination.relativePath,
                revision: intent.expectedRevision,
              }),
            ).toBe(true);
            expect(await move!.commit()).toBe(true);
            move!.finish();
            return prepared;
          },
        })
      ).ok,
    ).toBe(false);
    expect(h.lease.target).toEqual(destination);
    expect(h.lease.getSnapshot().draftSource).toBe(source);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    h.lease.release();
  });

  it("refuses a released owner even when its captured preparation still reports current", async () => {
    const h = await setup();
    const successor = await h.registry.open(target);
    const result = await h.run({
      prepare: async () => {
        const prepared = await h.prepare();
        expect(prepared?.isCurrent()).toBe(true);
        h.lease.release();
        return prepared;
      },
    });
    expect(result.ok).toBe(false);
    expect(successor.getSnapshot().draftSource).toBe(source);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    successor.release();
  });

  it("preserves a concurrent user edit when the directive patch's edit version becomes stale", async () => {
    const h = await setup();
    const latest = source.replace("$x=1$", "$x=9$ — typed concurrently");
    const apply = h.lease.applyEdit;
    vi.spyOn(h.lease, "applyEdit").mockImplementationOnce((edit) => {
      expect(h.lease.change(latest, h.lease.getSnapshot().editVersion)).toBe(true);
      const outcome = apply(edit);
      expect(outcome).toEqual({ accepted: false, reason: "version" });
      return outcome;
    });
    expect((await h.run()).ok).toBe(false);
    expect(h.lease.getSnapshot().draftSource).toBe(latest);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    h.lease.release();
  });

  it("rejects a preparation invalidated by newer user input before planning any directive edit", async () => {
    const h = await setup();
    const latest = source.replace("$x=1$", "$x=8$");
    expect(
      (
        await h.run({
          prepare: async () => {
            const prepared = await h.prepare();
            h.lease.change(latest, h.lease.getSnapshot().editVersion);
            expect(prepared?.isCurrent()).toBe(false);
            return prepared;
          },
        })
      ).ok,
    ).toBe(false);
    expect(h.lease.getSnapshot().draftSource).toBe(latest);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    h.lease.release();
  });

  it("does not consume retained composing input that appears after preparation", async () => {
    const h = await setup();
    const pending = { message: "Composing", payload: { raw: "שלום", composing: true } };
    expect(
      (
        await h.run({
          prepare: async () => {
            const prepared = await h.prepare();
            expect(h.lease.retainPendingInput(pending)).toBe(true);
            return prepared;
          },
        })
      ).ok,
    ).toBe(false);
    expect(h.lease.getPendingInput()).toBe(pending);
    expect(h.lease.getSnapshot().draftSource).toBe(source);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    h.lease.retainPendingInput(null);
    h.lease.release();
  });

  it("immediately refuses an already active rename hold without starting preparation", async () => {
    const h = await setup();
    const unlock = h.lease.holdForRename();
    expect(unlock).not.toBeNull();
    expect(h.lease.getSnapshot().editingBlocked).toBe(true);
    const prepare = vi.fn(async () => {
      throw new Error("Preparing a held document would wait for its rename to finish");
    });
    try {
      expect((await h.run({ prepare })).ok).toBe(false);
      expect(prepare).not.toHaveBeenCalled();
      expect(h.lease.target).toEqual(target);
      expect(h.lease.getSnapshot()).toMatchObject({
        draftSource: source,
        editingBlocked: true,
      });
      expect(h.disk.source).toBe(source);
      expect(h.writes).toEqual([]);
    } finally {
      unlock!();
      h.lease.release();
    }
  });

  it("does not change source while an in-place rename has blocked editing", async () => {
    const h = await setup();
    const held = { unlock: null as (() => void) | null };
    expect(
      (
        await h.run({
          prepare: async () => {
            const prepared = await h.prepare();
            held.unlock = h.lease.holdForRename();
            expect(held.unlock).not.toBeNull();
            expect(h.lease.getSnapshot().editingBlocked).toBe(true);
            return prepared;
          },
        })
      ).ok,
    ).toBe(false);
    expect(h.lease.getSnapshot().draftSource).toBe(source);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    held.unlock!();
    h.lease.release();
  });

  it("refuses recovery attention that appears while the first preparation is finishing", async () => {
    const h = await setup();
    let blocked = false;
    expect(
      (
        await h.run({
          blocked: () => blocked,
          prepare: async () => {
            const prepared = await h.prepare();
            blocked = true;
            return prepared;
          },
        })
      ).ok,
    ).toBe(false);
    expect(h.lease.getSnapshot().draftSource).toBe(source);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    h.lease.release();
  });

  it("does not insert a directive while a fresh read starts after preparation", async () => {
    const h = await setup();
    const gate = deferred<void>();
    let reading: Promise<boolean> | undefined;
    expect(
      (
        await h.run({
          prepare: async () => {
            const prepared = await h.prepare();
            h.controls.beforeRead = () => gate.promise;
            reading = h.lease.refresh();
            expect(h.lease.getSnapshot().reading).toBe(true);
            return prepared;
          },
        })
      ).ok,
    ).toBe(false);
    expect(h.lease.getSnapshot().draftSource).toBe(source);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    gate.resolve();
    expect(await reading).toBe(true);
    h.lease.release();
  });

  it("retains a pre-existing failed user save without applying a compiler change", async () => {
    const h = await setup();
    const latest = source.replace("$x=1$", "$x=4$");
    h.lease.change(latest, h.lease.getSnapshot().editVersion);
    h.controls.failure = "terminal";
    expect(await h.lease.flushNow()).toBe(false);
    expect(h.lease.getSnapshot().error).not.toBeNull();
    expect((await h.run()).ok).toBe(false);
    expect(h.lease.getSnapshot().draftSource).toBe(latest);
    expect(h.disk.source).toBe(source);
    expect(h.writes).toEqual([]);
    h.lease.release();
  });

  it.each(["terminal", "recovery_required"] as const)(
    "does not report success when the compiler directive save is refused with %s",
    async (failure) => {
      const h = await setup();
      h.controls.failure = failure;
      expect((await h.run()).ok).toBe(false);
      expect(h.disk.source).toBe(source);
      expect(h.writes).toEqual([]);
      expect(h.lease.getSnapshot()).toMatchObject({ draftSource: updated, pending: true });
      expect(h.lease.getSnapshot().error).not.toBeNull();
      h.lease.release();
    },
  );

  it("does not report completion before the compiler source actually reaches disk", async () => {
    const h = await setup();
    const entered = deferred<void>();
    const gate = deferred<void>();
    h.controls.beforeWrite = async () => {
      entered.resolve();
      await gate.promise;
    };
    let completed = false;
    const result = h.run().then((outcome) => {
      completed = true;
      return outcome;
    });
    await entered.promise;
    expect(completed).toBe(false);
    expect(h.disk.source).toBe(source);
    expect(h.lease.getSnapshot().draftSource).toBe(updated);
    gate.resolve();
    expect(await result).toEqual({ ok: true });
    expect(h.disk.source).toBe(updated);
    expect(h.lease.getSnapshot()).toMatchObject({
      baselineRevision: revision(updated),
      pending: false,
    });
    h.lease.release();
  });

  it("refuses confirmation if a newer edit becomes saved while the directive save is in flight", async () => {
    const h = await setup();
    const entered = deferred<void>();
    const gate = deferred<void>();
    h.controls.beforeWrite = async () => {
      h.controls.beforeWrite = async () => {};
      entered.resolve();
      await gate.promise;
    };
    const result = h.run();
    await entered.promise;
    const latest = updated.replace("$x=1$", "$x=5$ — not the source that was selected");
    expect(h.lease.change(latest, h.lease.getSnapshot().editVersion)).toBe(true);
    gate.resolve();
    expect((await result).ok).toBe(false);
    expect(h.disk.source).toBe(latest);
    expect(h.lease.getSnapshot()).toMatchObject({ draftSource: latest, pending: false });
    h.lease.release();
  });

  it("rechecks navigation after the updated source saves instead of confirming the former binding", async () => {
    const h = await setup();
    let active = true;
    let preparations = 0;
    expect(
      (
        await h.run({
          isActive: () => active,
          prepare: async () => {
            const prepared = await h.prepare();
            if (++preparations === 2) active = false;
            return prepared;
          },
        })
      ).ok,
    ).toBe(false);
    expect(h.disk.source).toBe(updated);
    expect(h.lease.getSnapshot()).toMatchObject({ draftSource: updated, pending: false });
    h.lease.release();
  });

  it("confirms an already selected compiler without publishing an unnecessary source edit", async () => {
    const h = await setup(updated);
    expect(await h.run()).toEqual({ ok: true });
    expect(h.writes).toEqual([]);
    expect(h.lease.getSnapshot().editVersion).toBe(0);
    expect(h.disk.source).toBe(updated);
    h.lease.release();
  });

  it("saves removal of the declaration for automatic selection without changing root or body", async () => {
    const h = await setup();
    expect(await h.run({ compiler: "automatic" })).toEqual({ ok: true });
    const expected = `% !TEX root = main.tex\r\n${body}`;
    expect(h.disk.source).toBe(expected);
    expect(h.lease.getSnapshot()).toMatchObject({ draftSource: expected, pending: false });
    h.lease.release();
  });
});
