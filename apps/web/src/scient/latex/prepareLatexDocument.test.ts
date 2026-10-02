import { EnvironmentId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  MarkdownPersistenceRegistry,
  keepBothVersions,
} from "../markdownEditor/persistence/markdownPersistenceRegistry";
import type { MarkdownPersistenceTarget } from "../markdownEditor/persistence/markdownPersistenceRegistry";
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
  environmentId: EnvironmentId.make("preparation-test"),
  cwd: "/fixture",
  relativePath: "main.tex",
};
const revision = (source: string) => `revision:${source}`;
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(initial: Record<string, string>) {
  const disk = new Map(Object.entries(initial));
  const writes: string[] = [];
  const fail = new Set<string>();
  const readGate = new Map<string, Promise<void>>();
  const writeGate = new Map<string, Promise<void>>();
  const read = async (file: MarkdownPersistenceTarget) => {
    await readGate.get(file.relativePath);
    const source = disk.get(file.relativePath);
    if (source === undefined) throw new Error(`Missing ${file.relativePath}`);
    return { source, revision: revision(source) };
  };
  const registry = new MarkdownPersistenceRegistry({
    debounceMs: 60_000,
    reconcile: () => keepBothVersions,
    createTransport: (file) => ({
      read: () => read(file),
      write: async (intent) => {
        await writeGate.get(file.relativePath);
        if (fail.has(file.relativePath)) throw new Error("Write refused");
        if (revision(disk.get(file.relativePath)!) !== intent.expectedRevision) throw "conflict";
        disk.set(file.relativePath, intent.source);
        writes.push(file.relativePath);
        return { revision: revision(intent.source) };
      },
      classifyFailure: (error) => (error === "conflict" ? "conflict" : "terminal"),
      subscribe: () => () => {},
      project: () => {},
    }),
  });
  const inputs = new LatexDocumentInputs();
  const optimistic = new Map<string, string>();
  const options = {
    registry,
    inputs,
    read,
    pendingPaths: () => [...optimistic.keys()],
    optimistic: (file: MarkdownPersistenceTarget) => optimistic.get(file.relativePath) ?? null,
  };
  const open = (path: string) => registry.open({ ...target, relativePath: path });
  return { disk, writes, fail, readGate, writeGate, registry, inputs, optimistic, options, open };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("document preparation without a mounted Visual editor", () => {
  it("flushes a retained chapter while reading unopened dependencies without acquiring writers", async () => {
    const h = setup({
      "main.tex": "\\input{chapter}\\input{unopened}",
      "chapter.tex": "old",
      "unopened.tex": "untouched",
    });
    const chapter = await h.open("chapter.tex");
    chapter.change("new", chapter.getSnapshot().editVersion);
    chapter.release();
    const result = await prepareLatexDocument(target, h.options);
    expect(result.ok).toBe(true);
    expect(h.disk.get("chapter.tex")).toBe("new");
    expect(h.writes).toEqual(["chapter.tex"]);
    expect(h.registry.has(target)).toBe(false);
    expect(h.registry.has({ ...target, relativePath: "unopened.tex" })).toBe(false);
    if (result.ok) expect(result.revisions.get("chapter.tex")).toBe(revision("new"));
  });

  it("ignores unrelated dirty files but refuses a failed included save", async () => {
    const h = setup({
      "main.tex": "\\input{chapter}",
      "chapter.tex": "old",
      "unrelated.tex": "old",
    });
    const unrelated = await h.open("unrelated.tex");
    unrelated.change("other", unrelated.getSnapshot().editVersion);
    h.fail.add("unrelated.tex");
    expect((await prepareLatexDocument(target, h.options)).ok).toBe(true);
    expect(h.writes).toEqual([]);
    const chapter = await h.open("chapter.tex");
    chapter.change("new", chapter.getSnapshot().editVersion);
    h.fail.add("chapter.tex");
    expect((await prepareLatexDocument(target, h.options)).ok).toBe(false);
    expect(h.disk.get("chapter.tex")).toBe("old");
    chapter.release();
    unrelated.release();
  });

  it("waits for a chapter's admission already in flight", async () => {
    const h = setup({ "main.tex": "\\input{chapter}", "chapter.tex": "old" });
    const gate = deferred<void>();
    h.readGate.set("chapter.tex", gate.promise);
    const opening = h.open("chapter.tex").then((lease) => {
      lease.change("new", lease.getSnapshot().editVersion);
      return lease;
    });
    let done = false;
    const preparation = prepareLatexDocument(target, h.options).then((result) => {
      done = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(done).toBe(false);
    gate.resolve();
    const lease = await opening;
    expect((await preparation).ok).toBe(true);
    expect(h.disk.get("chapter.tex")).toBe("new");
    lease.release();
  });

  it("includes a dependency introduced when a pending field is finished", async () => {
    const h = setup({ "main.tex": "old", "chapter.tex": "old chapter" });
    const root = await h.open("main.tex");
    const chapter = await h.open("chapter.tex");
    chapter.change("new chapter", chapter.getSnapshot().editVersion);
    let pending = true;
    h.inputs.register({
      target,
      root: "main.tex",
      pending: () => pending,
      finish: () => {
        if (pending) root.change("\\input{chapter}", root.getSnapshot().editVersion);
        pending = false;
        return true;
      },
    });
    const result = await prepareLatexDocument(target, h.options);
    expect(result.ok).toBe(true);
    expect(h.disk.get("chapter.tex")).toBe("new chapter");
    if (result.ok) expect([...result.revisions.keys()]).toEqual(["main.tex", "chapter.tex"]);
    root.release();
    chapter.release();
  });

  it("refuses an unfinished field in a separately opened included chapter", async () => {
    const h = setup({ "main.tex": "\\input{chapter}", "chapter.tex": "old" });
    h.inputs.register({
      target: { ...target, relativePath: "chapter.tex" },
      root: "chapter.tex",
      pending: () => true,
      finish: () => false,
    });
    const result = await prepareLatexDocument(target, h.options);
    expect(result.ok).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it("refuses an unsaved generic include without installing a second saver", async () => {
    const h = setup({ "main.tex": "\\input{data.txt}", "data.txt": "old" });
    h.optimistic.set("data.txt", "new");
    expect((await prepareLatexDocument(target, h.options)).ok).toBe(false);
    expect(h.registry.has({ ...target, relativePath: "data.txt" })).toBe(false);
    expect(h.writes).toEqual([]);
  });

  it("invalidates its receipt when another view edits after preparation", async () => {
    const h = setup({ "main.tex": "\\input{chapter}", "chapter.tex": "old" });
    const chapter = await h.open("chapter.tex");
    const result = await prepareLatexDocument(target, h.options);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isCurrent()).toBe(true);
    chapter.change("new", chapter.getSnapshot().editVersion);
    expect(result.isCurrent()).toBe(false);
    chapter.release();
  });

  it("notices an unknown chapter edit that arrives during an awaited save", async () => {
    const h = setup({ "main.tex": "\\input{\\chapter}", "chapter.tex": "old" });
    const root = await h.open("main.tex");
    const chapter = await h.open("chapter.tex");
    root.change("\\input{\\chapter}\nEdited root", root.getSnapshot().editVersion);
    const gate = deferred<void>();
    h.writeGate.set("main.tex", gate.promise);
    const writing = root.flushNow();
    const preparation = prepareLatexDocument(target, h.options);
    await Promise.resolve();
    await Promise.resolve();
    chapter.change("new", chapter.getSnapshot().editVersion);
    gate.resolve();
    await writing;
    expect((await preparation).ok).toBe(false);
    root.release();
    chapter.release();
  });

  it("refuses unknown pending fields when includes need TeX to resolve them", async () => {
    const h = setup({ "main.tex": "\\input{\\chapter}" });
    h.inputs.register({
      target: { ...target, relativePath: "chapter.tex" },
      root: "chapter.tex",
      pending: () => true,
      finish: () => false,
    });
    expect((await prepareLatexDocument(target, h.options)).ok).toBe(false);
  });

  it("refuses unknown generic writes while includes cannot be resolved statically", async () => {
    const h = setup({ "main.tex": "\\input{\\chapter}" });
    h.optimistic.set("chapter.txt", "new");
    expect((await prepareLatexDocument(target, h.options)).ok).toBe(false);
  });

  it("does not claim a bibliography's pending bytes are included in the TeX graph", async () => {
    const h = setup({ "main.tex": "\\bibliography{refs}" });
    h.optimistic.set("refs.bib", "new reference");
    expect((await prepareLatexDocument(target, h.options)).ok).toBe(false);
  });

  it("checks unresolved dependency ownership before skipping other pending work", async () => {
    const h = setup({ "main.tex": "\\input{\\chapter}", "chapter.tex": "old" });
    expect((await prepareLatexDocument(target, h.options)).ok).toBe(true);
    const chapter = await h.open("chapter.tex");
    chapter.change("new", chapter.getSnapshot().editVersion);
    expect((await prepareLatexDocument(target, h.options)).ok).toBe(false);
    expect(h.writes).toEqual([]);
    chapter.release();
  });
});
