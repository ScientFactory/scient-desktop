import type { EnvironmentId, ProjectDirectoryEntry } from "@t3tools/contracts";
import { useLayoutEffect } from "react";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

const createNewDocument = vi.hoisted(() => vi.fn());
vi.mock("~/scient/documents/useCreateNewDocument", () => ({
  useCreateNewDocument: () => createNewDocument,
}));
const openConnect = vi.hoisted(() => vi.fn());
vi.mock("~/scient/overleaf/useOverleafFolderConnect", () => ({
  useOverleafConnectDialog: () => ({ openConnect, dialog: null }),
}));

import { useScientFolderActions } from "./useScientFolderActions";

const kinds = new Map<string, ProjectDirectoryEntry["kind"]>([
  ["paper", "directory"],
  ["paper/main.tex", "file"],
  ["notes.md", "file"],
]);
const based = () => createNewDocument.mock.calls.map(([input]) => [input.format, input.base]);

async function folderActions(options: {
  readonly hostFolder?: boolean;
  readonly selectedPath?: string | null;
}) {
  createNewDocument.mockClear();
  const onOpenFileSource = vi.fn();
  let actions!: ReturnType<typeof useScientFolderActions>;
  function Probe() {
    const result = useScientFolderActions({
      environmentId: "env-1" as EnvironmentId,
      cwd: "/work",
      selectedPath: options.selectedPath ?? null,
      entryKinds: { current: kinds },
      hostFolder: options.hostFolder ?? false,
      onOpenFileSource,
    });
    useLayoutEffect(() => {
      actions = result;
    });
    return <div>{result.toolbarButtons}</div>;
  }
  const screen = await render(<Probe />, { router: false });
  return { screen, actions: () => actions, onOpenFileSource };
}

async function chooseNew(
  screen: Awaited<ReturnType<typeof folderActions>>["screen"],
  format: string,
) {
  await userEvent.click(screen.getByRole("button", { name: "New document" }));
  await userEvent.click(screen.getByRole("menuitem", { name: new RegExp(format) }));
}

describe("useScientFolderActions", () => {
  it("offers New document on folders only, and starts it in that folder", async () => {
    const probe = await folderActions({});
    await using _screen = probe.screen;
    const menuIds = (path: string) =>
      probe
        .actions()
        .menuItems(path)
        .map((item) => item.id);
    expect(menuIds("notes.md")).toEqual([]);
    expect(menuIds("paper")).toEqual(["new-document", "connect"]);
    expect(menuIds("drafts/")).toEqual(["new-document", "connect"]);

    expect(probe.actions().handleMenuChoice("copy-mention", "paper")).toBe(false);
    expect(probe.actions().handleMenuChoice("connect:overleaf", "paper")).toBe(true);
    expect(openConnect).toHaveBeenCalledWith("paper");
    expect(probe.actions().handleMenuChoice("new-document:latex", "paper")).toBe(true);
    expect(based()).toEqual([["latex", "paper/"]]);
    // The new document opens in its editor, LaTeX in Visual.
    createNewDocument.mock.calls[0]![0].open("paper/untitled.tex");
    expect(probe.onOpenFileSource).toHaveBeenCalledWith("paper/untitled.tex", undefined, {
      latexPreviewMode: "visual",
    });
  });

  it("starts the Files bar's New in the last selected folder, or the selected file's", async () => {
    const probe = await folderActions({ selectedPath: "paper/main.tex" });
    await using screen = probe.screen;
    await chooseNew(screen, "Markdown");
    probe.actions().rememberSelection("paper");
    await chooseNew(screen, "LaTeX");
    probe.actions().rememberSelection("notes.md");
    await chooseNew(screen, "Markdown");
    expect(based()).toEqual([
      ["markdown", "paper/"],
      ["latex", "paper/"],
      ["markdown", ""],
    ]);
  });

  it("offers nothing in a read-only host folder", async () => {
    const probe = await folderActions({ hostFolder: true });
    await using screen = probe.screen;
    expect(probe.actions().toolbarButtons).toBeNull();
    expect(probe.actions().menuItems("paper")).toEqual([]);
    expect(screen.container.querySelector("button")).toBeNull();
  });
});
