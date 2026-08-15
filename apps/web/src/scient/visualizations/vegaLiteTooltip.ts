import type { TooltipHandler } from "vega";
import { escapeHTML, formatValue, Handler } from "vega-tooltip";

import type { VegaLiteTheme } from "./vegaLiteRuntime";

const SCIENT_VEGA_TOOLTIP_ID = "scient-vega-tooltip";
const TOOLTIP_MAX_DEPTH = 2;

function formattedTooltipValue(value: unknown): string {
  return formatValue(value, escapeHTML, TOOLTIP_MAX_DEPTH);
}

/**
 * Vega reports tooltips on every pointer move. A mark-anchored tooltip only
 * needs real DOM work when its item or rendered content changes.
 */
export function cacheMarkAnchoredTooltip(
  delegate: TooltipHandler,
  format: (value: unknown) => string = formattedTooltipValue,
): TooltipHandler {
  let visible = false;
  let previousItem: Parameters<TooltipHandler>[2] | null = null;
  let previousValue: unknown;
  let previousContent: string | null = null;

  return (handler, event, item, value) => {
    if (value == null || value === "") {
      if (!visible) return;
      visible = false;
      previousItem = null;
      previousValue = undefined;
      previousContent = null;
      delegate(handler, event, item, value);
      return;
    }

    if (visible && item === previousItem && Object.is(value, previousValue)) return;
    const content = format(value);
    if (visible && item === previousItem && content === previousContent) {
      previousValue = value;
      return;
    }

    visible = true;
    previousItem = item;
    previousValue = value;
    previousContent = content;
    delegate(handler, event, item, value);
  };
}

export function createScientVegaTooltipHandler(theme: VegaLiteTheme): TooltipHandler {
  const upstream = new Handler({
    anchor: "mark",
    disableDefaultStyle: true,
    id: SCIENT_VEGA_TOOLTIP_ID,
    position: ["top", "right", "left", "bottom"],
    theme,
  }).call;

  return cacheMarkAnchoredTooltip((handler, event, item, value) => {
    upstream(handler, event, item, value);
    const element = document.getElementById(SCIENT_VEGA_TOOLTIP_ID);
    if (element != null) {
      element.dir = "auto";
      element.setAttribute("role", "tooltip");
    }
  });
}
