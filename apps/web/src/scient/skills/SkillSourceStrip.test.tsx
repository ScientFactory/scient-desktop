import { isValidElement, type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { SkillSourceStripItem } from "./SkillSourceStrip";

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

describe("SkillSourceStripItem", () => {
  it("keeps the hover treatment while expanded and remains toggleable", () => {
    const onToggle = vi.fn();
    const item = SkillSourceStripItem({
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
