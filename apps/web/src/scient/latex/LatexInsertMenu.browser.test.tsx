import "../../index.css";
import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { userEvent } from "vite-plus/test/browser";

import { useState } from "react";

import { describe, expect, it, vi } from "vite-plus/test";

import { Menu, MenuPopup } from "~/components/ui/menu";
import { LatexInsertMenu, LatexInsertMenuContent, type LatexInsertAction } from "./LatexInsertMenu";

describe("LaTeX Insert reachability", () => {
  const actions: readonly LatexInsertAction[] = [
    "figure",
    "code",
    "verbatim",
    "citation",
    "reference",
    "link",
    "footnote",
    "theorem",
    "lemma",
    "proposition",
    "corollary",
    "claim",
    "definition",
    "example",
    "remark",
    "proof",
    "question",
    "subquestions",
    "abstract",
    "contents",
    "bibliography",
    "verse",
    "pagebreak",
    "quotation",
    "left-text",
    "right-text",
    "part",
    "future-action",
  ].map((id) => ({ id, label: id, description: id, group: "test", run: vi.fn() }));

  async function _setupFixture0(_fixture: _Fixture) {
    _fixture.host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, _fixture.host));
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.host, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _clearOwnedDOM(_fixture);
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  }

  it.each(["regular", "overflow"])("reaches every action id in the %s menu", async (surface) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    function RegularMenu() {
      const [open, setOpen] = useState(true);
      return (
        <LatexInsertMenu
          open={open}
          onOpenChange={setOpen}
          actions={actions}
          disabled={false}
          onInsertTable={() => {}}
          onReturnFocus={() => {}}
        />
      );
    }
    await act(
      async () =>
        await _fixture.root0.rerender(
          surface === "regular" ? (
            <RegularMenu />
          ) : (
            <Menu open>
              <MenuPopup>
                <LatexInsertMenuContent actions={actions} onInsertTable={() => {}} />
              </MenuPopup>
            </Menu>
          ),
        ),
    );
    const reachable = new Set<string>();
    const collect = () => {
      for (const item of document.body.querySelectorAll('[role="menuitem"][aria-description]')) {
        reachable.add(item.getAttribute("aria-description")!);
      }
    };
    const openCategory = async (name: string) => {
      const trigger = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (item) => item.textContent?.trim() === name,
      )!;
      expect(trigger).toBeDefined();
      await userEvent.click(trigger);
      await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
      const popup = await vi.waitFor(() => {
        const popup = document.getElementById(trigger.getAttribute("aria-controls")!);
        expect(popup).not.toBeNull();
        expect(popup!.querySelector('[role="menuitem"][aria-description]')).not.toBeNull();
        return popup!;
      });
      await userEvent.keyboard("{ArrowRight}");
      await expect.poll(() => popup.contains(document.activeElement)).toBe(true);
      collect();
      await userEvent.keyboard("{Escape}");
      await expect.poll(() => popup.isConnected).toBe(false);
    };
    collect();
    await openCategory("References");
    expect(reachable).toContain("link");
    await openCategory("Theorems & proofs");
    expect(reachable).toContain("question");
    expect(reachable).toContain("subquestions");
    await openCategory("Document blocks");
    expect(reachable).toContain("verse");
    expect([...reachable].sort()).toEqual(actions.map((action) => action.id).sort());

    // The fallback uses the same executable items as explicitly placed actions.
    const future = document.body.querySelector<HTMLElement>(
      '[role="menuitem"][aria-description="future-action"]',
    )!;
    await userEvent.click(future);
    await vi.waitFor(() =>
      expect(actions.find((action) => action.id === "future-action")!.run).toHaveBeenCalledOnce(),
    );
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
