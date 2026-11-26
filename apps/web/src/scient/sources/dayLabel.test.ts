import { describe, expect, it } from "vite-plus/test";

import { byLine, whenLabel } from "./dayLabel";

const now = new Date(2026, 10, 25, 21, 40);
const at = (month: number, day: number, year = 2026) =>
  new Date(year, month, day, 21, 31).toISOString();

describe("Library dates", () => {
  it("say today and yesterday, drop the year within it, and never show seconds", () => {
    expect(whenLabel(at(10, 25), undefined, now)).toMatch(/^Today, \d{1,2}:31\b/u);
    expect(whenLabel(at(10, 24), undefined, now)).toMatch(/^Yesterday, \d{1,2}:31\b/u);
    const earlier = whenLabel(at(9, 2), undefined, now);
    expect(earlier).not.toMatch(/2026|:\d\d:\d\d/u);
    expect(whenLabel(at(9, 2, 2025), undefined, now)).toMatch(/2025/u);
    expect(whenLabel("not a date", undefined, now)).toBe("");
  });

  it("name an agent and leave the person's own changes to their time", () => {
    expect(byLine("user", at(10, 25), undefined, now)).toBe(whenLabel(at(10, 25), undefined, now));
    expect(byLine("agent", at(10, 25), undefined, now)).toMatch(/^Agent · Today, /u);
    expect(byLine("agent", "not a date", undefined, now)).toBe("Agent");
  });
});
