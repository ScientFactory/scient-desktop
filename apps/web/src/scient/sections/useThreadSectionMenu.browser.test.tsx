import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId, ThreadId, ThreadSectionId, type ThreadSection } from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";

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

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const value = useThreadSectionMenu(mocks.requestNew);
  useLayoutEffect(() => {
    _fixture.publishMenu(value);
  });
  return null;
}

async function _setupFixture0(_fixture: _Fixture) {
  vi.clearAllMocks();
  await act(async () => {
    _fixture.root0 = _fixture.stack.use(
      await _fixtureRender(null, { container: document.createElement("div"), router: false }),
    );
    await _fixture.root0.rerender(<Probe _fixture={_fixture} />);
  });
}
async function _cleanupFixture1(_fixture: _Fixture) {
  await act(async () => await _fixture.root0.unmount());
  vi.unstubAllGlobals();
}

const labels = (_fixture: _Fixture, item: ReturnType<typeof _fixture.menu.menuFor>) =>
  item?.children?.map((child) => [child.label, child.checked]);

it("lists the sections of the threads' own environment", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  expect(
    labels(_fixture, _fixture.menu.menuFor([{ environmentId: LAPTOP, sectionId: "papers" }])),
  ).toEqual([
    ["Papers", true],
    ["General", false],
    ["New section…", undefined],
  ]);
  expect(
    labels(_fixture, _fixture.menu.menuFor([{ environmentId: LAB, sectionId: null }])),
  ).toEqual([
    ["General", true],
    ["Runs", false],
    ["New section…", undefined],
  ]);
});

it("reads a section id the thread's catalog doesn't hold as General", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  // "papers" is a laptop section; on the lab it names nothing.
  expect(
    labels(_fixture, _fixture.menu.menuFor([{ environmentId: LAB, sectionId: "papers" }]))?.[0],
  ).toEqual(["General", true]);
});

it("offers only General and a new section across environments", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const item = _fixture.menu.menuFor([
    { environmentId: LAPTOP, sectionId: "papers" },
    { environmentId: LAB, sectionId: null },
  ]);
  expect(labels(_fixture, item)).toEqual([
    ["General", false],
    ["New section…", undefined],
  ]);
  // Each thread in a section of its own environment checks nothing shared.
  expect(
    labels(
      _fixture,
      _fixture.menu.menuFor([
        { environmentId: LAPTOP, sectionId: "papers" },
        { environmentId: LAB, sectionId: "runs" },
      ]),
    )?.[0],
  ).toEqual(["General", false]);
});

it("has no submenu when a thread's server can't store sections", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  expect(
    _fixture.menu.menuFor([{ environmentId: EnvironmentId.make("old"), sectionId: null }]),
  ).toBeNull();
  expect(_fixture.menu.menuFor([])).toBeNull();
});

it("files the chosen section on the threads' environment", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  const threadRefs = [{ environmentId: LAB, threadId: ThreadId.make("t1") }];
  expect(await _fixture.menu.handleMenuAction("section:set:runs", threadRefs, { x: 0, y: 0 })).toBe(
    true,
  );
  expect(mocks.moveThreadsToSection).toHaveBeenCalledWith(threadRefs, {
    environmentId: LAB,
    sectionId: "runs",
  });
  await _fixture.menu.handleMenuAction("section:remove", threadRefs, { x: 0, y: 0 });
  expect(mocks.moveThreadsToSection).toHaveBeenLastCalledWith(threadRefs, null);
  await _fixture.menu.handleMenuAction("section:new", threadRefs, { x: 1, y: 2 });
  expect(mocks.requestNew).toHaveBeenCalledWith(threadRefs, { x: 1, y: 2 });
  expect(await _fixture.menu.handleMenuAction("archive", threadRefs, { x: 0, y: 0 })).toBe(false);
});

function _createFixture() {
  let _published_menu = undefined! as ReturnType<typeof useThreadSectionMenu>;

  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    get menu() {
      return _published_menu;
    },
    publishMenu(next: typeof _published_menu) {
      _published_menu = next;
    },

    stack,
    cleanup,
    root0: undefined! as Screen,
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
