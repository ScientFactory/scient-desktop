import { DirectionProvider, useDirection } from "@base-ui/react/direction-provider";
import { describe, expect, it } from "vite-plus/test";
import { render } from "../../../test/render";

import { ScrollArea } from "./scroll-area";

function DirectionProbe() {
  const direction = useDirection();
  return <span data-direction={direction} />;
}

describe("ScrollArea direction", () => {
  it("gives Base UI scrollbar internals the explicit RTL direction", async () => {
    await using screen = await render(
      <DirectionProvider direction="ltr">
        <ScrollArea dir="rtl">
          <DirectionProbe />
        </ScrollArea>
      </DirectionProvider>,
    );

    const host = screen.container;
    expect(host.querySelector('[data-direction="rtl"]')).not.toBeNull();
    expect(host.querySelector('[data-slot="scroll-area-viewport"]')?.parentElement?.dir).toBe(
      "rtl",
    );
  });

  it("preserves an inherited direction when no DOM direction is supplied", async () => {
    await using screen = await render(
      <DirectionProvider direction="rtl">
        <ScrollArea>
          <DirectionProbe />
        </ScrollArea>
      </DirectionProvider>,
    );

    const host = screen.container;
    expect(host.querySelector('[data-direction="rtl"]')).not.toBeNull();
  });
});
