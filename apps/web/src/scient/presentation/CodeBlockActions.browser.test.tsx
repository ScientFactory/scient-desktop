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

  it("shows the wrap toggle pressed only while lines wrap", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect((await render(_fixture, true)).getAttribute("aria-pressed")).toBe("true");
    expect((await render(_fixture, false)).getAttribute("aria-pressed")).toBe("false");
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
