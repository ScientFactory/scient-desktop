// @vitest-environment happy-dom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { Menu, MenuPopup } from "~/components/ui/menu";
import { LatexInsertMenu, LatexInsertMenuContent, type LatexInsertAction } from "./LatexInsertMenu";

describe("LaTeX Insert reachability", () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
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

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(["regular", "overflow"])("reaches every action id in the %s menu", async (surface) => {
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
    await act(async () =>
      root.render(
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
      await act(async () => trigger.click());
      collect();
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
    await act(async () => future.click());
    await vi.waitFor(() =>
      expect(actions.find((action) => action.id === "future-action")!.run).toHaveBeenCalledOnce(),
    );
  });
});
