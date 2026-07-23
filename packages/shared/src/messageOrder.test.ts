import { describe, expect, it } from "vitest";
import { compareProjectionMessageOrderValues } from "./messageOrder";

describe("compareProjectionMessageOrderValues", () => {
  it("orders by timestamp before message id", () => {
    expect(
      compareProjectionMessageOrderValues(
        "2026-07-23T00:00:00.000Z",
        "message-z",
        "2026-07-23T00:00:01.000Z",
        "message-a",
      ),
    ).toBeLessThan(0);
  });

  it("uses the message id as the stable timestamp tie-break", () => {
    const createdAt = "2026-07-23T00:00:00.000Z";
    expect(
      compareProjectionMessageOrderValues(createdAt, "message-a", createdAt, "message-z"),
    ).toBeLessThan(0);
    expect(
      compareProjectionMessageOrderValues(createdAt, "message-z", createdAt, "message-a"),
    ).toBeGreaterThan(0);
  });
});
