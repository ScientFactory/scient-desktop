import { render as _fixtureRender, type Screen, act } from "../../../test/render";
import { EnvironmentId } from "@t3tools/contracts";
import { useLayoutEffect } from "react";

import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ requestPicker: vi.fn() }));
vi.mock("./catalog", () => ({
  useThreadSectionCatalogs: () => ({
    catalogFor: (environmentId: string) =>
      environmentId === "missing" ? null : { environmentId, sections: [], generalIndex: 0 },
  }),
}));
vi.mock("./actions", () => ({
  readEnvironmentSupportsSections: (environmentId: string) => environmentId !== "old",
}));

import { useThreadSectionMenu } from "./useThreadSectionMenu";

const LAPTOP = EnvironmentId.make("laptop");
const LAB = EnvironmentId.make("lab");

function Probe({ _fixture }: { _fixture: _Fixture }) {
  const value = useThreadSectionMenu(mocks.requestPicker);
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

it("offers Move to section only when every thread's server stores sections", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
  await _setupFixture0(_fixture);

  // Threads on two environments can still move, to General or a new section.
  expect(_fixture.menu.menuFor([{ environmentId: LAPTOP }, { environmentId: LAB }])?.id).toBe(
    "section",
  );
  expect(
    _fixture.menu.menuFor([
      { environmentId: LAPTOP },
      { environmentId: EnvironmentId.make("old") },
    ]),
  ).toBeNull();
  expect(_fixture.menu.menuFor([{ environmentId: EnvironmentId.make("missing") }])).toBeNull();
  expect(_fixture.menu.menuFor([])).toBeNull();
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
