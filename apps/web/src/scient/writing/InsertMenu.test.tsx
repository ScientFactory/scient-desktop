// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { InsertMenu, type InsertMenuAction, type InsertMenuLayout } from "./InsertMenu";

describe("the shared Insert menu", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const ran: string[] = [];
  const actions: readonly InsertMenuAction[] = [
    {
      id: "figure",
      label: "Figure",
      description: "An image with a caption",
      run: () => ran.push("figure"),
    },
    { id: "footnote", label: "Footnote", run: () => ran.push("footnote") },
    {
      id: "citation",
      label: "Citation",
      run: () => ran.push("citation"),
      disabledReason: "No bibliography.",
    },
  ];
  const layout: InsertMenuLayout = (item) => (
    <>
      {item("figure")}
      {item("footnote")}
      {item("citation")}
    </>
  );
  const items = () =>
    [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
      (item) => item.textContent?.trim() ?? "",
    );
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    ran.length = 0;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  async function open() {
    await act(async () => root.render(<InsertMenu actions={actions} layout={layout} />));
    await act(async () =>
      host.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
    );
  }

  it("shows the editor's arrangement, with no search field", async () => {
    await open();
    expect(items()).toEqual(["Figure", "Footnote", "Citation"]);
    expect(document.body.querySelector("input")).toBeNull();
  });

  it("runs an item, but never one that is unavailable", async () => {
    await open();
    const citation = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Citation",
    )!;
    await act(async () => citation.click());
    expect(ran).toEqual([]);
    const footnote = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent?.trim() === "Footnote",
    )!;
    await act(async () => footnote.click());
    await vi.waitFor(() => expect(ran).toEqual(["footnote"]));
  });
});
