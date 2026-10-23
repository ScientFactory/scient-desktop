import { render as _fixtureRender, type Screen } from "../../../test/render";
import "../../index.css";

import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
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

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
}

function Slot({ item }: { item: SidebarListItem }) {
  const id = sidebarListItemId(item);
  const { transform, transition, setNodeRef, listeners, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Translate.toString(transform),
    transition: transition,
  };
  if (item.kind === "marker")
    return (
      <li
        ref={setNodeRef}
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
      sortableRef={setNodeRef}
      {...listeners}
      style={style}
      className="list-none"
      alwaysRender={isDragging}
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
  const [activeId, setActiveId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState("");
  const [overSection, setOverSection] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const items: SidebarListItem[] = [
    { kind: "marker", marker: "pinned-header" },
    { kind: "marker", marker: "pinned-divider" },
    ...Array.from({ length: 100 }, (_, index): SidebarListItem => ({
      kind: "thread",
      key: `thread-${index}`,
      section: "active",
    })),
    { kind: "marker", marker: "settled-header" },
    { kind: "thread", key: "settled-thread", section: "settled" },
  ];
  const sensors = useSensors(
    useSensor(SidebarPointerSensor, { distance: 3, onAttach: () => {}, onFinish: () => {} }),
  );
  const strategy = createSidebarSortingStrategy({
    items,
    settledOrder: ["settled-thread"],
    settledExpanded: true,
  });
  const collision = createSidebarCollisionDetection(() => true, { items });
  return (
    <>
      <output data-active-id={activeId} data-over-section={overSection} data-over-id={overId}>
        {receipt}
      </output>
      <div data-slot="scroll-area-viewport" style={{ height: 400, width: 300, overflow: "auto" }}>
        <DndContext
          sensors={sensors}
          collisionDetection={collision}
          autoScroll={false}
          onDragStart={({ active }) => setActiveId(String(active.id))}
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
            setActiveId(null);
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

async function mount(_fixture: _Fixture) {
  _fixture.host = document.createElement("div");
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<Fixture />);
  await expect.poll(() => _fixture.host!.querySelectorAll("[data-thread-item]").length).toBe(101);
  return {
    row: (key: string) => _fixture.host!.querySelector<HTMLElement>(`[data-thread-item="${key}"]`)!,
    viewport: _fixture.host.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!,
  };
}

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
  await vi.waitFor(() =>
    expect(document.querySelector("output")?.getAttribute("data-active-id")).toBe(
      row.dataset.threadItem,
    ),
  );
  return x;
}

it("uses the real sidebar sensor and sorting strategy to reorder mounted slots", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixture = await mount(_fixture);
  const source = fixture.row("thread-0");
  const target = fixture.row("thread-2");
  const x = await startDrag(source);
  const rect = target.getBoundingClientRect();
  pointer(document, "pointermove", x, rect.top + rect.height / 2);
  await expect
    .poll(() => _fixture.host!.querySelector("output")!.getAttribute("data-over-id"))
    .toBe("thread-2");
  pointer(document, "pointerup", x, rect.top + rect.height / 2);
  await expect
    .poll(() => _fixture.host!.querySelector("output")!.textContent)
    .toContain('"activeOrder":["thread-1","thread-2","thread-0"');
  expect(source).toBe(fixture.row("thread-0"));
});

it("keeps the dragged body alive while scrolling to a previously empty settled slot", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const fixture = await mount(_fixture);
  const source = fixture.row("thread-0");
  const target = fixture.row("settled-thread");
  await expect.poll(() => target.dataset.sidebarRowBody).toBe("placeholder");
  const x = await startDrag(source);
  fixture.viewport.scrollTop = fixture.viewport.scrollHeight;
  await expect.poll(() => target.dataset.sidebarRowBody).toBe("mounted");
  expect(source.dataset.sidebarRowBody).toBe("mounted");
  expect(_fixture.host!.querySelectorAll("[data-marker]")).toHaveLength(3);
  const rect = target.getBoundingClientRect();
  pointer(document, "pointermove", x, rect.top + rect.height / 2);
  await expect
    .poll(() => _fixture.host!.querySelector("output")!.getAttribute("data-over-section"))
    .toBe("settled");
  pointer(document, "pointerup", x, rect.top + rect.height / 2);
  await expect
    .poll(() => _fixture.host!.querySelector("output")!.textContent)
    .toContain('"section":"settled"');
  expect(source).toBe(fixture.row("thread-0"));
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    cleanup,
    root0: undefined! as Screen | undefined,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
