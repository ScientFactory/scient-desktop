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
  vi.unstubAllGlobals();
  vi.resetModules();
});
it("restores semantic identity after a renderer reload without persisting a bare scroll offset", async () => {
  const values = storage();
  vi.resetModules();
  const { rememberTimelinePosition } = await import("./timelineScrollAnchoring");
  rememberTimelinePosition("environment:thread", {
    rowId: "message:answer",
    messageId: "answer",
    turnId: "turn",
    offsetWithinRow: 123.5,
    scrollOffset: 99999,
    atEnd: true,
    neighborMessageIds: ["prompt"],
  });
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
  const { readTimelinePosition, rememberTimelinePosition } =
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
  vi.resetModules();
  const reloaded = await import("./timelineScrollAnchoring");
  expect(reloaded.readTimelinePosition("thread-4")).toBeUndefined();
  expect(reloaded.readTimelinePosition("thread-104")?.rowId).toBe("row-104");
});
