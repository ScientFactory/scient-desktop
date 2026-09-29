import { afterEach, expect, it, vi } from "vite-plus/test";
const key = "scient:timeline-reading-position:v1";
function storage(initial?: string) {
  const values = new Map(initial ? [[key, initial]] : []);
  vi.stubGlobal("sessionStorage", {
    getItem: (name: string) => values.get(name) ?? null,
    setItem: (name: string, value: string) => values.set(name, value),
  });
  return values;
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("restores semantic identity after a renderer reload without persisting a bare scroll offset", async () => {
  const values = storage();
  vi.resetModules();
  const { rememberTimelinePosition, flushTimelinePositions } =
    await import("./timelineScrollAnchoring");
  rememberTimelinePosition("environment:thread", {
    rowId: "message:answer",
    messageId: "answer",
    turnId: "turn",
    offsetWithinRow: 123.5,
    scrollOffset: 99999,
    atEnd: true,
    neighborMessageIds: ["prompt"],
  });
  flushTimelinePositions();
  expect(values.get(key)).not.toContain("scrollOffset");
  vi.resetModules();
  const { readTimelinePosition } = await import("./timelineScrollAnchoring");
  expect(readTimelinePosition("environment:thread")).toMatchObject({
    messageId: "answer",
    turnId: "turn",
    offsetWithinRow: 123.5,
    scrollOffset: 0,
  });
  expect(readTimelinePosition("another-environment:thread")).toBeUndefined();
});
it("ignores corrupt records and bounds retained thread positions", async () => {
  storage(JSON.stringify([["broken", { rowId: "row", offsetWithinRow: "bad", atEnd: false }]]));
  vi.resetModules();
  const { readTimelinePosition, rememberTimelinePosition, flushTimelinePositions } =
    await import("./timelineScrollAnchoring");
  expect(readTimelinePosition("broken")).toBeUndefined();
  for (let i = 0; i < 105; i++)
    rememberTimelinePosition(`thread-${i}`, {
      rowId: `row-${i}`,
      offsetWithinRow: 0,
      scrollOffset: 0,
      atEnd: false,
    });
  expect(readTimelinePosition("thread-0")).toBeUndefined();
  flushTimelinePositions();
  vi.resetModules();
  const reloaded = await import("./timelineScrollAnchoring");
  expect(reloaded.readTimelinePosition("thread-4")).toBeUndefined();
  expect(reloaded.readTimelinePosition("thread-104")?.rowId).toBe("row-104");
});

it("captures immediately, coalesces storage writes, and flushes before page exit", async () => {
  vi.useFakeTimers();
  const values = storage();
  const { readTimelinePosition, rememberTimelinePosition, flushTimelinePositions } =
    await import("./timelineScrollAnchoring");
  const position = { rowId: "answer", offsetWithinRow: 10, scrollOffset: 500, atEnd: false };
  rememberTimelinePosition("quick", position);
  expect(readTimelinePosition("quick")).toEqual(position);
  expect(values.has(key)).toBe(false);
  vi.advanceTimersByTime(100);
  rememberTimelinePosition("quick", { ...position, offsetWithinRow: 30 });
  vi.advanceTimersByTime(119);
  expect(values.has(key)).toBe(false);
  vi.advanceTimersByTime(1);
  expect(JSON.parse(values.get(key)!)[0][1].offsetWithinRow).toBe(30);
  rememberTimelinePosition("quick", { ...position, offsetWithinRow: 40 });
  flushTimelinePositions();
  vi.resetModules();
  const reloaded = await import("./timelineScrollAnchoring");
  expect(reloaded.readTimelinePosition("quick")?.offsetWithinRow).toBe(40);
});
