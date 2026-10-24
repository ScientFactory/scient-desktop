import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkspaceFileSessionRegistry } from "~/components/files/workspaceFileSessionRegistry";
import { LatexDocumentInputs, type LatexInputState } from "../latex/latexDocumentInputs";
import { createTestCheckpointStore } from "../markdownEditor/persistence/markdownDraftCheckpointTestkit";
import type { MarkdownPersistenceTransport } from "../markdownEditor/persistence/markdownPersistenceTransport";

vi.mock("../markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
}));

import {
  MarkdownPersistenceRegistry,
  type MarkdownPersistenceTarget,
} from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { EditorCompositions } from "./editorComposition";
import { flushFolderEditors, type LocateFiles, type WindowEditors } from "./flushFolderEditors";

const environmentId = EnvironmentId.make("environment-flush");
const otherEnvironment = EnvironmentId.make("environment-other");
const at = (relativePath: string, cwd = "/work/thesis", environment = environmentId) => ({
  environmentId: environment,
  cwd,
  relativePath,
});

/**
 * The server's placement, by physical identity: "/alias/thesis" is another
 * spelling of "/work/thesis", and files under "/unreadable" cannot be placed.
 */
const locateCalls: Array<ReadonlyArray<string>> = [];
/** Runs while the server is being asked: what a person does meanwhile. */
let duringLocate: () => void = () => {};
const locate: LocateFiles = async (files) => {
  locateCalls.push(files.map((file) => `${file.cwd}/${file.relativePath}`));
  duringLocate();
  return files.map(({ cwd, relativePath }) => {
    if (cwd.startsWith("/unreadable")) return { status: "unknown" as const };
    const root = cwd.replace(/^\/alias\//u, "/work/");
    const full = `${root}/${relativePath}`;
    return full.startsWith("/work/thesis/paper/")
      ? { status: "inside" as const, path: full.slice("/work/thesis/".length) }
      : { status: "outside" as const };
  });
};

/** A fake disk for documents; `beforeWrite` runs inside a file's write. */
function disk() {
  const writes: string[] = [];
  const hooks = new Map<string, () => Promise<void>>();
  let refuse: unknown = null;
  const transport = (target: MarkdownPersistenceTarget): MarkdownPersistenceTransport => ({
    write: async (intent: MarkdownSaveIntent) => {
      if (refuse !== null) throw refuse;
      await hooks.get(target.relativePath)?.();
      writes.push(`${target.cwd}/${target.relativePath}`);
      return { revision: `r${writes.length}:${intent.source}` };
    },
    read: async () => ({ source: "A", revision: "rA" }),
    classifyFailure: (error) => (error === "conflict" ? "conflict" : "terminal"),
    subscribe: () => () => {},
    project: () => {},
  });
  return {
    transport,
    writes,
    beforeWrite: (relativePath: string, hook: () => Promise<void>) => hooks.set(relativePath, hook),
    refuse: (error: unknown) => {
      refuse = error;
    },
  };
}

const initial = (relativePath: string): ProjectReadFileResult => ({
  relativePath,
  contents: "A",
  revision: "rA",
  byteLength: 1,
  truncated: false,
});

type Result = { readonly revision: string };

function windowWith() {
  const documentDisk = disk();
  const documents = new MarkdownPersistenceRegistry({
    checkpointStore: createTestCheckpointStore(),
    createTransport: documentDisk.transport,
    debounceMs: 60_000,
  });
  const sessions = new WorkspaceFileSessionRegistry<Result, Error>();
  const latexInputs = new LatexDocumentInputs();
  const compositions = new EditorCompositions();
  const sessionWrites: string[] = [];
  const leases: Array<{ release: () => void }> = [];

  const openDocument = (target: MarkdownPersistenceTarget, edit = "B") => {
    const lease = documents.acquire(target, initial(target.relativePath))!;
    leases.push(lease);
    expect(lease.change(edit, lease.getSnapshot().editVersion)).toBe(true);
    return lease;
  };
  /** An editor with nothing unsaved. */
  const openCleanDocument = (target: MarkdownPersistenceTarget) => {
    const lease = documents.acquire(target, initial(target.relativePath))!;
    leases.push(lease);
    return lease;
  };
  const openFile = (target: MarkdownPersistenceTarget, persistFails?: "conflict") => {
    const lease = sessions.acquire({
      key: `${target.environmentId}:${target.cwd}/${target.relativePath}`,
      target,
      debounceMs: 60_000,
      initialRevision: "rA",
      initialSource: "A",
      journalStore: createTestCheckpointStore(),
      revisionFromResult: (result) => result.revision,
      classifyFailure: () => "conflict",
      persist: async () => {
        if (persistFails)
          return AsyncResult.failure<Result, Error>(Cause.fail(new Error("Revision changed")));
        sessionWrites.push(target.relativePath);
        return AsyncResult.success({ revision: `r${sessionWrites.length}` });
      },
    });
    leases.push(lease);
    lease.change("B");
    return lease;
  };
  /** A LaTeX Visual editor of `target` whose document's root is `root`. */
  const openVisual = (
    target: MarkdownPersistenceTarget,
    root: string,
    state: LatexInputState,
    calls: string[],
  ) =>
    latexInputs.register({
      target,
      root,
      finish: () => state === "clean",
      pending: () => state !== "clean",
      inspect: () => {
        calls.push(`inspect ${target.relativePath}`);
        return state;
      },
      commit: () => {
        calls.push(`commit ${target.relativePath}`);
        return state;
      },
    });
  const editors: WindowEditors = { documents, fileSessions: sessions, latexInputs, compositions };
  return {
    editors,
    documentDisk,
    sessionWrites,
    compositions,
    openDocument,
    openCleanDocument,
    openFile,
    openVisual,
    dispose: () => {
      for (const lease of leases) lease.release();
      sessions.clear();
    },
  };
}

describe("flushFolderEditors", () => {
  let window: ReturnType<typeof windowWith>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    locateCalls.length = 0;
    duringLocate = () => {};
    window = windowWith();
  });
  afterEach(() => {
    window.dispose();
    vi.useRealTimers();
  });

  it("saves the editors the server places in the folder, under any spelling, and nothing else", async () => {
    window.openDocument(at("paper/main.md"));
    window.openDocument(at("paper/sections/intro.md", "/alias/thesis"));
    window.openDocument(at("notes/outside.md"));
    window.openDocument(at("paper/main.md", "/work/thesis-review"));
    window.openDocument(at("paper/main.md", "/work/thesis", otherEnvironment));
    window.openFile(at("paper/data.csv"));
    window.openFile(at("notes/todo.txt"));

    const answer = await flushFolderEditors(environmentId, window.editors, locate);

    expect(answer).toEqual({
      saved: ["paper/data.csv", "paper/main.md", "paper/sections/intro.md"],
      failures: [],
    });
    expect(window.documentDisk.writes.toSorted()).toEqual([
      "/alias/thesis/paper/sections/intro.md",
      "/work/thesis/paper/main.md",
    ]);
    expect(window.sessionWrites).toEqual(["paper/data.csv"]);
    // Only this environment's files are placed, each once.
    expect(locateCalls).toHaveLength(1);
    expect(locateCalls[0]).toHaveLength(6);
  });

  it("names each file it could not save, with the reason, and still saves the rest", async () => {
    window.openDocument(at("paper/main.md"));
    const visual = window.openDocument(at("paper/visual.md"));
    expect(
      visual.retainPendingInput({ message: "A table cell is not valid yet.", payload: {} }),
    ).toBe(true);
    window.openFile(at("paper/changed.txt"), "conflict");
    // A source editor whose input method is composing, for a file with no other unsaved text.
    window.compositions.register(
      () => at("paper/source.md"),
      () => true,
    );
    window.openVisual(at("paper/main.tex"), "paper/main.tex", "unconverted", []);

    const answer = await flushFolderEditors(environmentId, window.editors, locate);

    expect(answer.saved).toEqual(["paper/main.md"]);
    expect(answer.failures.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      {
        path: "paper/changed.txt",
        reason: "conflict",
        message: "This file changed on disk while its editor held unsaved text.",
      },
      {
        path: "paper/main.tex",
        reason: "unconverted-input",
        message: "The visual editor holds input it could not turn into source yet.",
      },
      {
        path: "paper/source.md",
        reason: "composing",
        message: "An input method is still composing text in this file's editor.",
      },
      {
        path: "paper/visual.md",
        reason: "unconverted-input",
        message: "A table cell is not valid yet.",
      },
    ]);
  });

  it("commits Visual input only for editors of files in the folder", async () => {
    const calls: string[] = [];
    window.openVisual(at("paper/main.tex"), "paper/main.tex", "clean", calls);
    // A chapter outside the folder, in a document whose root is inside: inspected only.
    window.openVisual(at("shared/chapter.tex"), "paper/main.tex", "unconverted", calls);
    window.openVisual(at("notes/other.tex"), "notes/other.tex", "unconverted", calls);

    const answer = await flushFolderEditors(environmentId, window.editors, locate);

    expect(calls.filter((call) => call.startsWith("commit"))).toEqual(["commit paper/main.tex"]);
    expect(calls).not.toContain("inspect notes/other.tex");
    expect(answer.failures).toEqual([
      {
        path: "paper/main.tex",
        reason: "unconverted-input",
        message: "The visual editor holds input it could not turn into source yet.",
      },
    ]);
  });

  it("names a document whose save failed", async () => {
    window.openDocument(at("paper/main.md"));
    window.documentDisk.refuse(new Error("disk full"));

    const answer = await flushFolderEditors(environmentId, window.editors, locate);

    expect(answer).toEqual({
      saved: [],
      failures: [
        { path: "paper/main.md", reason: "save-failed", message: "Saving this file failed." },
      ],
    });
  });

  it("fails a file the server cannot place when its editor holds unsaved text", async () => {
    window.openDocument(at("paper/main.md", "/unreadable/thesis"));
    expect(await window.openFile(at("paper/clean.txt", "/unreadable/thesis")).flush()).toBe(true);

    const answer = await flushFolderEditors(environmentId, window.editors, locate);

    expect(window.documentDisk.writes).toEqual([]);
    expect(answer.failures).toEqual([
      {
        path: "/unreadable/thesis/paper/main.md",
        reason: "save-failed",
        message:
          "This file has unsaved text, and the server could not tell whether it is in the folder.",
      },
    ]);
  });

  it("saves again when an editor changes or opens while the folder is being saved", async () => {
    const first = window.openDocument(at("paper/a.md"));
    window.openDocument(at("paper/b.md"));
    const firstWritten = Promise.withResolvers<void>();
    window.documentDisk.beforeWrite("paper/a.md", async () => firstWritten.resolve());
    let interfered = false;
    window.documentDisk.beforeWrite("paper/b.md", async () => {
      if (interfered) return;
      interfered = true;
      await firstWritten.promise;
      // While b saves: a is edited after its save, and c is opened with unsaved text.
      expect(first.change("A2", first.getSnapshot().editVersion)).toBe(true);
      window.openDocument(at("paper/c.md"));
    });

    const answer = await flushFolderEditors(environmentId, window.editors, locate);

    expect(answer).toEqual({ saved: ["paper/a.md", "paper/b.md", "paper/c.md"], failures: [] });
    expect(window.documentDisk.writes.filter((path) => path.endsWith("/a.md"))).toHaveLength(2);
    expect(window.documentDisk.writes).toContain("/work/thesis/paper/c.md");
  });

  it("rechecks an editor opened while the server was being asked, and saves it", async () => {
    window.openDocument(at("paper/b.md"));
    let opened = false;
    window.documentDisk.beforeWrite("paper/b.md", async () => {
      // A clean editor opened during the save: placing it is the final question to the server.
      if (!opened) window.openCleanDocument(at("paper/c.md"));
    });
    duringLocate = () => {
      if (locateCalls.length !== 2 || opened) return;
      opened = true;
      // ...and while that question is out, another editor opens with unsaved text.
      window.openDocument(at("paper/dirty-d.md"));
    };

    const answer = await flushFolderEditors(environmentId, window.editors, locate);

    expect(answer).toEqual({
      saved: ["paper/b.md", "paper/c.md", "paper/dirty-d.md"],
      failures: [],
    });
  });

  it("fails an editor with unsaved text that still could not be placed", async () => {
    window.openDocument(at("paper/a.md"));
    let opened = 0;
    // Each question to the server, a new editor opens with unsaved text.
    duringLocate = () => void window.openDocument(at(`paper/new-${opened++}.md`));

    const answer = await flushFolderEditors(environmentId, window.editors, locate);

    expect(answer.failures).toContainEqual({
      path: `/work/thesis/paper/new-${opened - 1}.md`,
      reason: "save-failed",
      message:
        "This file has unsaved text, and the server could not tell whether it is in the folder.",
    });
    expect(answer.saved).toContain("paper/a.md");
  });

  it("fails a file that is edited again during every save", async () => {
    window.openDocument(at("paper/main.md"));
    let flushes = 0;
    const restless = at("paper/notes.txt");
    const editors: WindowEditors = {
      ...window.editors,
      fileSessions: {
        sessionTargets: () => [restless],
        flushWhere: async (select) => {
          flushes += 1;
          return select(restless) ? [{ target: restless, saved: true }] : [];
        },
        // Typed into again right after each save.
        unsavedWhere: (select) => (select(restless) ? [{ target: restless, problem: null }] : []),
      },
    };

    const answer = await flushFolderEditors(environmentId, editors, locate);

    expect(flushes).toBe(2);
    expect(answer).toEqual({
      saved: ["paper/main.md"],
      failures: [
        {
          path: "paper/notes.txt",
          reason: "save-failed",
          message: "This file was edited again while the folder was being saved.",
        },
      ],
    });
  });
});

describe("EditorCompositions", () => {
  it("follows the editor's current file and reports only composing editors", () => {
    const compositions = new EditorCompositions();
    let path = "paper/old.md";
    let composing = false;
    const release = compositions.register(
      () => at(path),
      () => composing,
    );
    const inPaper = (target: MarkdownPersistenceTarget) => target.relativePath.startsWith("paper/");
    expect(compositions.composingWhere(inPaper)).toEqual([]);
    composing = true;
    path = "paper/new.md";
    expect(compositions.composingWhere(inPaper)).toEqual([at("paper/new.md")]);
    release();
    expect(compositions.targets()).toEqual([]);
  });
});
