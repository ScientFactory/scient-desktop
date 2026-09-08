// @vitest-environment happy-dom

import { DirectionProvider, useDirection } from "@base-ui/react/direction-provider";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { ScrollArea } from "./scroll-area";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const originalGetAnimations = Object.getOwnPropertyDescriptor(Element.prototype, "getAnimations");
Object.defineProperty(Element.prototype, "getAnimations", {
  configurable: true,
  value: () => [],
});
afterAll(() => {
  if (originalGetAnimations) {
    Object.defineProperty(Element.prototype, "getAnimations", originalGetAnimations);
  } else {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  }
  vi.unstubAllGlobals();
});

const host = document.createElement("div");
document.body.append(host);
const root = createRoot(host);

afterEach(async () => {
  await act(() => root.render(null));
});

function DirectionProbe() {
  const direction = useDirection();
  return <span data-direction={direction} />;
}

describe("ScrollArea direction", () => {
  it("gives Base UI scrollbar internals the explicit RTL direction", async () => {
    await act(() =>
      root.render(
        <DirectionProvider direction="ltr">
          <ScrollArea dir="rtl">
            <DirectionProbe />
          </ScrollArea>
        </DirectionProvider>,
      ),
    );

    expect(host.querySelector('[data-direction="rtl"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="scroll-area-viewport"]')?.parentElement?.dir).toBe(
      "rtl",
    );
  });

  it("preserves an inherited direction when no DOM direction is supplied", async () => {
    await act(() =>
      root.render(
        <DirectionProvider direction="rtl">
          <ScrollArea>
            <DirectionProbe />
          </ScrollArea>
        </DirectionProvider>,
      ),
    );

    expect(host.querySelector('[data-direction="rtl"]')).not.toBeNull();
  });
});
