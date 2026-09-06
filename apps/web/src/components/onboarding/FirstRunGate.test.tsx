import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { FirstRunGate } from "./FirstRunGate";

describe("FirstRunGate ownership", () => {
  it("passes Scient local onboarding through without a router, settings, or environment probe", () => {
    expect(
      renderToStaticMarkup(
        <FirstRunGate enabled={false} hostedStatic={false}>
          <p>Scient setup</p>
        </FirstRunGate>,
      ),
    ).toBe("<p>Scient setup</p>");
  });
});
