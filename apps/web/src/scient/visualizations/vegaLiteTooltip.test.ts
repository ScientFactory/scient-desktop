import type { TooltipHandler } from "vega";
import { describe, expect, it, vi } from "vite-plus/test";

import { cacheMarkAnchoredTooltip } from "./vegaLiteTooltip";

const event = {} as MouseEvent;
const handlerContext = {};
const noItem = null as unknown as Parameters<TooltipHandler>[2];

describe("stable Vega-Lite tooltip policy", () => {
  it("does real tooltip work only once while the pointer moves within one datum", () => {
    const delegate = vi.fn<TooltipHandler>();
    const format = vi.fn(JSON.stringify);
    const tooltip = cacheMarkAnchoredTooltip(delegate, format);
    const item = {} as Parameters<TooltipHandler>[2];
    const value = { group: "Treatment", response: 7.8 };

    for (let index = 0; index < 250; index += 1) {
      tooltip(handlerContext, event, item, value);
    }

    expect(delegate).toHaveBeenCalledTimes(1);
    expect(format).toHaveBeenCalledTimes(1);
  });

  it("updates for a new datum or changed content while deduplicating equivalent values", () => {
    const delegate = vi.fn<TooltipHandler>();
    const tooltip = cacheMarkAnchoredTooltip(delegate, JSON.stringify);
    const firstItem = {} as Parameters<TooltipHandler>[2];
    const secondItem = {} as Parameters<TooltipHandler>[2];

    tooltip(handlerContext, event, firstItem, { value: 4 });
    tooltip(handlerContext, event, firstItem, { value: 4 });
    tooltip(handlerContext, event, firstItem, { value: 4 });
    tooltip(handlerContext, event, secondItem, { value: 4 });
    tooltip(handlerContext, event, secondItem, { value: 5 });

    expect(delegate).toHaveBeenCalledTimes(3);
  });

  it("forwards one hide and ignores redundant hidden or finalize notifications", () => {
    const delegate = vi.fn<TooltipHandler>();
    const tooltip = cacheMarkAnchoredTooltip(delegate, JSON.stringify);
    const item = {} as Parameters<TooltipHandler>[2];

    tooltip(handlerContext, event, noItem, null);
    tooltip(handlerContext, event, item, { value: 4 });
    tooltip(handlerContext, event, item, null);
    tooltip(handlerContext, event, noItem, null);

    expect(delegate).toHaveBeenCalledTimes(2);
    expect(delegate.mock.calls[1]?.[3]).toBeNull();
  });
});
