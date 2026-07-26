import { describe, expect, it } from "vitest";

import {
  ToolInputError,
  decodeWaitForThreadsInput,
  readBooleanArg,
  readNumberArg,
  readStringArg,
} from "./toolInput.ts";

describe("readStringArg", () => {
  it("trims the value", () => {
    expect(readStringArg({ name: "  hello  " }, "name")).toBe("hello");
  });

  it("throws ToolInputError when required and missing", () => {
    expect(() => readStringArg({}, "name", { required: true })).toThrow(ToolInputError);
    expect(() => readStringArg({ name: null }, "name", { required: true })).toThrow(
      ToolInputError,
    );
  });

  it("returns undefined when optional and missing", () => {
    expect(readStringArg({}, "name")).toBeUndefined();
    expect(readStringArg({ name: undefined }, "name")).toBeUndefined();
    expect(readStringArg({ name: null }, "name")).toBeUndefined();
  });

  it("throws on an empty or whitespace-only string", () => {
    expect(() => readStringArg({ name: "" }, "name")).toThrow(ToolInputError);
    expect(() => readStringArg({ name: "   " }, "name")).toThrow(ToolInputError);
  });

  it("throws on a non-string value", () => {
    expect(() => readStringArg({ name: 42 }, "name")).toThrow(ToolInputError);
    expect(() => readStringArg({ name: true }, "name")).toThrow(ToolInputError);
    expect(() => readStringArg({ name: {} }, "name")).toThrow(ToolInputError);
  });
});

describe("readNumberArg", () => {
  it("returns a finite number", () => {
    expect(readNumberArg({ count: 5 }, "count")).toBe(5);
    expect(readNumberArg({ count: 0 }, "count")).toBe(0);
    expect(readNumberArg({ count: -3.5 }, "count")).toBe(-3.5);
  });

  it("throws on NaN or Infinity", () => {
    expect(() => readNumberArg({ count: Number.NaN }, "count")).toThrow(ToolInputError);
    expect(() => readNumberArg({ count: Number.POSITIVE_INFINITY }, "count")).toThrow(
      ToolInputError,
    );
    expect(() => readNumberArg({ count: Number.NEGATIVE_INFINITY }, "count")).toThrow(
      ToolInputError,
    );
  });

  it("throws on a non-number value", () => {
    expect(() => readNumberArg({ count: "5" }, "count")).toThrow(ToolInputError);
  });

  it("returns undefined when missing", () => {
    expect(readNumberArg({}, "count")).toBeUndefined();
    expect(readNumberArg({ count: null }, "count")).toBeUndefined();
  });
});

describe("readBooleanArg", () => {
  it("returns a boolean value", () => {
    expect(readBooleanArg({ flag: true }, "flag")).toBe(true);
    expect(readBooleanArg({ flag: false }, "flag")).toBe(false);
  });

  it("throws on a non-boolean value", () => {
    expect(() => readBooleanArg({ flag: "true" }, "flag")).toThrow(ToolInputError);
    expect(() => readBooleanArg({ flag: 1 }, "flag")).toThrow(ToolInputError);
  });

  it("returns undefined when missing", () => {
    expect(readBooleanArg({}, "flag")).toBeUndefined();
    expect(readBooleanArg({ flag: null }, "flag")).toBeUndefined();
  });
});

describe("decodeWaitForThreadsInput", () => {
  it("decodes a valid { threadIds } input", () => {
    const result = decodeWaitForThreadsInput({ threadIds: ["t1"] });
    expect(result).toEqual({ threadIds: ["t1"] });
  });

  it("throws ToolInputError on excess/unknown properties", () => {
    expect(() =>
      decodeWaitForThreadsInput({ threadIds: ["t1"], unexpected: "field" }),
    ).toThrow(ToolInputError);
  });

  it("throws when threadIds exceeds the max of 20", () => {
    const threadIds = Array.from({ length: 21 }, (_, i) => `t${i}`);
    expect(() => decodeWaitForThreadsInput({ threadIds })).toThrow(ToolInputError);
  });

  it("accepts exactly 20 threadIds", () => {
    const threadIds = Array.from({ length: 20 }, (_, i) => `t${i}`);
    expect(() => decodeWaitForThreadsInput({ threadIds })).not.toThrow();
  });

  it("throws when threadIds is empty", () => {
    expect(() => decodeWaitForThreadsInput({ threadIds: [] })).toThrow(ToolInputError);
  });

  it("wraps the underlying schema error in a ToolInputError", () => {
    let caught: unknown;
    try {
      decodeWaitForThreadsInput({ threadIds: [] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ToolInputError);
  });
});
