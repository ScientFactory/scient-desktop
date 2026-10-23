import { render as _fixtureRender, act } from "../../../test/render";

import { expect, it, vi } from "vite-plus/test";
import { StopGenerationAcknowledgement } from "./StopGenerationAcknowledgement";

it("keeps the focused Stop action mounted while its acknowledgement changes", async () => {
  await using _fixture = _createFixture();

  const container = document.createElement("div");
  document.body.append(container);
  const root = _fixture.stack.use(
    await _fixtureRender(null, { container: container, router: false }),
  );
  const render = async (isStopping: boolean) =>
    await act(
      async () =>
        await root.rerender(
          <StopGenerationAcknowledgement isStopping={isStopping}>
            <button type="button">Stop generation</button>
          </StopGenerationAcknowledgement>,
        ),
    );
  try {
    await render(false);
    const button = container.querySelector("button")!;
    button.focus();
    for (const isStopping of [true, false]) {
      await render(isStopping);
      expect(container.querySelector("button")).toBe(button);
      expect(document.activeElement).toBe(button);
      expect(container.querySelector('[role="status"]') !== null).toBe(isStopping);
    }
  } finally {
    await act(async () => await root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
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
