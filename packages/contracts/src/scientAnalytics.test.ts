import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ScientAnalyticsStatus, ScientAnalyticsUiEvent } from "./scientAnalytics.ts";

const status = Schema.decodeUnknownSync(ScientAnalyticsStatus);
const event = Schema.decodeUnknownSync(ScientAnalyticsUiEvent);

describe("Scient UI analytics compatibility", () => {
  it("retains old status and event shapes without inventing an operation context", () => {
    expect(status({ available: true, consent: "product" })).toEqual({
      available: true,
      consent: "product",
    });
    expect(event({ name: "project.opened", properties: {} })).toEqual({
      name: "project.opened",
      properties: {},
    });
  });
  it("transports a bounded context outside the event properties", () => {
    expect(
      status({ available: true, consent: "product", collectionContext: "context-1" })
        .collectionContext,
    ).toBe("context-1");
    const input = {
      name: "scient.operation.completed",
      properties: { operationKind: "pdf-export" },
      collectionContext: "context-1",
    };
    expect(event(input)).toEqual(input);
    expect(() => status({ available: true, consent: "product", collectionContext: "" })).toThrow();
    expect(() => event({ ...input, collectionContext: "x".repeat(97) })).toThrow();
  });
  it("does not authorize arbitrary new UI event names", () => {
    expect(() => event({ name: "raw.error", properties: { message: "private error" } })).toThrow();
  });
});
