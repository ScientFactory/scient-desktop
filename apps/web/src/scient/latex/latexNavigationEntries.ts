import type { Node as DocumentNode } from "@tiptap/pm/model";

interface NavigationEntry {
  level: number;
  position: number;
  /** Empty for a heading without text; the outline shows "Untitled heading". */
  title: string;
  runningTitle: string;
  unnumbered: boolean;
  untitled?: boolean;
}

const entries = new WeakMap<DocumentNode, NavigationEntry[]>();

/** Immutable editor nodes reuse their heading index when only another paragraph changes. */
export function latexNavigationEntries(node: DocumentNode): NavigationEntry[] {
  const cached = entries.get(node);
  if (cached) return cached;
  let result: NavigationEntry[] = [];
  if (node.type.name === "heading") {
    result = [
      {
        level: node.attrs.level === 6 ? 0 : Number(node.attrs.level ?? 1),
        position: 0,
        title: node.textContent.trim(),
        untitled: !node.textContent.trim(),
        runningTitle: node.textContent,
        unnumbered: Boolean(node.attrs.unnumbered),
      },
    ];
  } else if (node.type.name === "latexRichPreview" && node.attrs.kind === "part") {
    const title = String(node.attrs.title ?? "");
    result = [{ level: 0, position: 0, title, runningTitle: title, unnumbered: true }];
  } else if (!node.isLeaf && !node.isTextblock && !node.isInline) {
    node.forEach((child, offset) => {
      const origin = offset + (node.type.name === "doc" ? 0 : 1);
      for (const entry of latexNavigationEntries(child))
        result.push({ ...entry, position: origin + entry.position });
    });
  }
  entries.set(node, result);
  return result;
}
