import { render as _fixtureRender, type Screen, act, fakeTimers } from "../../../test/render";
import "../../index.css";

import { CSS } from "@dnd-kit/utilities";

import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

import type { SectionMachine } from "./SidebarSectionsView";

const { reorderActiveThread } = vi.hoisted(() => ({
  reorderActiveThread: vi.fn(async () => ({ _tag: "Success" })),
}));

vi.mock("../../hooks/useThreadActions", () => {
  const succeed = vi.fn(async () => ({ _tag: "Success" }));
  return {
    useThreadActions: () => ({
      unsettleThread: succeed,
      unsnoozeThread: succeed,
      reorderActiveThread,
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
const { GENERAL_SECTION_GROUP_ID, groupThreadsBySection, sectionGroupId } = await import("./logic");

/** The group id of section `id` on the test environment; General stays General. */
const groupKey = (id: string) =>
  id === GENERAL_SECTION_GROUP_ID ? id : sectionGroupId({ environmentId: "env", sectionId: id });
/** The section a drop files into, on the test environment. */
const into = (sectionId: string) => ({ environmentId: "env", sectionId });

async function _cleanupFixture0(_fixture: _Fixture) {
  moveThreadsToSection.mockReset().mockResolvedValue(true);
  reorderActiveThread.mockClear();
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

type Row = { readonly id: string };

const thread = (id: string, sectionId: string | null, environmentId = "env") =>
  ({ id, environmentId, sectionId, pinnedAt: null, session: null }) as never;

async function renderView(
  _fixture: _Fixture,
  onReorderSections: (ids: readonly string[]) => void,
  options: {
    readonly names?: readonly string[];
    readonly collapsed?: readonly string[];
    readonly renaming?: string;
    readonly onRename?: (name: string) => void;
    readonly promoted?: boolean;
    /** Adds a General thread on another environment, whose sections aren't listed. */
    readonly foreignThread?: boolean;
    readonly environmentMachines?: ReadonlyMap<string, SectionMachine>;
    readonly onManualPlacement?: (
      groupId: string,
      order: readonly string[],
      key: string,
      orderKeys: ReadonlyMap<string, string>,
    ) => void;
  } = {},
) {
  const sections = (options.names ?? ["A", "B", "C"]).map((name, order) => ({
    id: ["a", "b", "c"][order]!,
    name,
    order,
  }));
  const groups = groupThreadsBySection({
    layouts: [{ environmentId: "env", sections: sections as never, generalIndex: 0 }],
    pinned: [],
    active: [
      thread("g1", null),
      thread("g2", null),
      ...(options.foreignThread ? [thread("x1", "a", "other")] : []),
      ...(options.promoted ? [3, 1, 2] : [1, 2, 3]).map((n) => thread(`a${n}`, "a")),
      ...[1, 2, 3].map((n) => thread(`b${n}`, "b")),
    ],
  });
  _fixture.host = document.createElement("div");
  _fixture.host.style.cssText = "width:280px;height:800px;display:flex;flex-direction:column";
  document.body.append(_fixture.host);
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(
    <SidebarSectionsView
      groups={groups as never}
      environmentMachines={options.environmentMachines ?? null}
      {...(options.promoted
        ? { canonicalGroupOrders: new Map([[groupKey("a"), ["env:a1", "env:a2", "env:a3"]]]) }
        : {})}
      {...(options.onManualPlacement ? { onManualPlacement: options.onManualPlacement } : {})}
      collapsedGroupIds={new Set((options.collapsed ?? []).map(groupKey))}
      routeThreadKey={null}
      onToggleGroup={() => {}}
      snoozedThreads={[]}
      settledThreads={[]}
      showSnoozedShelf={false}
      pinnedKeysById={new Map()}
      activeKeysById={
        new Map([
          ["env:g1", "a"],
          ["env:g2", "b"],
          ["env:a1", "d"],
          ["env:a2", "g"],
          ["env:a3", "m"],
          ["env:b1", "t"],
          ["env:b2", "w"],
          ["env:b3", "z"],
        ])
      }
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
      onInteractionChange={(active) => {
        _fixture.interacting = active;
      }}
      onSectionMenu={() => {}}
      onNewThreadInSection={() => {}}
      renamingSectionId={options.renaming === undefined ? null : groupKey(options.renaming)}
      onRenamingSectionChange={() => {}}
      onRenameSection={(_id: string, name: string) => options.onRename?.(name)}
      onStartCreateSection={() => {}}
    />,
  );
}

/** A header by section id (or General's id). */
const headerOf = (id: string) =>
  document.querySelector<HTMLElement>(
    `[data-section-header="${globalThis.CSS.escape(groupKey(id))}"]`,
  )!;

/** Layout position, ignoring the transforms blocks slide by. */
const layoutTops = () =>
  [GENERAL_SECTION_GROUP_ID, "a", "b", "c"].map((groupId) => headerOf(groupId).offsetTop);

async function pointer(
  _fixture: _Fixture,
  type: string,
  target: EventTarget,
  clientX: number,
  clientY: number,
) {
  if (type === "pointerdown" && target instanceof HTMLElement) {
    _fixture.pickup = { y: clientY };
  }
  await act(() => {
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
  });
  const pickup = _fixture.pickup;
  if (type === "pointermove" && pickup && Math.abs(clientY - pickup.y) > 6) {
    await vi.waitFor(() => {
      expect(_fixture.interacting).toBe(true);
    });
  }
  if (type === "pointerup") _fixture.pickup = undefined;
}
it("drags a section as a block without hiding rows or reflowing the list", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onReorderSections = vi.fn();
  await renderView(_fixture, onReorderSections);

  const rowCount = document.querySelectorAll("[data-row]").length;
  expect(rowCount).toBe(8);
  const topsBefore = layoutTops();
  const aTopBefore = headerOf("a").getBoundingClientRect().top;

  // Lift C (last, empty) and carry it above A's middle.
  const handle = headerOf("c").querySelector<HTMLElement>("button[aria-expanded]")!;
  const start = handle.getBoundingClientRect();
  const x = start.left + 20;
  let y = start.top + start.height / 2;
  await pointer(_fixture, "pointerdown", handle, x, y);
  const aMiddle = headerOf("a").getBoundingClientRect().top + (32 + 3 * 48) / 2;
  while (y > aMiddle - 10) {
    y -= 12;
    await pointer(_fixture, "pointermove", document, x, y);
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
  await vi.waitFor(() =>
    expect(Math.round(headerOf("c").getBoundingClientRect().top)).toBe(Math.round(aTopBefore)),
  );

  await pointer(_fixture, "pointerup", document, x, y);

  expect(onReorderSections).toHaveBeenCalledWith(
    [GENERAL_SECTION_GROUP_ID, "c", "a", "b"].map(groupKey),
  );
  expect(document.querySelectorAll("[data-row]").length).toBe(rowCount);
});

it("still files a dragged thread into the section it is dropped in", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  moveThreadsToSection.mockClear();
  await renderView(_fixture, vi.fn());

  const row = document.querySelector<HTMLElement>('[data-row="g1"]')!;
  const start = row.getBoundingClientRect();
  const x = start.left + 20;
  let y = start.top + start.height / 2;
  await pointer(_fixture, "pointerdown", row, x, y);
  // Carry it down into B, between b1 and b2.
  const target = document.querySelector<HTMLElement>('[data-row="b2"]')!.getBoundingClientRect();
  while (y < target.top + 4) {
    y += 12;
    await pointer(_fixture, "pointermove", document, x, y);
  }
  await pointer(_fixture, "pointerup", document, x, y);

  expect(moveThreadsToSection).toHaveBeenCalledWith(
    [expect.objectContaining({ threadId: "g1" })],
    into("b"),
  );
});

it("files a thread dragged up onto a collapsed section's header into that section", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  moveThreadsToSection.mockClear();
  // A is collapsed, so only its header is left to drop on.
  await renderView(_fixture, vi.fn(), { collapsed: ["a"] });

  const row = document.querySelector<HTMLElement>('[data-row="b2"]')!;
  const start = row.getBoundingClientRect();
  const x = start.left + 20;
  let y = start.top + start.height / 2;
  await pointer(_fixture, "pointerdown", row, x, y);
  const header = headerOf("a").getBoundingClientRect();
  while (y > header.top + header.height * 0.75) {
    y -= 12;
    await pointer(_fixture, "pointermove", document, x, y);
  }
  // The header stays put and highlights: the drop goes into A, not the
  // section above it.
  expect(headerOf("a").getBoundingClientRect().top).toBeCloseTo(header.top, 0);
  await pointer(_fixture, "pointerup", document, x, y);

  expect(moveThreadsToSection).toHaveBeenCalledWith(
    [expect.objectContaining({ threadId: "b2" })],
    into("a"),
  );
});

it.each([
  { source: "g1", pickup: "top" },
  { source: "g1", pickup: "bottom" },
  { source: "b1", pickup: "top" },
  { source: "b1", pickup: "bottom" },
])(
  "appends $source to A with $pickup pickup and keeps the preview stable",
  async ({ source, pickup }) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    let release: (value: boolean) => void = () => {};
    moveThreadsToSection.mockClear();
    moveThreadsToSection.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve;
        }),
    );
    reorderActiveThread.mockClear();
    await renderView(_fixture, vi.fn());

    const row = document.querySelector<HTMLElement>(`[data-row="${source}"]`)!;
    const start = row.getBoundingClientRect();
    const last = document.querySelector<HTMLElement>('[data-row="a3"]')!;
    const target = last.getBoundingClientRect();
    const x = start.left + 20;
    // Placement follows the pointer regardless of where the row was picked up.
    const pickupY = pickup === "top" ? start.top + 4 : start.bottom - 4;
    await pointer(_fixture, "pointerdown", row, x, pickupY);
    const y = target.bottom - 4;
    await pointer(_fixture, "pointermove", document, x, pickupY - 8);

    await pointer(_fixture, "pointermove", document, x, y);

    const landingTop =
      last.getBoundingClientRect().top -
      new DOMMatrixReadOnly(getComputedStyle(last).transform).m42 +
      new DOMMatrixReadOnly(last.style.transform).m42;
    await vi.waitFor(() => expect(last.getBoundingClientRect().top).toBeCloseTo(landingTop, 0));
    const previewTop = last.getBoundingClientRect().top;
    _fixture.stack.use(fakeTimers());
    await act(() => vi.advanceTimersByTimeAsync(250));
    expect(last.getBoundingClientRect().top).toBeCloseTo(previewTop, 0);
    await pointer(_fixture, "pointerup", document, x, y);

    expect(moveThreadsToSection).toHaveBeenCalledWith(
      [expect.objectContaining({ threadId: source })],
      into("a"),
    );
    const ids = [...document.querySelectorAll<HTMLElement>("[data-row]")].map(
      (node) => node.dataset.row,
    );
    expect(ids.indexOf(source)).toBe(ids.indexOf("a3") + 1);
    expect(reorderActiveThread).not.toHaveBeenCalled();
    release(true);
    await vi.waitFor(() => expect(reorderActiveThread).toHaveBeenCalledTimes(1));
    const [ref, key] = reorderActiveThread.mock.calls[0]! as unknown as [
      { threadId: string },
      string,
    ];
    expect(ref.threadId).toBe(source);
    expect(key > "m").toBe(true);
  },
);

it("changes insertion side within the same row before committing", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  moveThreadsToSection.mockClear();
  reorderActiveThread.mockClear();
  await renderView(_fixture, vi.fn());

  const row = document.querySelector<HTMLElement>('[data-row="b1"]')!;
  const start = row.getBoundingClientRect();
  const target = document.querySelector<HTMLElement>('[data-row="a2"]')!.getBoundingClientRect();
  const x = start.left + 20;
  await pointer(_fixture, "pointerdown", row, x, start.top + 4);
  await pointer(_fixture, "pointermove", document, x, start.top + 12);

  await pointer(_fixture, "pointermove", document, x, target.top + 4);

  await pointer(_fixture, "pointermove", document, x, target.bottom - 4);

  await pointer(_fixture, "pointerup", document, x, target.bottom - 4);

  expect(reorderActiveThread).toHaveBeenCalledTimes(1);
  const [, key] = reorderActiveThread.mock.calls[0]! as unknown as [unknown, string];
  expect(key > "g" && key < "m").toBe(true);
});

it("reorders to the end within a section without changing membership", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  moveThreadsToSection.mockClear();
  reorderActiveThread.mockClear();
  await renderView(_fixture, vi.fn());

  const row = document.querySelector<HTMLElement>('[data-row="a1"]')!;
  const start = row.getBoundingClientRect();
  const target = document.querySelector<HTMLElement>('[data-row="a3"]')!.getBoundingClientRect();
  const x = start.left + 20;
  await pointer(_fixture, "pointerdown", row, x, start.top + 4);
  await pointer(_fixture, "pointermove", document, x, start.top + 12);

  await pointer(_fixture, "pointermove", document, x, target.bottom - 4);

  await pointer(_fixture, "pointerup", document, x, target.bottom - 4);

  expect(moveThreadsToSection).not.toHaveBeenCalled();
  expect(reorderActiveThread).toHaveBeenCalledTimes(1);
  const [ref, key] = reorderActiveThread.mock.calls[0]! as unknown as [
    { threadId: string },
    string,
  ];
  expect(ref.threadId).toBe("a1");
  expect(key > "m").toBe(true);
});

it("cancels an end-slot preview without writing membership or order", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  moveThreadsToSection.mockClear();
  reorderActiveThread.mockClear();
  await renderView(_fixture, vi.fn());

  const row = document.querySelector<HTMLElement>('[data-row="b1"]')!;
  const start = row.getBoundingClientRect();
  const target = document.querySelector<HTMLElement>('[data-row="a3"]')!.getBoundingClientRect();
  const x = start.left + 20;
  await pointer(_fixture, "pointerdown", row, x, start.top + 4);
  await pointer(_fixture, "pointermove", document, x, start.top + 12);

  await pointer(_fixture, "pointermove", document, x, target.bottom - 4);

  await act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });

  expect(moveThreadsToSection).not.toHaveBeenCalled();
  expect(reorderActiveThread).not.toHaveBeenCalled();
});

it.each([4, 24, 44])("keeps the grabbed point under the pointer (pickup %ipx)", async (grab) => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderView(_fixture, vi.fn());

  const row = document.querySelector<HTMLElement>('[data-row="g1"]')!;
  const start = row.getBoundingClientRect();
  const x = start.left + 20;
  await pointer(_fixture, "pointerdown", row, x, start.top + grab);
  await pointer(_fixture, "pointermove", document, x, start.top + grab + 8);

  for (const offset of [150, 241, 387, 180]) {
    const y = _fixture.host!.getBoundingClientRect().top + offset;
    await pointer(_fixture, "pointermove", document, x + 40, y);

    expect(Math.abs(row.getBoundingClientRect().top + grab - y)).toBeLessThan(1);
    expect(Math.abs(row.getBoundingClientRect().left - start.left)).toBeLessThan(1);
  }
  await act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });

  await vi.waitFor(() =>
    expect(Math.abs(row.getBoundingClientRect().top - start.top)).toBeLessThan(1),
  );
  expect(reorderActiveThread).not.toHaveBeenCalled();
  expect(moveThreadsToSection).not.toHaveBeenCalled();
});

it("switches from a section overlay to direct conversation tracking", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onReorderSections = vi.fn();
  await renderView(_fixture, onReorderSections);

  const handle = headerOf("a").querySelector<HTMLElement>("button[aria-expanded]")!;
  const header = handle.getBoundingClientRect();
  const x = header.left + 20;
  const headerY = header.top + header.height / 2;
  await pointer(_fixture, "pointerdown", handle, x, headerY);
  await pointer(_fixture, "pointermove", document, x, headerY + 12);

  expect(
    [...document.querySelectorAll<HTMLElement>("div")].some(
      (node) => getComputedStyle(node).position === "fixed" && node.textContent?.trim() === "A",
    ),
  ).toBe(true);
  await act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });

  const row = document.querySelector<HTMLElement>('[data-row="g1"]')!;
  const start = row.getBoundingClientRect();
  await pointer(_fixture, "pointerdown", row, x, start.top + 4);
  await pointer(_fixture, "pointermove", document, x, start.top + 12);

  const y = _fixture.host!.getBoundingClientRect().top + 180;
  await pointer(_fixture, "pointermove", document, x, y);

  expect(Math.abs(row.getBoundingClientRect().top + 4 - y)).toBeLessThan(1);
  await act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });

  expect(onReorderSections).not.toHaveBeenCalled();
  expect(reorderActiveThread).not.toHaveBeenCalled();
});

it("keeps pointer attachment when its scrollable list scrolls", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderView(_fixture, vi.fn());
  _fixture.host!.style.height = "300px";
  _fixture.host!.style.overflow = "auto";

  const row = document.querySelector<HTMLElement>('[data-row="g1"]')!;
  const start = row.getBoundingClientRect();
  const grab = 24;
  const x = start.left + 20;
  const y = _fixture.host!.getBoundingClientRect().top + 180;
  await pointer(_fixture, "pointerdown", row, x, start.top + grab);
  await pointer(_fixture, "pointermove", document, x, start.top + grab + 8);

  await pointer(_fixture, "pointermove", document, x, y);

  expect(Math.abs(row.getBoundingClientRect().top + grab - y)).toBeLessThan(1);
  _fixture.host!.scrollTop = 60;
  await vi.waitFor(() => {
    expect(_fixture.host!.scrollTop).toBe(60);
    expect(Math.abs(row.getBoundingClientRect().top + grab - y)).toBeLessThan(1);
  });
  await act(() => {
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }),
    );
  });

  expect(reorderActiveThread).not.toHaveBeenCalled();
  expect(moveThreadsToSection).not.toHaveBeenCalled();
});

it("sets section names 4px low, nearer their own threads, without growing the header", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderView(_fixture, () => {});

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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderView(_fixture, () => {}, { collapsed: ["b"] });

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
  await vi.waitFor(() => expect(opacity(chevronOf("a"))).toBe("1"));
});

it("drops the rule entirely when less than 24px would be left beside the name", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderView(_fixture, () => {}, {
    names: ["A", "A section name long enough to fill the whole header row", "C"],
  });

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
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onRename = vi.fn();
  await renderView(_fixture, () => {}, { renaming: "a", onRename });

  const input = document.querySelector<HTMLInputElement>('input[aria-label="Section name"]')!;
  // The field opens with the name selected; typing replaces it.
  await vi.waitFor(() => {
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
  });
  await userEvent.keyboard("research notes");
  expect(input.value).toBe("Research notes");
  expect(input.selectionStart).toBe("Research notes".length);
  await userEvent.keyboard("{Enter}");
  expect(onRename).toHaveBeenCalledWith("Research notes");
});

// The slide answers the crossing itself: it keeps a 1 s budget rather than the 5 s
// default that browser tests give eventual readiness.
const SLIDE_BUDGET_MS = 1_000;
it("slides a header as soon as the pointer crosses its midpoint and commits the shown slot", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderView(_fixture, vi.fn());

  const row = document.querySelector<HTMLElement>('[data-row="b2"]')!;
  const start = row.getBoundingClientRect();
  const header = headerOf("a").getBoundingClientRect();
  const x = start.left + 20;
  await pointer(_fixture, "pointerdown", row, x, start.top + 4);
  await pointer(_fixture, "pointermove", document, x, start.top + 16);

  await pointer(_fixture, "pointermove", document, x, header.top + header.height / 2 + 2);

  expect(headerOf("a").getBoundingClientRect().top).toBeCloseTo(header.top, 0);
  await pointer(_fixture, "pointermove", document, x, header.top + header.height / 2 - 2);
  await vi.waitFor(
    () => expect(headerOf("a").getBoundingClientRect().top).toBeGreaterThan(header.top + 40),
    { timeout: SLIDE_BUDGET_MS },
  );

  expect(headerOf("a").getBoundingClientRect().top).toBeGreaterThan(header.top + 40);
  await pointer(_fixture, "pointermove", document, x, header.top + header.height / 2 + 2);
  await vi.waitFor(
    () => expect(headerOf("a").getBoundingClientRect().top).toBeCloseTo(header.top, 0),
    { timeout: SLIDE_BUDGET_MS },
  );
  await pointer(_fixture, "pointermove", document, x, header.top + header.height / 2 - 2);
  await vi.waitFor(
    () => expect(headerOf("a").getBoundingClientRect().top).toBeGreaterThan(header.top + 40),
    { timeout: SLIDE_BUDGET_MS },
  );
  await pointer(_fixture, "pointerup", document, x, header.top + header.height / 2 - 2);

  expect(moveThreadsToSection).toHaveBeenCalledWith(
    [expect.objectContaining({ threadId: "b2" })],
    null,
  );
});

it.each([48, 96, 144].flatMap((height) => [4, 24, 44].map((grab) => ({ height, grab }))))(
  "responds at the header midpoint with a $height px preceding row and $grab px pickup",
  async ({ height, grab }) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    await renderView(_fixture, vi.fn());

    document.querySelector<HTMLElement>('[data-row="g2"]')!.style.height = `${height}px`;

    const row = document.querySelector<HTMLElement>('[data-row="b2"]')!;
    const start = row.getBoundingClientRect();
    const header = headerOf("a").getBoundingClientRect();
    const x = start.left + 20;
    const midpoint = header.top + header.height / 2;
    await pointer(_fixture, "pointerdown", row, x, start.top + grab);
    await pointer(_fixture, "pointermove", document, x, start.top + grab - 8);

    await pointer(_fixture, "pointermove", document, x, midpoint + 2);

    expect(headerOf("a").getBoundingClientRect().top).toBeCloseTo(header.top, 0);
    await pointer(_fixture, "pointermove", document, x, midpoint - 2);
    await vi.waitFor(() =>
      expect(headerOf("a").getBoundingClientRect().top).toBeGreaterThan(header.top + 40),
    );

    expect(headerOf("a").getBoundingClientRect().top).toBeGreaterThan(header.top + 40);
    expect(Math.abs(row.getBoundingClientRect().top + grab - (midpoint - 2))).toBeLessThan(1);
    await userEvent.keyboard("{Escape}");
    expect(moveThreadsToSection).not.toHaveBeenCalled();
    expect(reorderActiveThread).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "waits for section membership before writing order (success: %s)",
  async (success) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    let complete: (value: boolean) => void = () => {};
    moveThreadsToSection.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          complete = resolve;
        }),
    );
    await renderView(_fixture, vi.fn());

    const row = document.querySelector<HTMLElement>('[data-row="b2"]')!;
    const start = row.getBoundingClientRect();
    const target = document.querySelector<HTMLElement>('[data-row="a2"]')!.getBoundingClientRect();
    const x = start.left + 20;
    await pointer(_fixture, "pointerdown", row, x, start.top + 4);
    await pointer(_fixture, "pointermove", document, x, start.top + 12);

    await pointer(_fixture, "pointermove", document, x, target.bottom - 4);

    await pointer(_fixture, "pointerup", document, x, target.bottom - 4);
    await vi.waitFor(() =>
      expect(moveThreadsToSection).toHaveBeenCalledWith(
        [expect.objectContaining({ threadId: "b2" })],
        into("a"),
      ),
    );
    expect(reorderActiveThread).not.toHaveBeenCalled();
    const ids = () =>
      [...document.querySelectorAll<HTMLElement>("[data-row]")].map((node) => node.dataset.row);
    expect(ids().indexOf("b2")).toBe(ids().indexOf("a2") + 1);
    complete(success);
    if (success) {
      await vi.waitFor(() => expect(reorderActiveThread).toHaveBeenCalledTimes(1));
      expect(reorderActiveThread).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: "b2" }),
        expect.any(String),
      );
    } else {
      await vi.waitFor(() => expect(ids().indexOf("b2")).toBe(ids().indexOf("b1") + 1));
      expect(reorderActiveThread).not.toHaveBeenCalled();
    }
  },
);

it("refuses to drop a thread into another environment's section", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderView(_fixture, vi.fn(), { foreignThread: true });

  // Its section id names a section only on the test environment: it shows in General.
  const general = [...document.querySelectorAll<HTMLElement>("[data-row]")].map(
    (node) => node.dataset.row,
  );
  expect(general.indexOf("x1")).toBeLessThan(general.indexOf("a1"));
  const row = document.querySelector<HTMLElement>('[data-row="x1"]')!;
  const start = row.getBoundingClientRect();
  const x = start.left + 20;
  let y = start.top + start.height / 2;
  await pointer(_fixture, "pointerdown", row, x, y);
  const target = document.querySelector<HTMLElement>('[data-row="b2"]')!.getBoundingClientRect();
  while (y < target.top + 4) {
    y += 12;
    await pointer(_fixture, "pointermove", document, x, y);
  }
  // B never reads as a destination.
  expect(headerOf("b").firstElementChild!.className).not.toContain("text-primary");
  await pointer(_fixture, "pointerup", document, x, y);

  expect(moveThreadsToSection).not.toHaveBeenCalled();
  expect(reorderActiveThread).not.toHaveBeenCalled();
});

it("marks each section's machine with its icon when sections from several machines show", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  await renderView(_fixture, vi.fn(), {
    environmentMachines: new Map([["env", { label: "Lab server", kind: "server" }]]),
    names: ["A long section name that fills the narrow sidebar", "B", "C"],
  });

  const machine = headerOf("a").querySelector('[role="img"][aria-label="Lab server"]');
  expect(machine).not.toBeNull();
  // The icon replaces the name, so the section's name keeps the width.
  expect(headerOf("a").textContent).not.toContain("Lab server");
  expect(headerOf("a").textContent).toContain("A long section name");
  // General belongs to no machine.
  expect(headerOf(GENERAL_SECTION_GROUP_ID).querySelector('[role="img"]')).toBeNull();
});

it("keeps a manual drop in the promoted display without saving unrelated automatic positions", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const onManualPlacement = vi.fn();
  await renderView(_fixture, vi.fn(), { promoted: true, onManualPlacement });

  const row = document.querySelector<HTMLElement>('[data-row="a2"]')!;
  const start = row.getBoundingClientRect();
  const target = document.querySelector<HTMLElement>('[data-row="a3"]')!.getBoundingClientRect();
  const x = start.left + 20;
  await pointer(_fixture, "pointerdown", row, x, start.top + 4);
  await pointer(_fixture, "pointermove", document, x, start.top + 12);

  await pointer(_fixture, "pointermove", document, x, target.bottom - 4);

  await pointer(_fixture, "pointerup", document, x, target.bottom - 4);
  await vi.waitFor(() => expect(onManualPlacement).toHaveBeenCalledTimes(1));
  expect(onManualPlacement.mock.calls[0]!.slice(0, 3)).toEqual([
    groupKey("a"),
    ["env:a3", "env:a2", "env:a1"],
    "env:a2",
  ]);
  expect(reorderActiveThread).toHaveBeenCalledTimes(1);
  const [ref, key] = reorderActiveThread.mock.calls[0]! as unknown as [
    { environmentId: string; threadId: string },
    string,
  ];
  expect(ref).toEqual({ environmentId: "env", threadId: "a2" });
  expect(key > "m").toBe(true);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    host: undefined! as HTMLDivElement | undefined,
    stack,
    pickup: undefined as { y: number } | undefined,
    interacting: false,
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
