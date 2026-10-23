import type { MermaidTheme } from "./mermaidRuntime";

const palette = {
  light: {
    bg: "#ffffff",
    fg: "#1f1f1f",
    muted: "#6e6e6e",
    line: "#6e6e6e",
    surface: "#f3f3f3",
    "surface-alt": "#e6e6e6",
    border: "#8a8a8a",
    accent: "#5b7bd5",
    critical: "#e45756",
  },
  dark: {
    bg: "#171717",
    fg: "#eeeeee",
    muted: "#aaaaaa",
    line: "#aaaaaa",
    surface: "#262626",
    "surface-alt": "#333333",
    border: "#777777",
    accent: "#8ba5ee",
    critical: "#ef7978",
  },
} as const;

/** Freeze colors with the SVG so the dialog and native image exports use identical inputs. */
export function applyMermaidPalette(svg: string, theme: MermaidTheme): string {
  const template = document.createElement("template");
  template.innerHTML = svg;
  const element = template.content.querySelector("svg");
  if (!element) throw new Error("The diagram renderer returned an invalid SVG.");
  for (const [name, value] of Object.entries(palette[theme])) {
    element.style.setProperty(`--pele-${name}`, value);
  }
  return element.outerHTML;
}
