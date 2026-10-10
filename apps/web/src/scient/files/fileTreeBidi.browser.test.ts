import { FileTree } from "@pierre/trees";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const trees: FileTree[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
  for (const tree of trees.splice(0)) tree.cleanUp();
  for (const host of hosts.splice(0)) host.remove();
});

async function mountTree(paths: string[], width = 320, flattenEmptyDirectories = false) {
  const host = document.createElement("div");
  host.style.cssText = `width:${width}px;height:360px;font:16px Arial,sans-serif;direction:ltr`;
  document.body.append(host);
  hosts.push(host);
  const onSelectionChange = vi.fn();
  const tree = new FileTree({
    paths,
    initialExpansion: "open",
    flattenEmptyDirectories,
    search: false,
    density: "compact",
    onSelectionChange,
  });
  trees.push(tree);
  tree.render({ containerWrapper: host });
  await vi.waitFor(() =>
    expect(host.querySelector("file-tree-container")?.shadowRoot).toBeTruthy(),
  );
  const shadow = host.querySelector("file-tree-container")!.shadowRoot!;
  await vi.waitFor(() => expect(shadow.querySelector("button[data-type='item']")).toBeTruthy());
  return { host, shadow, tree, onSelectionChange };
}

function rowFor(shadow: ShadowRoot, path: string) {
  const row = [...shadow.querySelectorAll<HTMLButtonElement>("button[data-type='item']")].find(
    (element) => element.dataset.itemPath === path,
  );
  expect(row, `row for ${path}`).toBeTruthy();
  return row!;
}

/** Character geometry catches reordered runs that textContent assertions cannot. */
function visualOrder(element: HTMLElement) {
  const text = element.firstChild!;
  const characters = [];
  for (let offset = 0; offset < text.textContent!.length; offset++) {
    const range = document.createRange();
    range.setStart(text, offset);
    range.setEnd(text, offset + 1);
    const bounds = range.getBoundingClientRect();
    characters.push({ offset, x: bounds.x });
  }
  return characters
    .sort((left, right) => left.x - right.x || left.offset - right.offset)
    .map(({ offset }) => offset);
}

const rtlNames = [
  "שלום",
  "מסמכים",
  "רפואה פנימית",
  "בדיקות 2026",
  "סיכום (חדש).md",
  "report-עברית-2026.md",
  "שָׁלוֹם עולם.txt",
  "ملفات عربية.txt",
  "תיקייה ארוכה מאוד עם שם בעברית",
];

describe("file tree bidi labels", () => {
  it.each([320, 120, 72])("keeps whole-name visual order and raw paths at %ipx", async (width) => {
    const paths = rtlNames.map((name) => `${name}/`);
    const { shadow } = await mountTree(paths, width);
    for (const [index, path] of paths.entries()) {
      const row = rowFor(shadow, path);
      const label = row.querySelector<HTMLElement>("[data-file-tree-bidi-label]");
      expect(label).toBeTruthy();
      expect(label!.textContent).toBe(rtlNames[index]);
      expect(row.getAttribute("aria-label")).toBe(rtlNames[index]);
      expect(label!.title).toBe(rtlNames[index]);
      const reference = document.createElement("span");
      reference.dir = "auto";
      reference.textContent = rtlNames[index]!;
      reference.style.cssText = "position:absolute;white-space:nowrap;font:16px Arial,sans-serif";
      document.body.append(reference);
      try {
        expect(visualOrder(label!)).toEqual(visualOrder(reference));
      } finally {
        reference.remove();
      }
      const style = getComputedStyle(label!);
      expect(style.textOverflow).toBe("ellipsis");
      expect(style.unicodeBidi).toBe("isolate");
      expect(row.querySelector("[data-truncate-group-container]")).toBeNull();
    }
    const longest = rowFor(shadow, paths.at(-1)!).querySelector<HTMLElement>(
      "[data-file-tree-bidi-label]",
    )!;
    if (width < 320) expect(longest.scrollWidth).toBeGreaterThan(longest.clientWidth);
  });

  it("selects the exact Hebrew file and keeps LTR extension-preserving labels", async () => {
    const path = "מסמכים/סיכום (חדש).md";
    const { shadow, tree, onSelectionChange } = await mountTree([path, "report.md"]);
    const file = rowFor(shadow, path);
    file.click();
    await vi.waitFor(() => expect(tree.getSelectedPaths()).toEqual([path]));
    expect(onSelectionChange).toHaveBeenLastCalledWith([path]);
    expect(file.querySelector("[data-file-tree-bidi-label]")?.textContent).toBe("סיכום (חדש).md");
    const latin = rowFor(shadow, "report.md");
    expect(latin.querySelector("[data-file-tree-bidi-label]")).toBeNull();
    expect(latin.querySelector("[data-truncate-group-container='middle']")).toBeTruthy();
    expect(
      [...latin.querySelectorAll("[data-truncate-content='visible']")]
        .map((part) => part.textContent)
        .join(""),
    ).toBe("report.md");
  });

  it("isolates each Hebrew segment of a flattened directory chain", async () => {
    const { shadow } = await mountTree(["מסמכים/רפואה פנימית/notes.md"], 160, true);
    const segments = [...shadow.querySelectorAll<HTMLElement>("[data-item-flattened-subitem]")];
    expect(segments.length).toBe(2);
    expect(
      segments.map((segment) => segment.querySelector("[data-file-tree-bidi-label]")?.textContent),
    ).toEqual(["מסמכים", "רפואה פנימית"]);
    expect(segments.map((segment) => segment.dataset.itemFlattenedSubitem)).toEqual([
      "מסמכים/",
      "מסמכים/רפואה פנימית/",
    ]);
  });
});
