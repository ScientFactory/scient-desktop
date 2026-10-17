// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { StopGenerationAcknowledgement } from "./StopGenerationAcknowledgement";

it("keeps the focused Stop action mounted while its acknowledgement changes", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (isStopping: boolean) =>
    act(() =>
      root.render(
        <StopGenerationAcknowledgement isStopping={isStopping}>
          <button type="button">Stop generation</button>
        </StopGenerationAcknowledgement>,
      ),
    );
  try {
    render(false);
    const button = container.querySelector("button")!;
    button.focus();
    for (const isStopping of [true, false]) {
      render(isStopping);
      expect(container.querySelector("button")).toBe(button);
      expect(document.activeElement).toBe(button);
      expect(container.querySelector('[role="status"]') !== null).toBe(isStopping);
    }
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
