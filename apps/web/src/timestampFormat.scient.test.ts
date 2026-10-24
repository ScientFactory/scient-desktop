import { describe, expect, it } from "vite-plus/test";

import { formatDateTimeTimestamp } from "./timestampFormat";

describe("receipt date and time", () => {
  it("keeps the date and seconds with the user's clock preference", () => {
    const date = new Date(2025, 8, 15, 17, 4, 3);
    const expected = new Intl.DateTimeFormat(undefined, {
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(date);
    expect(formatDateTimeTimestamp(date.toISOString(), "24-hour")).toBe(expected);
  });
});
