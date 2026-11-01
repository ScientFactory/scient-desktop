import { render as _fixtureRender, type Screen } from "../../test/render";
import "../index.css";

import { expect, it, vi } from "vite-plus/test";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../hooks/useTheme", async (original) => ({
  ...(await original<typeof import("../hooks/useTheme")>()),
  useTheme: () => ({ resolvedTheme: "dark" }),
}));
// Word wrap off: the code/diff preference must not truncate chat tables.
vi.mock("../hooks/useSettings", async (original) => {
  const actual = await original<typeof import("../hooks/useSettings")>();
  return {
    ...actual,
    getClientSettings: () => ({ ...actual.getClientSettings(), wordWrap: false }),
  };
});

import ChatMarkdown from "./ChatMarkdown";

async function _cleanupFixture0(_fixture: _Fixture) {
  await _fixture.root0?.unmount();
  _fixture.host?.remove();
  _fixture.root0 = undefined;
  _fixture.host = undefined;
}

const LONG_NOTE =
  "that's the day the ultrasound noticed the gallbladder was inflamed and the follow-up was scheduled for the next morning";
const TABLE = `| Day | Note |\n|---|---|\n| 1 | ${LONG_NOTE} |`;

/** Mounts a chat table in a message-width column that clips horizontal overflow, as the timeline does. */
async function mountTable(_fixture: _Fixture) {
  _fixture.host = document.createElement("div");
  _fixture.host.style.width = "640px";
  _fixture.host.className = "overflow-x-clip";
  document.body.append(_fixture.host);
  // Table geometry is independent of navigation; useNavigate is mocked above.
  _fixture.root0 = _fixture.stack.use(
    await _fixtureRender(null, { container: _fixture.host, router: false }),
  );
  await _fixture.root0.rerender(<ChatMarkdown cwd="/workspace" text={TABLE} />);
  const container = _fixture.host.querySelector<HTMLElement>(".chat-markdown-table-container")!;
  const viewport = container.querySelector<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
  const cells = [...container.querySelectorAll<HTMLElement>("th, td")];
  return { container, viewport, cells };
}

function clippedCells(cells: HTMLElement[]) {
  return cells
    .filter((cell) => cell.scrollWidth > cell.clientWidth)
    .map((cell) => cell.textContent);
}

it("opens tables with wrapped cells even when Word wrap is off", async () => {
  await using _fixture = _createFixture();
  _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

  const { viewport, cells } = await mountTable(_fixture);

  await vi.waitFor(() => {
    expect(clippedCells(cells)).toEqual([]);
    expect(viewport.clientWidth).toBeGreaterThan(0);
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
  });
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
