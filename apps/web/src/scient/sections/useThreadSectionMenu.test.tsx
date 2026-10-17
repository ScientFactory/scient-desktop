import { EnvironmentId, ThreadId, ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  moveThreadsToSection: vi.fn(async () => true),
  requestNew: vi.fn(),
}));
const section = (id: string, order: number): ThreadSection => ({
  id: ThreadSectionId.make(id),
  name: id[0]!.toUpperCase() + id.slice(1),
  order,
});
vi.mock("./catalog", () => ({
  useThreadSectionCatalogs: () => ({
    catalogFor: (environmentId: string) =>
      environmentId === "laptop"
        ? { environmentId, sections: [section("papers", 0)], generalIndex: 1 }
        : environmentId === "lab"
          ? { environmentId, sections: [section("runs", 0)], generalIndex: 0 }
          : null,
  }),
}));
vi.mock("./actions", () => ({
  readEnvironmentSupportsSections: (environmentId: string) => environmentId !== "old",
  useThreadSectionActions: () => ({ moveThreadsToSection: mocks.moveThreadsToSection }),
}));

import { useThreadSectionMenu } from "./useThreadSectionMenu";

const LAPTOP = EnvironmentId.make("laptop");
const LAB = EnvironmentId.make("lab");
let menu: ReturnType<typeof useThreadSectionMenu>;
let renderer: ReactTestRenderer;
function Probe() {
  const value = useThreadSectionMenu(mocks.requestNew);
  useLayoutEffect(() => {
    menu = value;
  });
  return null;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  act(() => {
    renderer = create(<Probe />);
  });
});
afterEach(() => {
  act(() => renderer.unmount());
  vi.unstubAllGlobals();
});

const labels = (item: ReturnType<typeof menu.menuFor>) =>
  item?.children?.map((child) => [child.label, child.checked]);

it("lists the sections of the threads' own environment", () => {
  expect(labels(menu.menuFor([{ environmentId: LAPTOP, sectionId: "papers" }]))).toEqual([
    ["Papers", true],
    ["General", false],
    ["New section…", undefined],
  ]);
  expect(labels(menu.menuFor([{ environmentId: LAB, sectionId: null }]))).toEqual([
    ["General", true],
    ["Runs", false],
    ["New section…", undefined],
  ]);
});

it("reads a section id the thread's catalog doesn't hold as General", () => {
  // "papers" is a laptop section; on the lab it names nothing.
  expect(labels(menu.menuFor([{ environmentId: LAB, sectionId: "papers" }]))?.[0]).toEqual([
    "General",
    true,
  ]);
});

it("offers only General and a new section across environments", () => {
  const item = menu.menuFor([
    { environmentId: LAPTOP, sectionId: "papers" },
    { environmentId: LAB, sectionId: null },
  ]);
  expect(labels(item)).toEqual([
    ["General", false],
    ["New section…", undefined],
  ]);
  // Each thread in a section of its own environment checks nothing shared.
  expect(
    labels(
      menu.menuFor([
        { environmentId: LAPTOP, sectionId: "papers" },
        { environmentId: LAB, sectionId: "runs" },
      ]),
    )?.[0],
  ).toEqual(["General", false]);
});

it("has no submenu when a thread's server can't store sections", () => {
  expect(menu.menuFor([{ environmentId: EnvironmentId.make("old"), sectionId: null }])).toBeNull();
  expect(menu.menuFor([])).toBeNull();
});

it("files the chosen section on the threads' environment", async () => {
  const threadRefs = [{ environmentId: LAB, threadId: ThreadId.make("t1") }];
  expect(await menu.handleMenuAction("section:set:runs", threadRefs, { x: 0, y: 0 })).toBe(true);
  expect(mocks.moveThreadsToSection).toHaveBeenCalledWith(threadRefs, {
    environmentId: LAB,
    sectionId: "runs",
  });
  await menu.handleMenuAction("section:remove", threadRefs, { x: 0, y: 0 });
  expect(mocks.moveThreadsToSection).toHaveBeenLastCalledWith(threadRefs, null);
  await menu.handleMenuAction("section:new", threadRefs, { x: 1, y: 2 });
  expect(mocks.requestNew).toHaveBeenCalledWith(threadRefs, { x: 1, y: 2 });
  expect(await menu.handleMenuAction("archive", threadRefs, { x: 0, y: 0 })).toBe(false);
});
