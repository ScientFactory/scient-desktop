import "../../index.css";

import { CSS } from "@dnd-kit/utilities";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

vi.mock("../../hooks/useThreadActions", () => {
  const succeed = vi.fn(async () => ({ _tag: "Success" }));
  return {
    useThreadActions: () => ({
      unsettleThread: succeed,
      unsnoozeThread: succeed,
      reorderActiveThread: succeed,
      reorderPinnedThread: succeed,
    }),
  };
});
const moveThreadsToSection = vi.fn(async () => true);
vi.mock("./actions", () => ({
  readEnvironmentSupportsSections: () => true,
  readEnvironmentSupportsThreadReorder: () => true,
  useThreadSectionActions: () => ({ moveThreadsToSection, setThreadSection: vi.fn() }),
}));

const { SidebarSectionsView } = await import("./SidebarSectionsView");
const { GENERAL_SECTION_GROUP_ID, groupThreadsBySection } = await import("./logic");

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

type Row = { readonly id: string };

const thread = (id: string, sectionId: string | null) =>
  ({ id, environmentId: "env", sectionId, pinnedAt: null, session: null }) as never;

function renderView(
  onReorderSections: (ids: readonly string[]) => void,
  options: {
    readonly names?: readonly string[];
    readonly collapsed?: readonly string[];
    readonly renaming?: string;
    readonly onRename?: (name: string) => void;
  } = {},
) {
  const sections = (options.names ?? ["A", "B", "C"]).map((name, order) => ({
    id: ["a", "b", "c"][order]!,
    name,
    order,
  }));
  const groups = groupThreadsBySection({
    sections: sections as never,
    generalIndex: 0,
    pinned: [],
    active: [
      thread("g1", null),
      thread("g2", null),
      ...[1, 2, 3].map((n) => thread(`a${n}`, "a")),
      ...[1, 2, 3].map((n) => thread(`b${n}`, "b")),
    ],
  });
  host = document.createElement("div");
  host.style.cssText = "width:280px;height:800px;display:flex;flex-direction:column";
  document.body.append(host);
  root = createRoot(host);
  root.render(
    <SidebarSectionsView
      groups={groups as never}
      collapsedGroupIds={new Set(options.collapsed ?? [])}
      routeThreadKey={null}
      onToggleGroup={() => {}}
      snoozedThreads={[]}
      settledThreads={[]}
      showSnoozedShelf={false}
      pinnedKeysById={new Map()}
      activeKeysById={new Map()}
      canDragThread={() => true}
      renderThreadRow={(row, _lifecycle, sortable) => (
        <li
          key={(row as Row).id}
          ref={sortable?.setNodeRef}
          data-row={(row as Row).id}
          style={{
            height: 48,
            listStyle: "none",
            transform: CSS.Translate.toString(sortable?.transform ?? null),
            transition: sortable?.transition,
          }}
          {...sortable?.listeners}
        >
          {(row as Row).id}
        </li>
      )}
      shelfMarkerId={(shelf) => `sidebar-marker-${shelf}-header`}
      renderShelfHeader={() => <li style={{ height: 32, listStyle: "none" }} />}
      onSettleThread={() => {}}
      onReorderSections={onReorderSections}
      onSectionMenu={() => {}}
      onNewThreadInSection={() => {}}
      renamingSectionId={options.renaming ?? null}
      onRenamingSectionChange={() => {}}
      onRenameSection={(_id: string, name: string) => options.onRename?.(name)}
      onStartCreateSection={() => {}}
    />,
  );
}

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 16)));

const headerOf = (groupId: string) =>
  document.querySelector<HTMLElement>(`[data-section-header="${groupId}"]`)!;

/** Layout position, ignoring the transforms blocks slide by. */
const layoutTops = () =>
  [GENERAL_SECTION_GROUP_ID, "a", "b", "c"].map((groupId) => headerOf(groupId).offsetTop);

function pointer(type: string, target: EventTarget, clientX: number, clientY: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX,
      clientY,
      isPrimary: true,
      pointerId: 1,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
    }),
  );
}

it("drags a section as a block without hiding rows or reflowing the list", async () => {
  const onReorderSections = vi.fn();
  renderView(onReorderSections);
  await nextFrame();

  const rowCount = document.querySelectorAll("[data-row]").length;
  expect(rowCount).toBe(8);
  const topsBefore = layoutTops();
  const aTopBefore = headerOf("a").getBoundingClientRect().top;

  // Lift C (last, empty) and carry it above A's middle.
  const handle = headerOf("c").querySelector<HTMLElement>("button[aria-expanded]")!;
  const start = handle.getBoundingClientRect();
  const x = start.left + 20;
  let y = start.top + start.height / 2;
  pointer("pointerdown", handle, x, y);
  const aMiddle = headerOf("a").getBoundingClientRect().top + (32 + 3 * 48) / 2;
  while (y > aMiddle - 10) {
    y -= 12;
    pointer("pointermove", document, x, y);
    await nextFrame();
  }

  // Nothing unmounts and nothing reflows: blocks only slide.
  expect(document.querySelectorAll("[data-row]").length).toBe(rowCount);
  expect(layoutTops()).toEqual(topsBefore);
  // The lifted copy follows the pointer instead of jumping away from it.
  const overlay = [...document.querySelectorAll<HTMLElement>("div")].find(
    (element) =>
      getComputedStyle(element).position === "fixed" && element.textContent?.trim() === "C",
  );
  expect(overlay).toBeDefined();
  const overlayRect = overlay!.getBoundingClientRect();
  expect(Math.abs(overlayRect.top + overlayRect.height / 2 - y)).toBeLessThan(20);
  // C's block slides to its landing slot: where A's header was, right after General.
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(Math.round(headerOf("c").getBoundingClientRect().top)).toBe(Math.round(aTopBefore));

  pointer("pointerup", document, x, y);
  await nextFrame();
  expect(onReorderSections).toHaveBeenCalledWith([GENERAL_SECTION_GROUP_ID, "c", "a", "b"]);
  expect(document.querySelectorAll("[data-row]").length).toBe(rowCount);
});

it("still files a dragged thread into the section it is dropped in", async () => {
  moveThreadsToSection.mockClear();
  renderView(vi.fn());
  await nextFrame();
  const row = document.querySelector<HTMLElement>('[data-row="g1"]')!;
  const start = row.getBoundingClientRect();
  const x = start.left + 20;
  let y = start.top + start.height / 2;
  pointer("pointerdown", row, x, y);
  // Carry it down into B, between b1 and b2.
  const target = document.querySelector<HTMLElement>('[data-row="b2"]')!.getBoundingClientRect();
  while (y < target.top + 4) {
    y += 12;
    pointer("pointermove", document, x, y);
    await nextFrame();
  }
  pointer("pointerup", document, x, y);
  await nextFrame();
  expect(moveThreadsToSection).toHaveBeenCalledWith(
    [expect.objectContaining({ threadId: "g1" })],
    "b",
  );
});

it("files a thread dragged up onto a collapsed section's header into that section", async () => {
  moveThreadsToSection.mockClear();
  // A is collapsed, so only its header is left to drop on.
  renderView(vi.fn(), { collapsed: ["a"] });
  await nextFrame();
  const row = document.querySelector<HTMLElement>('[data-row="b2"]')!;
  const start = row.getBoundingClientRect();
  const x = start.left + 20;
  let y = start.top + start.height / 2;
  pointer("pointerdown", row, x, y);
  const header = headerOf("a").getBoundingClientRect();
  while (y > header.top + header.height / 2) {
    y -= 12;
    pointer("pointermove", document, x, y);
    await nextFrame();
  }
  // The header stays put and highlights: the drop goes into A, not the
  // section above it.
  expect(headerOf("a").getBoundingClientRect().top).toBeCloseTo(header.top, 0);
  pointer("pointerup", document, x, y);
  await nextFrame();
  expect(moveThreadsToSection).toHaveBeenCalledWith(
    [expect.objectContaining({ threadId: "b2" })],
    "a",
  );
});

it("sets section names 4px low, nearer their own threads, without growing the header", async () => {
  renderView(() => {});
  await nextFrame();

  for (const groupId of [GENERAL_SECTION_GROUP_ID, "a"]) {
    const header = headerOf(groupId).getBoundingClientRect();
    const name = headerOf(groupId)
      .querySelector<HTMLElement>("button[aria-expanded]")!
      .getBoundingClientRect();
    expect(header.height).toBe(32);
    expect(name.top + name.height / 2 - (header.top + header.height / 2)).toBe(4);
  }
});

it("points the chevron where the section is, showing it on hover while open", async () => {
  renderView(() => {}, { collapsed: ["b"] });
  await nextFrame();
  const chevronOf = (groupId: string) =>
    headerOf(groupId).querySelector<SVGElement>("button[aria-expanded] svg")!;
  const actionsOf = (groupId: string) =>
    headerOf(groupId).querySelector<HTMLElement>('button[aria-label="Section actions"]')!
      .parentElement!;
  const opacity = (element: Element) => getComputedStyle(element).opacity;
  const rotated = (element: Element) => getComputedStyle(element).rotate === "90deg";

  // Section actions are always shown, open or collapsed.
  expect(opacity(actionsOf("a"))).toBe("1");
  expect(opacity(actionsOf("b"))).toBe("1");

  // Collapsed: points right, always shown.
  expect(rotated(chevronOf("b"))).toBe(false);
  expect(opacity(chevronOf("b"))).toBe("1");

  // Open: points down, shown only on hover.
  expect(rotated(chevronOf("a"))).toBe(true);
  expect(opacity(chevronOf("a"))).toBe("0");
  await userEvent.hover(headerOf("a"));
  await new Promise((resolve) => setTimeout(resolve, 250));
  expect(opacity(chevronOf("a"))).toBe("1");
});

it("drops the rule entirely when less than 24px would be left beside the name", async () => {
  renderView(() => {}, {
    names: ["A", "A section name long enough to fill the whole header row", "C"],
  });
  await nextFrame();
  const ruleOf = (groupId: string) => {
    const button = headerOf(groupId).querySelector<HTMLElement>("button[aria-expanded]")!;
    const rule = button.lastElementChild!.getBoundingClientRect();
    const box = button.getBoundingClientRect();
    return { visible: rule.top < box.bottom && rule.width > 0, width: rule.width };
  };

  expect(ruleOf("a").visible).toBe(true);
  expect(ruleOf("a").width).toBeGreaterThanOrEqual(24);
  // The long name keeps the row; the rule drops to the clipped second line.
  expect(ruleOf("b").visible).toBe(false);
});

it("capitalizes a section name as it is typed, keeping the caret in place", async () => {
  const onRename = vi.fn();
  renderView(() => {}, { renaming: "a", onRename });
  await nextFrame();
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Section name"]')!;
  // The field opens with the name selected; typing replaces it.
  await userEvent.keyboard("research notes");
  expect(input.value).toBe("Research notes");
  expect(input.selectionStart).toBe("Research notes".length);
  await userEvent.keyboard("{Enter}");
  expect(onRename).toHaveBeenCalledWith("Research notes");
});
