import { describe, expect, it } from "vite-plus/test";

import { formatReceiptDateTime } from "./timestampFormat";

describe("receipt date and time", () => {
  // regression: 2a48f8bac2 refactor(orchestration): publish the qualified V2 alignment tree
  it.each(["12-hour", "24-hour", "locale"] as const)(
    "keeps date and seconds with the %s clock",
    (preference) => {
      const date = new Date(2025, 8, 15, 17, 4, 3);
      const expected = new Intl.DateTimeFormat(undefined, {
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
        ...(preference === "locale" ? {} : { hour12: preference === "12-hour" }),
      }).format(date);
      expect(formatReceiptDateTime(date.toISOString(), preference)).toBe(expected);
    },
  );
  // regression: 2a48f8bac2 refactor(orchestration): publish the qualified V2 alignment tree
  it("omits invalid dates", () => {
    expect(formatReceiptDateTime("not-a-date", "24-hour")).toBe("");
  });
});
