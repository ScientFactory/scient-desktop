// @vitest-environment happy-dom
import { EnvironmentId, type ProjectReadFileResult } from "@t3tools/contracts";
import type { MarkdownSaveIntent } from "@scientfactory/scient-markdown";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { disk } = vi.hoisted(() => ({
  // What is on disk for each file of the synthetic workspace.
  disk: new Map<string, { source: string; revision: string }>(),
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { fileChanges: () => ({}) },
}));
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult } = await import("effect/unstable/reactivity");
  return { useAtomValue: () => AsyncResult.initial() };
});
vi.mock("~/components/files/projectFilesQueryState", () => ({
  useProjectFileQuery: (_environment: unknown, _cwd: unknown, file: string, enabled: boolean) => {
    const onDisk = enabled ? disk.get(file) : undefined;
    return {
      authoritativeData:
        onDisk === undefined
          ? null
          : { relativePath: file, contents: onDisk.source, revision: onDisk.revision },
      error: null,
      refresh: () => {},
    };
  },
}));
vi.mock("~/scient/markdownEditor/persistence/markdownPersistenceTransport", () => ({
  createMarkdownPersistenceTransport: vi.fn(),
}));
vi.mock("./LatexVisualEditor", () => ({ LatexVisualEditor: () => null }));

import {
  markdownPersistenceRegistry,
  type MarkdownPersistenceLease,
} from "~/scient/markdownEditor/persistence/markdownPersistenceRegistry";
import { createMarkdownPersistenceTransport } from "~/scient/markdownEditor/persistence/markdownPersistenceTransport";

import { assembleVisualProject } from "./latexProjectVisual";
import { LatexProjectVisualEditor } from "./LatexProjectVisualEditor";
import { clearVisualDraft } from "./visualDrafts";

const environmentId = EnvironmentId.make("project-retirement");
const path = "main.tex";
const tex = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`;
const RECOVERED = tex("Recovered and not saved yet");

describe("retiring the project's recovery copy", () => {
  let workspace = 0;
  let cwd = "";
  let KEY = "";
  let SLOT = "";
  let record = "";
  let containers: HTMLDivElement[];
  let roots: ReturnType<typeof createRoot>[];
  let leases: MarkdownPersistenceLease[];
  let acknowledge: () => void;
  let writes: number;

  const acquire = (file: string) => {
    const onDisk = disk.get(file)!;
    const initial: ProjectReadFileResult = {
      relativePath: file,
      contents: onDisk.source,
      revision: onDisk.revision,
      byteLength: onDisk.source.length,
      truncated: false,
    };
    const lease = markdownPersistenceRegistry.acquire(
      { environmentId, cwd, relativePath: file },
      initial,
    )!;
    leases.push(lease);
    return lease;
  };

  /** The surface's wiring around the project editor: the open file's session and its pending flag. */
  function Surface(props: { lease: MarkdownPersistenceLease }) {
    const snapshot = useSyncExternalStore(props.lease.subscribe, props.lease.getSnapshot);
    return (
      <LatexProjectVisualEditor
        environmentId={environmentId}
        cwd={cwd}
        relativePath={path}
        rootRelativePath={path}
        source={snapshot.draftSource}
        fileRevision={snapshot.baselineRevision}
        fileTruncated={false}
        selectedPending={snapshot.pending}
        draftKey="unused"
        disabled={false}
        onEdit={() => true}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onOpenFileSource={() => {}}
        onSaved={() => {}}
        onProjectStateChange={() => {}}
      />
    );
  }
  /** A surface whose open file is fixed text, for tests that only vary its includes. */
  function FixedSurface(props: { source: string }) {
    return (
      <LatexProjectVisualEditor
        environmentId={environmentId}
        cwd={cwd}
        relativePath={path}
        rootRelativePath={path}
        source={props.source}
        fileRevision="r1"
        fileTruncated={false}
        selectedPending={false}
        draftKey="unused"
        disabled={false}
        onEdit={() => true}
        onEditingChange={() => {}}
        onOpenSource={() => {}}
        onOpenFileSource={() => {}}
        onSaved={() => {}}
        onProjectStateChange={() => {}}
      />
    );
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    cwd = `/synthetic-retirement-${(workspace += 1)}`;
    KEY = `${environmentId}\0${cwd}\0project-visual:${path}`;
    SLOT = `scient:latex-visual-draft:source:${KEY}`;
    record = JSON.stringify({ source: RECOVERED, baseRevision: "r1" });
    localStorage.clear();
    clearVisualDraft(KEY);
    disk.clear();
    containers = [];
    roots = [];
    leases = [];
    writes = 0;
    vi.mocked(createMarkdownPersistenceTransport).mockImplementation((target) => ({
      write: (intent: MarkdownSaveIntent) =>
        new Promise((resolve) => {
          writes += 1;
          acknowledge = () => {
            const revision = `saved-${writes}`;
            disk.set(target.relativePath, { source: intent.source, revision });
            resolve({ revision });
          };
        }),
      read: async () => disk.get(target.relativePath)!,
      classifyFailure: () => "terminal",
      subscribe: () => () => {},
      project: () => {},
    }));
  });
  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    for (const container of containers) container.remove();
    for (const lease of leases) lease.release();
    clearVisualDraft(KEY);
    vi.unstubAllGlobals();
  });

  async function mount(element: React.ReactElement) {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    containers.push(container);
    roots.push(root);
    await act(async () => root.render(element));
    return (next: React.ReactElement) => act(async () => root.render(next));
  }
  const settle = (ms: number) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));

  it("clears a stored copy that equals a file with nothing unsaved", async () => {
    disk.set(path, { source: RECOVERED, revision: "r1" });
    localStorage.setItem(SLOT, record);
    await mount(<Surface lease={acquire(path)} />);
    expect(localStorage.getItem(SLOT)).toBeNull();
  });

  it("keeps it when a second view opens while the file's session still has that source unsaved", async () => {
    disk.set(path, { source: tex("File"), revision: "r1" });
    // A first view put the source into the file's session; its write has not returned.
    const first = acquire(path);
    await mount(<Surface lease={first} />);
    await act(async () => {
      first.change(RECOVERED, first.getSnapshot().editVersion);
    });
    localStorage.setItem(SLOT, record);

    // A second view of the same file shares that session and its unsaved work.
    await mount(<Surface lease={acquire(path)} />);
    expect(localStorage.getItem(SLOT)).toBe(record);

    // The copy goes only once the write is acknowledged.
    await settle(600);
    expect(writes).toBe(1);
    expect(localStorage.getItem(SLOT)).toBe(record);
    await act(async () => acknowledge());
    await settle(20);
    expect(localStorage.getItem(SLOT)).toBeNull();
  });

  it("keeps it when an included file returns while its session has unsaved work", async () => {
    const withChapter = tex("Root intro.\n\n\\input{chapter}");
    const withoutChapter = tex("Root intro.");
    const unsaved = "Chapter text, not saved yet.\n";
    disk.set("chapter.tex", { source: "Chapter text.\n", revision: "c1" });
    const assembled = assembleVisualProject(
      path,
      new Map([
        [path, { contents: withChapter, revision: "r1", truncated: false }],
        ["chapter.tex", { contents: unsaved, revision: "c1", truncated: false }],
      ]),
    ).source;
    const copy = JSON.stringify({ source: assembled, baseRevision: "r1" });

    // The project shows the chapter, then the include is removed and the
    // project lets go of the chapter's session.
    const render = await mount(<FixedSurface source={withChapter} />);
    await settle(20);
    await render(<FixedSurface source={withoutChapter} />);

    // Meanwhile another view of the chapter types into its session.
    const chapter = acquire("chapter.tex");
    await act(async () => {
      chapter.change(unsaved, chapter.getSnapshot().editVersion);
    });
    localStorage.setItem(SLOT, copy);

    // The include returns, with the chapter's work still unsaved.
    await render(<FixedSurface source={withChapter} />);
    await settle(20);
    expect(localStorage.getItem(SLOT)).toBe(copy);

    await settle(600);
    expect(writes).toBe(1);
    expect(localStorage.getItem(SLOT)).toBe(copy);
    await act(async () => acknowledge());
    await settle(20);
    expect(localStorage.getItem(SLOT)).toBeNull();
  });

  it("does not open a second saver for an included file another view already has open", async () => {
    disk.set("chapter.tex", { source: "Chapter text.\n", revision: "c1" });
    const chapter = acquire("chapter.tex");
    await mount(<FixedSurface source={tex("Root intro.\n\n\\input{chapter}")} />);
    await settle(20);
    // One transport for the chapter: the project joined the session that was there.
    expect(
      vi
        .mocked(createMarkdownPersistenceTransport)
        .mock.calls.filter(
          ([target]) => target.cwd === cwd && target.relativePath === "chapter.tex",
        ),
    ).toHaveLength(1);
    expect(chapter.getSnapshot().draftSource).toBe("Chapter text.\n");
  });
});
