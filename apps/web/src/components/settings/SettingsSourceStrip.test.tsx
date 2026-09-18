import { isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  SettingsSourcePanel,
  SettingsSourceStrip,
  SettingsSourceStripItem,
} from "./SettingsSourceStrip";

function findButton(node: unknown): ReactElement<Record<string, unknown>> | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child);
      if (found) return found;
    }
    return undefined;
  }
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (node.type === "button") return node;
  for (const value of Object.values(node.props)) {
    const found = findButton(value);
    if (found) return found;
  }
  return undefined;
}

describe("SettingsSourceStripItem", () => {
  it("preserves the Skills spacing, separator, scrollbar, and disclosure semantics", () => {
    const markup = renderToStaticMarkup(
      <SettingsSourceStrip label="Languages">
        <SettingsSourceStripItem
          id="python-trigger"
          controls="python-panel"
          expanded={false}
          separated
          icon={<span />}
          label="Python"
          detail="Off"
          onToggle={() => {}}
        />
      </SettingsSourceStrip>,
    );
    expect(markup).toContain('role="group"');
    expect(markup).toContain("settings-source-strip");
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("mx-2 h-7 w-px bg-border/65");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="python-panel"');
    expect(markup).not.toContain('role="tab"');
    expect(markup).toContain("focus-visible:ring-inset");
  });

  it("retains the exact panel treatment without making hidden content interactive", () => {
    const markup = renderToStaticMarkup(
      <SettingsSourcePanel id="python-panel" hidden aria-labelledby="python-trigger">
        Content
      </SettingsSourcePanel>,
    );
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('aria-labelledby="python-trigger"');
    expect(markup).toContain("rounded-xl border border-border/60 bg-card/40 py-1 shadow-xs/5");
  });

  it("keeps the hover treatment while expanded and remains toggleable", () => {
    const onToggle = vi.fn();
    const item = SettingsSourceStripItem({
      controls: "skills-panel",
      expanded: true,
      icon: <span />,
      label: "Selected source",
      separated: false,
      onToggle,
    });
    const button = findButton(item);

    expect(button?.props["aria-expanded"]).toBe(true);
    expect(button?.props.className).toContain("hover:bg-foreground/[0.035]");
    expect(button?.props.className).toContain("aria-expanded:bg-foreground/[0.035]");

    (button?.props.onClick as (() => void) | undefined)?.();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
