import {
  render as _fixtureRender,
  fakeTimers as _fixtureFakeTimers,
  act,
} from "../../../test/render";

import { describe, expect, it, vi } from "vite-plus/test";
import { ComputeTable } from "./ComputeRichOutput";

async function _setupFixture0(_fixture: _Fixture) {
  _fixture.stack.use(_fixtureFakeTimers());
}
async function _cleanupFixture1(_fixture: _Fixture) {
  for (const cleanup of _fixture.cleanups.splice(0)) await cleanup();
  _clearOwnedDOM(_fixture);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
}
describe("bounded result tables", () => {
  it.each([false, true])(
    "keeps values, missing values and truncation visible: %s",
    async (truncated) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
      await _setupFixture0(_fixture);

      const container = document.createElement("div");
      document.body.append(_ownDOM(_fixture, container));
      const root = _fixture.stack.use(
        await _fixtureRender(null, { container: container, router: false }),
      );
      _fixture.cleanups.push(async () => {
        await act(async () => await root.unmount());
      });
      await act(
        async () =>
          await root.rerender(
            <ComputeTable
              table={{
                columns: ["Label", "Value", "Missing"],
                rows: [["sample", 1.25, null]],
                truncated,
              }}
            />,
          ),
      );
      expect(container.querySelectorAll("th")).toHaveLength(3);
      const cells = container.querySelectorAll("td");
      expect(cells[1]!.textContent).toBe("1.25");
      expect(cells[2]!.textContent).toBe("NaN");
      expect(container.textContent?.includes("First 1 rows")).toBe(truncated);
    },
  );
  it("retains table headers for an empty result", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const container = document.createElement("div");
    document.body.append(_ownDOM(_fixture, container));
    const root = _fixture.stack.use(
      await _fixtureRender(null, { container: container, router: false }),
    );
    _fixture.cleanups.push(async () => {
      await act(async () => await root.unmount());
    });
    await act(
      async () =>
        await root.rerender(
          <ComputeTable table={{ columns: ["Value"], rows: [], truncated: false }} />,
        ),
    );
    expect(container.querySelector("th")?.textContent).toBe("Value");
    expect(container.querySelectorAll("td")).toHaveLength(0);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    cleanups: [] as Array<() => Promise<void>>,
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
