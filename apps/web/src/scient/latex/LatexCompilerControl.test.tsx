// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { ScientLatexToolchainReport } from "@t3tools/contracts";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "~/components/ui/menu";
import { LatexCompilerMenuItems } from "./LatexCompilerControl";

const report: ScientLatexToolchainReport = {
  kind: "tectonic",
  executable: "tectonic",
  version: "0.17.0",
  probedAtEpochMs: 1,
  canInstallManaged: true,
  compilers: [],
};

describe("document compiler menu", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;
  const change = vi.fn();
  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    change.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async () => {
    await act(async () =>
      root.render(
        <DropdownMenu defaultOpen>
          <DropdownMenuTrigger>Menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <LatexCompilerMenuItems
              source={"% !TEX program = tectonic\nDocument body"}
              report={report}
              offline={false}
              blockedReason={null}
              busy={false}
              onChange={change}
              rootPath="paper.tex"
              onOpenRoot={null}
              capabilityError={null}
            />
          </DropdownMenuContent>
        </DropdownMenu>,
      ),
    );
  };
  it("selects Tectonic without an unsupported warning or redundant header rows", async () => {
    await render();
    const option = [...document.querySelectorAll('[role="menuitemradio"]')].find(
      (node) => node.textContent === "Tectonic",
    )!;
    expect(option.getAttribute("aria-checked")).toBe("true");
    expect(document.body.textContent).not.toContain("Source declaration");
    expect(document.body.textContent).not.toContain("paper.tex");
    expect(document.body.textContent).not.toContain("Unsupported");
    expect(change).not.toHaveBeenCalled();
  });
  it("lets the user deliberately return a Tectonic declaration to Automatic", async () => {
    await render();
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (node) => node.textContent === "Automatic",
    )!;
    await act(() => option.click());
    expect(change).toHaveBeenCalledExactlyOnceWith("automatic");
  });
});
