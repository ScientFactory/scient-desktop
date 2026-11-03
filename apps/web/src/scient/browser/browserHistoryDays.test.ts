import { describe, expect, it } from "vite-plus/test";

import { pagesByDay } from "./browserHistoryDays";

const page = (lastVisitedAt: number) => ({
  url: `https://${lastVisitedAt}.test/`,
  title: "",
  lastVisitedAt,
});

describe("pagesByDay", () => {
  const now = new Date(2026, 10, 3, 9, 0).getTime();

  it("names today and yesterday by the calendar, not by 24 hours", () => {
    const earlierToday = new Date(2026, 10, 3, 0, 5).getTime();
    const lateYesterday = new Date(2026, 10, 2, 23, 55).getTime();
    const days = pagesByDay([page(earlierToday), page(lateYesterday)], now);
    expect(days.map((day) => day.label)).toEqual(["Today", "Yesterday"]);
  });

  it("keeps a month's turn and older days in order under their dates", () => {
    const lastMonth = new Date(2026, 9, 31, 12).getTime();
    const sameDay = new Date(2026, 9, 31, 8).getTime();
    const days = pagesByDay([page(lastMonth), page(sameDay)], now);
    expect(days).toHaveLength(1);
    expect(days[0]?.pages).toHaveLength(2);
    expect(days[0]?.label).toContain("31");
  });

  it("has nothing to show for no pages", () => {
    expect(pagesByDay([], now)).toEqual([]);
  });
});
