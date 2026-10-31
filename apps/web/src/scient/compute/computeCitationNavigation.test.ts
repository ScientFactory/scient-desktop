import {
  EnvironmentId,
  ThreadId,
  type ComputeCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const panel = vi.hoisted(() => ({
  openFile: vi.fn(),
  openScient: vi.fn(),
  byThreadKey: {} as Record<string, { surfaces: ReadonlyArray<unknown> }>,
}));
const toast = vi.hoisted(() => ({ add: vi.fn() }));
const contexts = vi.hoisted(() => ({ bindings: {} as Record<string, { sessionId: string }> }));
const presentation = vi.hoisted(() => ({
  presentations: {} as Record<string, { view: string }>,
  setFileView: vi.fn(),
}));
const requestReveal = vi.hoisted(() => vi.fn());

vi.mock("~/rightPanelStore", () => ({
  useRightPanelStore: { getState: () => panel },
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: toast }));
vi.mock("./computeContextStore", () => ({
  computeFileContextId: (input: { relativePath: string }) => `file:${input.relativePath}`,
  useComputeContextStore: { getState: () => contexts },
}));
vi.mock("./computeFilePresentationStore", () => ({
  useComputeFilePresentationStore: { getState: () => presentation },
}));
vi.mock("./computeQuoteReveal", () => ({ requestComputeQuoteReveal: requestReveal }));

import {
  computeCitationFromLocation,
  computeCitationHash,
  openComputeCitation,
} from "./computeCitationNavigation";

const ref: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const quote = (place: ComputeCitation["place"], cwd = "/project"): ComputeCitation => ({
  kind: "compute",
  version: 1,
  ...ref,
  cwd,
  place,
  text: "quoted",
  start: 0,
  end: 6,
  prefix: "",
  suffix: "",
});
const run = (path: string | null) =>
  quote({ _tag: "run", sessionId: "session", executionId: "run", path });
const open = (citation: ComputeCitation, cwd = "/project") =>
  openComputeCitation(citation, cwd, (_surface, act) => act());
const consoleTab = {
  id: "console-tab",
  kind: "scient",
  module: "compute",
  cwd: "/project",
  contextId: "console",
};

describe("openComputeCitation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    panel.byThreadKey = { [scopedThreadKey(ref)]: { surfaces: [consoleTab] } };
    contexts.bindings = {};
    presentation.presentations = {};
  });

  it("returns a run to the Console that still holds its session", () => {
    contexts.bindings = { console: { sessionId: "session" } };
    open(run(null));
    expect(panel.openScient).toHaveBeenCalledWith(ref, consoleTab);
    expect(requestReveal).toHaveBeenCalledOnce();
  });

  it("returns a script's run to the script, with its Results in view", () => {
    contexts.bindings = {
      console: { sessionId: "session" },
      "file:fit.py": { sessionId: "session" },
    };
    presentation.presentations = { "file:fit.py": { view: "code" } };
    open(run("fit.py"));
    expect(panel.openFile).toHaveBeenCalledWith(ref, "fit.py");
    expect(panel.openScient).not.toHaveBeenCalled();
    expect(presentation.setFileView).toHaveBeenCalledWith("file:fit.py", "split");
  });

  it("leaves a script's view alone when its Results already show", () => {
    contexts.bindings = { "file:fit.py": { sessionId: "session" } };
    presentation.presentations = { "file:fit.py": { view: "results" } };
    open(run("fit.py"));
    expect(presentation.setFileView).not.toHaveBeenCalled();
  });

  it.each([
    ["the Console moved to a new session", null],
    ["the script moved to a new session", "fit.py"],
    ["a notebook has no Results feed", "analysis.ipynb"],
  ])("opens project Results when %s", (_case, path) => {
    contexts.bindings = {
      console: { sessionId: "newer" },
      "file:fit.py": { sessionId: "newer" },
      "file:analysis.ipynb": { sessionId: "session" },
    };
    open(run(path));
    expect(panel.openFile).not.toHaveBeenCalled();
    const surface = panel.openScient.mock.calls[0]?.[1] as { cwd: string; contextId?: string };
    expect(surface.cwd).toBe("/project");
    expect(surface.contextId).toBeUndefined();
  });

  it("opens a cell's notebook and asks it to show the quote", () => {
    const citation = quote({ _tag: "cell", path: "a.ipynb", cellId: "cell", number: 2 });
    open(citation);
    expect(panel.openFile).toHaveBeenCalledWith(ref, "a.ipynb");
    expect(requestReveal).toHaveBeenCalledWith(citation);
  });

  it("opens the original notebook after the conversation moved workspace", () => {
    open(quote({ _tag: "cell", path: "a.ipynb", cellId: "cell", number: 2 }, "/old/"), "/new");
    expect(panel.openFile).toHaveBeenCalledWith(ref, "/old/a.ipynb");
    expect(requestReveal).not.toHaveBeenCalled();
    expect(toast.add).toHaveBeenCalledOnce();
  });

  it("waits for a pending save before moving away", () => {
    const pending: Array<() => void> = [];
    openComputeCitation(run(null), "/project", (_surface, act) => pending.push(act));
    expect(panel.openScient).not.toHaveBeenCalled();
    expect(requestReveal).not.toHaveBeenCalled();
    pending[0]!();
    expect(panel.openScient).toHaveBeenCalledOnce();
  });
});

describe("compute citation links", () => {
  it("reads a quote back from the route", () => {
    const citation = run("fit.py");
    const href = `/environment/thread#${computeCitationHash(citation)}`;
    expect(computeCitationFromLocation(href)).toEqual(citation);
  });

  it("ignores anything else", () => {
    expect(computeCitationFromLocation("/environment/thread")).toBeNull();
    expect(computeCitationFromLocation("/thread#compute-citation=not-base64!")).toBeNull();
  });
});
