import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { AsyncResult } from "effect/reactivity";
import * as Cause from "effect/Cause";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { WorkspaceFileSessionRegistry } from "~/components/files/workspaceFileSessionRegistry";
import { createTestCheckpointStore } from "../markdownEditor/persistence/markdownDraftCheckpointTestkit";
import type { MarkdownPersistenceTransport } from "../markdownEditor/persistence/markdownPersistenceTransport";

vi.mock("../markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
}));

import {
  documentIdentity,
  MarkdownPersistenceRegistry,
  type MarkdownPersistenceLease,
  type MarkdownPersistenceTarget,
} from "../markdownEditor/persistence/markdownPersistenceRegistry";
import { flushFolderEditors, folderFileMatcher, type WindowEditors } from "./flushFolderEditors";

const environmentId = EnvironmentId.make("environment-flush");
const otherEnvironment = EnvironmentId.make("environment-other");
const request = { checkoutRoot: "/work/thesis", folder: "paper" };
const at = (relativePath: string, cwd = "/work/thesis", environment = environmentId) => ({
  environmentId: environment,
  cwd,
  relativePath,
});

/** One file on a fake disk; `refuse` makes its next writes fail with that error. */
function disk() {
  const files = new Map<string, { source: string; revision: string }>();
  const writes: string[] = [];
  let refuse: unknown = null;
  const keyOf = (target: MarkdownPersistenceTarget) =>
    `${target.environmentId}:${target.cwd}/${target.relativePath}`;
  const transport = (target: MarkdownPersistenceTarget): MarkdownPersistenceTransport => ({
    write: async (intent: MarkdownSaveIntent) => {
      if (refuse !== null) throw refuse;
      writes.push(keyOf(target));
      const revision = `r${writes.length}`;
      files.set(keyOf(target), { source: intent.source, revision });
      return { revision };
    },
    read: async () => files.get(keyOf(target)) ?? { source: "A", revision: "rA" },
    classifyFailure: (error) => (error === "conflict" ? "conflict" : "terminal"),
    subscribe: () => () => {},
    project: () => {},
  });
  return {
    transport,
    writes,
    keyOf,
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
  const sessionWrites: string[] = [];
  const leases: Array<{ release: () => void }> = [];
  const finished: MarkdownPersistenceTarget[] = [];
  const unfinished: Array<{ target: MarkdownPersistenceTarget; pending: boolean }> = [];
  const composing = new Set<string>();

  const openDocument = (target: MarkdownPersistenceTarget, edit = "B") => {
    const lease = documents.acquire(target, initial(target.relativePath))!;
    leases.push(lease);
    expect(lease.change(edit, lease.getSnapshot().editVersion)).toBe(true);
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
  const editors: WindowEditors = {
    documents,
    fileSessions: (select) => sessions.flushWhere(select),
    latexInputs: {
      finishWhere: (select) => {
        finished.push(...[at("paper/main.tex"), at("notes/draft.tex")].filter(select));
        return unfinished.filter(({ target }) => select(target));
      },
    },
    documentEditorsSettled: (documentId) => !composing.has(documentId),
  };
  return {
    editors,
    documentDisk,
    sessionWrites,
    finished,
    unfinished,
    composeIn: (lease: MarkdownPersistenceLease) => composing.add(documentIdentity(lease)),
    openDocument,
    openFile,
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
    window = windowWith();
  });
  afterEach(() => {
    window.dispose();
    vi.useRealTimers();
  });

  it("saves documents and file editors under the folder and leaves every other file alone", async () => {
    window.openDocument(at("paper/main.md"));
    window.openDocument(at("paper/sections/intro.md"));
    window.openDocument(at("notes/outside.md"));
    // Same relative path in another copy of the project, and in another environment.
    window.openDocument(at("paper/main.md", "/work/thesis-review"));
    window.openDocument(at("paper/main.md", "/work/thesis", otherEnvironment));
    window.openFile(at("paper/data.csv"));
    window.openFile(at("notes/todo.txt"));

    const answer = await flushFolderEditors(environmentId, request, window.editors);

    expect(answer).toEqual({
      saved: ["paper/data.csv", "paper/main.md", "paper/sections/intro.md"],
      failures: [],
    });
    expect(window.documentDisk.writes.toSorted()).toEqual([
      window.documentDisk.keyOf(at("paper/main.md")),
      window.documentDisk.keyOf(at("paper/sections/intro.md")),
    ]);
    expect(window.sessionWrites).toEqual(["paper/data.csv"]);
    // Visual input is finished only for editors of files in the folder.
    expect(window.finished).toEqual([at("paper/main.tex")]);
  });

  it("names each file it could not save, with the reason, and still saves the rest", async () => {
    window.openDocument(at("paper/main.md"));
    const visual = window.openDocument(at("paper/visual.md"));
    expect(
      visual.retainPendingInput({ message: "A table cell is not valid yet.", payload: {} }),
    ).toBe(true);
    window.composeIn(window.openDocument(at("paper/composing.md")));
    window.openFile(at("paper/changed.txt"), "conflict");
    window.unfinished.push({ target: at("paper/main.tex"), pending: true });

    const answer = await flushFolderEditors(environmentId, request, window.editors);

    expect(answer.saved).toEqual(["paper/main.md"]);
    expect(answer.failures.toSorted((a, b) => a.path.localeCompare(b.path))).toEqual([
      {
        path: "paper/changed.txt",
        reason: "conflict",
        message: "This file changed on disk while its editor held unsaved text.",
      },
      {
        path: "paper/composing.md",
        reason: "composing",
        message: "An input method is still composing text in this file's editor.",
      },
      {
        path: "paper/main.tex",
        reason: "unconverted-input",
        message: "The visual editor holds input it could not turn into source yet.",
      },
      {
        path: "paper/visual.md",
        reason: "unconverted-input",
        message: "A table cell is not valid yet.",
      },
    ]);
  });

  it("names a document whose save failed", async () => {
    window.openDocument(at("paper/main.md"));
    window.documentDisk.refuse(new Error("disk full"));

    const answer = await flushFolderEditors(environmentId, request, window.editors);

    expect(answer).toEqual({
      saved: [],
      failures: [
        { path: "paper/main.md", reason: "save-failed", message: "Saving this file failed." },
      ],
    });
  });
});

describe("folderFileMatcher", () => {
  it("takes the whole checkout for the root folder, and nothing outside it", () => {
    const pathOf = folderFileMatcher(environmentId, { checkoutRoot: "/work/thesis", folder: "" });
    expect(pathOf(at("main.tex"))).toBe("main.tex");
    expect(pathOf(at("paper/main.tex"))).toBe("paper/main.tex");
    expect(pathOf(at("main.tex", "/work/thesis/paper"))).toBe("paper/main.tex");
    expect(pathOf(at("main.tex", "/work/thesis-copy"))).toBeNull();
    expect(pathOf(at("../thesis-copy/main.tex"))).toBeNull();
  });

  it("compares Windows paths without regard to case or separator", () => {
    const pathOf = folderFileMatcher(environmentId, {
      checkoutRoot: "C:\\Users\\me\\Thesis",
      folder: "paper",
    });
    expect(pathOf(at("Paper\\Main.tex", "c:/users/me/thesis"))).toBe("Paper/Main.tex");
    expect(pathOf(at("notes\\a.tex", "C:\\Users\\me\\Thesis"))).toBeNull();
  });
});
