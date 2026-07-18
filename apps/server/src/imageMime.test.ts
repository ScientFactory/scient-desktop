import { describe, expect, it } from "vitest";

import { inferAttachmentExtension, inferImageExtension, parseBase64DataUrl } from "./imageMime.ts";

describe("imageMime", () => {
  it("parses base64 data URL with mime type", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("parses base64 data URL with mime parameters", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("rejects non-base64 data URL", () => {
    expect(parseBase64DataUrl("data:image/png;charset=utf-8,hello")).toBeNull();
  });

  it("rejects missing mime type", () => {
    expect(parseBase64DataUrl("data:;base64,SGVsbG8=")).toBeNull();
  });

  it("parses base64 data URL with spaces in payload", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs bG8=\n")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("rejects invalid or structurally malformed base64 payloads", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVs!bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVs,bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,AB=CD===")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGV=bG8=")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=====AAA")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8")).toBeNull();
  });

  it("accepts valid payloads with zero, one, or two padding characters", () => {
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8h")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8h",
    });
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
    expect(parseBase64DataUrl("data:image/png;base64,SGVsbA==")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbA==",
    });
  });

  it("rejects empty and whitespace-only payloads", () => {
    expect(parseBase64DataUrl("data:image/png;base64,")).toBeNull();
    expect(parseBase64DataUrl("data:image/png;base64, \r\n")).toBeNull();
  });

  it("parses a case-insensitive scheme and mime type", () => {
    expect(parseBase64DataUrl("DATA:IMAGE/PNG;BASE64,SGVsbG8=")).toEqual({
      mimeType: "image/png",
      base64: "SGVsbG8=",
    });
  });

  it("parses a multi-megabyte payload from a deep call stack", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(14_000_000)}`;
    const parseAtDepth = (depth: number): ReturnType<typeof parseBase64DataUrl> =>
      depth === 0 ? parseBase64DataUrl(dataUrl) : parseAtDepth(depth - 1);
    const findMaximumDepth = (depth: number): number => {
      try {
        return findMaximumDepth(depth + 1);
      } catch {
        return depth;
      }
    };

    const result = parseAtDepth(Math.floor(findMaximumDepth(0) * 0.85));

    expect(result?.mimeType).toBe("image/png");
    expect(result?.base64.length).toBe(14_000_000);
  });

  it("does not read inherited keys from mime extension map", () => {
    expect(inferImageExtension({ mimeType: "constructor" })).toBe(".bin");
  });

  it("infers generic attachment extensions from mime type", () => {
    expect(inferAttachmentExtension({ mimeType: "application/pdf" })).toBe(".pdf");
    expect(inferAttachmentExtension({ mimeType: "text/plain" })).toBe(".txt");
  });
});
