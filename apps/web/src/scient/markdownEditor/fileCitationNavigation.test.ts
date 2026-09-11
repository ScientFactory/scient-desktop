import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type FileCitation } from "@t3tools/contracts";
import {
  fileCitationHash,
  fileCitationFromLocation,
  fileCitationNavigation,
  openFileCitation,
} from "./fileCitationNavigation";
import { useRightPanelStore } from "~/rightPanelStore";

const citation: FileCitation = {
  kind: "file",
  version: 1,
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("source"),
  cwd: "/original/worktree",
  path: "notes/report #2.md",
  revision: `sha256:${"a".repeat(64)}`,
  origin: "saved",
  sourceStart: 0,
  sourceEnd: 20,
  startLine: 1,
  endLine: 2,
  from: 1,
  to: 5,
  text: "שלום",
  prefix: "",
  suffix: "",
};
const open = (value: FileCitation, cwd = value.cwd) =>
  openFileCitation(value, cwd, (_surfaceId, run) => run());

describe("file citation navigation", () => {
  it("round-trips copied routes without depending on the current environment or basename", () => {
    expect(fileCitationFromLocation(`/remote/source#${fileCitationHash(citation)}`)).toEqual(
      citation,
    );
    expect(fileCitationFromLocation("/remote/source#file-citation=invalid")).toBeNull();
    expect(fileCitationFromLocation("/remote/source")).toBeNull();
    expect(fileCitationNavigation(citation).params).toEqual({
      environmentId: "remote",
      threadId: "source",
    });
    expect(fileCitationNavigation(citation).state).not.toEqual(
      fileCitationNavigation(citation).state,
    );
  });
  it("uses the original cwd in a transient reveal, and does not force source-line mode", () => {
    open(citation);
    const state = useRightPanelStore.getState().byThreadKey;
    const surface = Object.values(state)
      .flatMap((entry) => entry.surfaces)
      .find((entry) => entry.kind === "file" && entry.relativePath === citation.path);
    expect(surface).toMatchObject({
      kind: "file",
      relativePath: citation.path,
      revealLine: null,
      fileCitation: citation,
    });
    const persisted = useRightPanelStore.persist.getOptions().partialize!(
      useRightPanelStore.getState(),
    );
    expect(JSON.stringify(persisted)).not.toContain("fileCitation");
    expect(JSON.stringify(persisted)).not.toContain(citation.text);
  });
  it("does not resolve a quote against a newer thread worktree or reinterpret filename punctuation", () => {
    const original = { ...citation, path: "notes/report #2.md:42" };
    open(original, "/new/worktree");
    const surfaces = Object.values(useRightPanelStore.getState().byThreadKey).flatMap(
      (entry) => entry.surfaces,
    );
    const opened = surfaces.find(
      (surface) =>
        surface.kind === "file" &&
        surface.relativePath === "/original/worktree/notes/report #2.md:42",
    );
    expect(opened).toMatchObject({ kind: "file", revealLine: null });
    expect(opened).not.toHaveProperty("fileCitation");
  });
  it("defers source navigation through the existing pending-save policy", () => {
    const navigate = vi.spyOn(useRightPanelStore.getState(), "openFile");
    const guard = vi.fn<(surfaceId: string, run: () => void) => void>();
    openFileCitation(citation, citation.cwd, guard);
    expect(navigate).not.toHaveBeenCalled();
    expect(guard.mock.calls[0]?.[0]).toBe(`file:${citation.path}`);
    guard.mock.calls[0]![1]();
    expect(navigate).toHaveBeenCalledOnce();
    navigate.mockRestore();
  });
});
