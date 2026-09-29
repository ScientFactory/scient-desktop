import "../index.css";

import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vitest/browser";

vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
// Word wrap off: the code/diff preference must not truncate chat tables.
vi.mock("../hooks/useSettings", async (original) => {
  const actual = await original<typeof import("../hooks/useSettings")>();
  return {
    ...actual,
    getClientSettings: () => ({ ...actual.getClientSettings(), wordWrap: false }),
  };
});

import ChatMarkdown from "./ChatMarkdown";

let root: Root | undefined;
let host: HTMLDivElement | undefined;

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = undefined;
  host = undefined;
});

const nextFrame = () =>
  new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 16)));

const LONG_NOTE =
  "that's the day the ultrasound noticed the gallbladder was inflamed and the follow-up was scheduled for the next morning";
const TABLE = `| Day | Note |\n|---|---|\n| 1 | ${LONG_NOTE} |`;

/** Mounts a chat table in a message-width column that clips horizontal overflow, as the timeline does. */
async function mountTable() {
  host = document.createElement("div");
  host.style.width = "640px";
  host.className = "overflow-x-clip";
  document.body.append(host);
  root = createRoot(host);
  root.render(<ChatMarkdown cwd="/workspace" text={TABLE} />);
  await nextFrame();
  await nextFrame();
  const container = host.querySelector<HTMLElement>(".chat-markdown-table-container")!;
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
  const { container, viewport, cells } = await mountTable();

  expect(container.dataset.expanded).toBe("true");
  expect(clippedCells(cells)).toEqual([]);
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth);
});

it("keeps full single-line cells reachable by horizontal scrolling when collapsed", async () => {
  const { container, viewport, cells } = await mountTable();
  container.querySelector<HTMLButtonElement>('button[aria-label="Collapse table cells"]')!.click();
  await nextFrame();
  await nextFrame();

  expect(container.dataset.expanded).toBe("false");
  expect(clippedCells(cells)).toEqual([]);
  expect(viewport.scrollWidth).toBeGreaterThan(viewport.clientWidth);

  await userEvent.wheel(viewport, { delta: { x: 2000 } });
  await nextFrame();
  expect(viewport.scrollLeft).toBe(viewport.scrollWidth - viewport.clientWidth);
});
