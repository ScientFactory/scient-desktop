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
  const search = () =>
    document.body.querySelector<HTMLInputElement>('input[aria-label="Search insert options"]')!;
  const items = () =>
    [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(
      (item) => item.textContent?.trim() ?? "",
    );
  const type = (value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        search(),
        value,
      );
      search().dispatchEvent(new Event("input", { bubbles: true }));
    });
  const enter = (composing: boolean) =>
    act(async () => {
      const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
      if (composing) Object.defineProperty(event, "keyCode", { value: 229 });
      search().dispatchEvent(event);
    });

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

  it("shows the editor's arrangement, then only what matches the search", async () => {
    await open();
    expect(items()).toEqual(["Figure", "Footnote", "Citation"]);
    await type("foot");
    expect(items()).toEqual(["Footnote"]);
    // The description is searched together with the name.
    await type("caption");
    expect(items()).toEqual(["Figure"]);
    await type("nothing like this");
    expect(items()).toEqual([]);
    expect(document.body.textContent).toContain("No matching elements.");
  });

  it("runs the first match on Enter, but not while text is being composed", async () => {
    await open();
    await type("foot");
    await enter(true);
    expect(ran).toEqual([]);
    expect(search()).not.toBeNull();
    await enter(false);
    await vi.waitFor(() => expect(ran).toEqual(["footnote"]));
  });

  it("never runs an item that is unavailable", async () => {
    await open();
    await type("citation");
    await enter(false);
    await act(async () => {});
    expect(ran).toEqual([]);
  });
});
