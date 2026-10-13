import "../../index.css";
import { createRoot, type Root } from "react-dom/client";
import { useMemo, useState } from "react";
import { afterEach, expect, it } from "vite-plus/test";
import { DndContext, useSensor, useSensors } from "@dnd-kit/core";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { SidebarRowWindow } from "./SidebarRowWindow";
import { SidebarPointerSensor } from "../Sidebar.pointer";
import { createSidebarSortingStrategy, createSidebarCollisionDetection } from "../Sidebar.drag";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  type SidebarListItem,
} from "../Sidebar.logic";

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  root?.unmount();
  host?.remove();
});

function Slot({ item }: { item: SidebarListItem }) {
  const id = sidebarListItemId(item);
  const sortable = useSortable({ id });
  const style = {
    transform: CSS.Translate.toString(sortable.transform),
    transition: sortable.transition,
  };
  if (item.kind === "marker")
    return (
      <li
        ref={sortable.setNodeRef}
        data-marker={item.marker}
        style={style}
        className={item.marker === "settled-header" ? "h-8" : "h-0"}
      >
        {" "}
      </li>
    );
  const height = item.section === "settled" ? "h-9" : "h-[5.125rem]";
  return (
    <SidebarRowWindow
      data-thread-item={item.key}
      sortableRef={sortable.setNodeRef}
      {...sortable.listeners}
      style={style}
      className="list-none"
      alwaysRender={sortable.isDragging}
      placeholder={<div className={height}>{item.key}</div>}
    >
      {() => (
        <div className={height} data-full-row>
          {item.key}
        </div>
      )}
    </SidebarRowWindow>
  );
}

function Fixture() {
  const [receipt, setReceipt] = useState("");
  const [overSection, setOverSection] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const items = useMemo(
    (): SidebarListItem[] => [
      { kind: "marker", marker: "pinned-header" },
      { kind: "marker", marker: "pinned-divider" },
      ...Array.from({ length: 100 }, (_, index): SidebarListItem => ({
        kind: "thread",
        key: `thread-${index}`,
        section: "active",
      })),
      { kind: "marker", marker: "settled-header" },
      { kind: "thread", key: "settled-thread", section: "settled" },
    ],
    [],
  );
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, { distance: 3, onAttach: () => {}, onFinish: () => {} }),
  );
  const strategy = useMemo(
    () =>
      createSidebarSortingStrategy({
        items,
        settledOrder: ["settled-thread"],
        settledExpanded: true,
      }),
    [items],
  );
  const collision = useMemo(() => createSidebarCollisionDetection(() => true, { items }), [items]);
  return (
    <>
      <output data-over-section={overSection} data-over-id={overId}>
        {receipt}
      </output>
      <div data-slot="scroll-area-viewport" style={{ height: 400, width: 300, overflow: "auto" }}>
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          autoScroll={false}
          onDragOver={({ active, over }) => {
            setOverId(over ? String(over.id) : null);
            setOverSection(
              over
                ? (resolveSidebarDropTarget(items, String(active.id), String(over.id))?.section ??
                    null)
                : null,
            );
          }}
          onDragEnd={({ active, over }) => {
            setReceipt(
              JSON.stringify(
                over && resolveSidebarDropTarget(items, String(active.id), String(over.id)),
              ),
            );
          }}
        >
          <SortableContext items={items.map(sidebarListItemId)} strategy={strategy}>
            <ul>
              {items.map((item) => (
                <Slot key={sidebarListItemId(item)} item={item} />
              ))}
            </ul>
          </SortableContext>
        </DndContext>
      </div>
    </>
  );
}

async function mount() {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  root.render(<Fixture />);
  await expect.poll(() => host!.querySelectorAll("[data-thread-item]").length).toBe(101);
  return {
    row: (key: string) => host!.querySelector<HTMLElement>(`[data-thread-item="${key}"]`)!,
    viewport: host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!,
  };
}

const frame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
function pointer(target: EventTarget, type: string, x: number, y: number) {
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    }),
  );
}
async function startDrag(row: HTMLElement) {
  const rect = row.getBoundingClientRect();
  const x = rect.left + 100;
  const y = rect.top + 30;
  pointer(row, "pointerdown", x, y);
  pointer(document, "pointermove", x, y + 10);
  await frame();
  return x;
}

it("uses the real sidebar sensor and sorting strategy to reorder mounted slots", async () => {
  const fixture = await mount();
  const source = fixture.row("thread-0");
  const target = fixture.row("thread-2");
  const x = await startDrag(source);
  const rect = target.getBoundingClientRect();
  pointer(document, "pointermove", x, rect.top + rect.height / 2);
  await expect
    .poll(() => host!.querySelector("output")!.getAttribute("data-over-id"))
    .toBe("thread-2");
  pointer(document, "pointerup", x, rect.top + rect.height / 2);
  await frame();
  await expect
    .poll(() => host!.querySelector("output")!.textContent)
    .toContain('"activeOrder":["thread-1","thread-2","thread-0"');
  expect(source).toBe(fixture.row("thread-0"));
});

it("keeps the dragged body alive while scrolling to a previously empty settled slot", async () => {
  const fixture = await mount();
  const source = fixture.row("thread-0");
  const target = fixture.row("settled-thread");
  await expect.poll(() => target.dataset.sidebarRowBody).toBe("placeholder");
  const x = await startDrag(source);
  fixture.viewport.scrollTop = fixture.viewport.scrollHeight;
  await frame();
  await expect.poll(() => target.dataset.sidebarRowBody).toBe("mounted");
  expect(source.dataset.sidebarRowBody).toBe("mounted");
  expect(host!.querySelectorAll("[data-marker]")).toHaveLength(3);
  const rect = target.getBoundingClientRect();
  pointer(document, "pointermove", x, rect.top + rect.height / 2);
  await expect
    .poll(() => host!.querySelector("output")!.getAttribute("data-over-section"))
    .toBe("settled");
  pointer(document, "pointerup", x, rect.top + rect.height / 2);
  await frame();
  await expect
    .poll(() => host!.querySelector("output")!.textContent)
    .toContain('"section":"settled"');
  expect(source).toBe(fixture.row("thread-0"));
});
