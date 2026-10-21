import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { InsertMenu, type InsertMenuAction, type InsertMenuLayout } from "./InsertMenu";

describe("the shared Insert menu", () => {
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
  async function _setupFixture0(_fixture: _Fixture) {
    ran.length = 0;
    _fixture.host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, _fixture.host));
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _clearOwnedDOM(_fixture);
    vi.unstubAllGlobals();
  }

  async function open(_fixture: _Fixture) {
    await act(
      async () => await _fixture.root0.rerender(<InsertMenu actions={actions} layout={layout} />),
    );
    await act(async () =>
      _fixture.host.querySelector<HTMLButtonElement>('button[aria-label="Insert"]')!.click(),
    );
  }

  it("shows the editor's arrangement, with no search field", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await open(_fixture);
    expect(items()).toEqual(["Figure", "Footnote", "Citation"]);
    expect(document.body.querySelector("input")).toBeNull();
  });

  it("runs an item, but never one that is unavailable", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await open(_fixture);
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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    host: undefined! as HTMLDivElement,
    stack,
    cleanup,
    root0: undefined! as Screen,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
