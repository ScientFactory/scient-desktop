import { render as _fixtureRender, type Screen, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
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
  const change = vi.fn();
  async function _setupFixture0(_fixture: _Fixture) {
    change.mockReset();
    _fixture.container = document.createElement("div");
    document.body.append(_fixture.container);
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: _fixture.container, router: false }),
    );
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    await act(async () => await _fixture.root0.unmount());
    _fixture.container.remove();
    vi.unstubAllGlobals();
  }
  const render = async (_fixture: _Fixture) => {
    await act(
      async () =>
        await _fixture.root0.rerender(
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture);
    const option = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (node) => node.textContent === "Automatic",
    )!;
    await act(() => option.click());
    expect(change).toHaveBeenCalledExactlyOnceWith("automatic");
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    container: undefined! as HTMLDivElement,
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
