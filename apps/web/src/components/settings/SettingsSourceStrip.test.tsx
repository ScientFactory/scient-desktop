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
  it("exposes source disclosure semantics without claiming tab navigation", () => {
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
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="python-panel"');
    expect(markup).not.toContain('role="tab"');
  });

  it("keeps hidden panels inaccessible and associated with their disclosure", () => {
    const markup = renderToStaticMarkup(
      <SettingsSourcePanel id="python-panel" hidden aria-labelledby="python-trigger">
        Content
      </SettingsSourcePanel>,
    );
    expect(markup).toContain('hidden=""');
    expect(markup).toContain('aria-labelledby="python-trigger"');
  });

  it("announces the expanded state and remains toggleable", () => {
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

    (button?.props.onClick as (() => void) | undefined)?.();
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
