// @vitest-environment happy-dom
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { writeFile, queryData } = vi.hoisted(() => ({
  writeFile: vi.fn(),
  // What the file query holds for each included file, as an optimistic cache would.
  queryData: new Map<string, { contents: string; revision: string; truncated: boolean }>(),
}));
vi.mock("~/state/projects", () => ({
  projectEnvironment: { writeFile: {}, fileChanges: () => ({}) },
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => writeFile }));
vi.mock("@effect/atom-react", async () => {
  const { AsyncResult: Result } = await import("effect/unstable/reactivity");
  return { useAtomValue: () => Result.initial() };
});
vi.mock("~/components/files/projectFilesQueryState", () => ({
  confirmProjectFileQueryData: () => {},
  getOptimisticProjectFileQueryData: () => null,
  setProjectFileQueryData: () => {},
  useProjectFileQuery: (_environment: unknown, _cwd: unknown, file: string) => ({
    data: queryData.get(file),
    error: null,
    refresh: () => {},
  }),
}));
vi.mock("./LatexVisualEditor", () => ({ LatexVisualEditor: () => null }));

import {
  clearWorkspaceFileSessionsForTests,
  useFileSaveCoordinator,
} from "~/components/files/useFileSaveCoordinator";

import { assembleVisualProject } from "./latexProjectVisual";
import { LatexProjectVisualEditor } from "./LatexProjectVisualEditor";
import { clearVisualDraft } from "./visualDrafts";

const environmentId = EnvironmentId.make("project-retirement");
const cwd = "/workspace";
const path = "main.tex";
const KEY = `${environmentId}\0${cwd}\0project-visual:${path}`;
const SLOT = `scient:latex-visual-draft:source:${KEY}`;
const tex = (body: string) =>
  `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}`;
const RECOVERED = tex("Recovered and not saved yet");
const record = JSON.stringify({ source: RECOVERED, baseRevision: "r1" });

/**
 * The surface's wiring around the project editor: the open file's shared saver,
 * its pending flag, and the report that the saver has been read once.
 */
function Surface(props: {
  source: string;
  onChange?: (change: (contents: string) => void) => void;
}) {
  const [pending, setPending] = useState(false);
  const coordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath: path,
    revision: "r1",
    saveResolution: null,
    onPendingChange: (_path, value) => setPending(value),
    onSaveConfirmed: () => {},
    onSaveFailure: () => {},
    onSaveResolutionApplied: () => {},
  });
  const [saverReported, setSaverReported] = useState(false);
  useEffect(() => setSaverReported(true), []);
  const onChange = props.onChange;
  useEffect(() => onChange?.(coordinator.change), [coordinator, onChange]);
  return (
    <LatexProjectVisualEditor
      environmentId={environmentId}
      cwd={cwd}
      relativePath={path}
      rootRelativePath={path}
      source={props.source}
      fileRevision="r1"
      fileTruncated={false}
      selectedPending={pending}
      selectedSaverReady={saverReported}
      draftKey="unused"
      disabled={false}
      saveResolution={null}
      onEdit={() => true}
      onEditingChange={() => {}}
      onOpenSource={() => {}}
      onOpenFileSource={() => {}}
      onPendingChange={() => {}}
      onSaveConfirmed={() => {}}
      onSaveFailure={() => {}}
      onSaveResolutionApplied={() => {}}
      onProjectStateChange={() => {}}
    />
  );
}

/** Another view of an included file, holding its shared saver. */
function ChapterView(props: {
  file: string;
  onChange: (change: (contents: string) => void) => void;
}) {
  const coordinator = useFileSaveCoordinator({
    environmentId,
    cwd,
    relativePath: props.file,
    revision: "c1",
    saveResolution: null,
    onPendingChange: () => {},
    onSaveConfirmed: () => {},
    onSaveFailure: () => {},
    onSaveResolutionApplied: () => {},
  });
  const onChange = props.onChange;
  useEffect(() => onChange(coordinator.change), [coordinator, onChange]);
  return null;
}

describe("retiring the project's recovery copy", () => {
  let containers: HTMLDivElement[];
  let roots: ReturnType<typeof createRoot>[];
  let acknowledge: () => void;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    clearWorkspaceFileSessionsForTests();
    localStorage.clear();
    clearVisualDraft(KEY);
    queryData.clear();
    containers = [];
    roots = [];
    writeFile.mockReset().mockImplementation(
      () =>
        new Promise((resolve) => {
          acknowledge = () => resolve(AsyncResult.success({ revision: "r2" }));
        }),
    );
  });
  afterEach(async () => {
    for (const root of roots) await act(async () => root.unmount());
    for (const container of containers) container.remove();
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
    localStorage.setItem(SLOT, record);
    await mount(<Surface source={RECOVERED} />);
    expect(localStorage.getItem(SLOT)).toBeNull();
  });

  it("keeps it when a second view opens while the shared saver still has that source unsaved", async () => {
    // A first view put the source into the shared saver; its write has not returned.
    let change!: (contents: string) => void;
    await mount(<Surface source={tex("File")} onChange={(next) => (change = next)} />);
    await act(async () => change(RECOVERED));
    localStorage.setItem(SLOT, record);

    // A second view of the same file starts with its own flags at idle, and
    // learns of the pending work only from the saver's report after mounting.
    await mount(<Surface source={RECOVERED} />);
    expect(localStorage.getItem(SLOT)).toBe(record);

    // The copy goes only once the write is acknowledged.
    await settle(600);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(localStorage.getItem(SLOT)).toBe(record);
    await act(async () => acknowledge());
    await settle(20);
    expect(localStorage.getItem(SLOT)).toBeNull();
  });

  it("keeps it when an included file returns while its shared saver has unsaved work", async () => {
    const withChapter = tex("Root intro.\n\n\\input{chapter}");
    const withoutChapter = tex("Root intro.");
    const chapter = {
      contents: "Chapter text, not saved yet.\n",
      revision: "c1",
      truncated: false,
    };
    queryData.set("chapter.tex", chapter);
    const assembled = assembleVisualProject(
      path,
      new Map([
        [path, { contents: withChapter, revision: "r1", truncated: false }],
        ["chapter.tex", chapter],
      ]),
    ).source;
    const copy = JSON.stringify({ source: assembled, baseRevision: "r1" });

    // The project shows the chapter, then the include is removed. The chapter's
    // session ends, but the project still has the chapter's text from it.
    const render = await mount(<Surface source={withChapter} />);
    await render(<Surface source={withoutChapter} />);

    // Meanwhile another view queues that text in the chapter's shared saver.
    let change!: (contents: string) => void;
    await mount(<ChapterView file="chapter.tex" onChange={(next) => (change = next)} />);
    await act(async () => change(chapter.contents));
    localStorage.setItem(SLOT, copy);

    // The include returns. The document can be assembled at once from the text
    // kept earlier, before the chapter's new session has reported anything.
    await render(<Surface source={withChapter} />);
    expect(localStorage.getItem(SLOT)).toBe(copy);

    await settle(600);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(localStorage.getItem(SLOT)).toBe(copy);
    await act(async () => acknowledge());
    await settle(20);
    expect(localStorage.getItem(SLOT)).toBeNull();
  });
});
