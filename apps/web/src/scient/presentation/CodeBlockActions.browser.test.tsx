import { render as _fixtureRender, act } from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";

import { CodeBlockActions } from "./CodeBlockActions";

describe("code block actions", () => {
  async function _setupFixture0(_fixture: _Fixture) {
    await undefined;
  }
  async function _cleanupFixture1(_fixture: _Fixture) {
    _clearOwnedDOM(_fixture);
    vi.unstubAllGlobals();
  }

  async function render(_fixture: _Fixture, wrapped: boolean) {
    const host = document.createElement("div");
    document.body.append(_ownDOM(_fixture, host));
    const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
    await act(
      async () =>
        await root.rerender(
          <CodeBlockActions wrapped={wrapped} onWrapChange={() => {}} readCode={() => "x\n"} />,
        ),
    );
    return host.querySelector<HTMLElement>("[aria-pressed]")!;
  }

  // regression: cff39eeba2 fix(chat): Stop shows what arrived; code blocks and thread-read rows match upstream
  it("shows the wrap toggle on while lines wrap, as upstream's code block does", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const on = await render(_fixture, true);
    expect(on.getAttribute("aria-pressed")).toBe("true");
    expect(on.dataset.variant).toBe("secondary");
    expect((await render(_fixture, false)).dataset.variant).toBe("ghost-muted");
  });

  // regression: 010d58e874 fix(chat): Stop reaches answers that left the screen; thoughts read quietly when expanded
  it("draws the copy button as upstream's: muted, with the morphing icon", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    await render(_fixture, false);
    const copy = document.querySelector<HTMLElement>('[aria-label="Copy code"]')!;
    expect(copy.dataset.variant).toBe("ghost-muted");
    // MorphIcon draws its own svg, not lucide-react's classed icon.
    expect(copy.querySelector("svg")).not.toBeNull();
    expect(copy.querySelector("svg.lucide")).toBeNull();
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
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
