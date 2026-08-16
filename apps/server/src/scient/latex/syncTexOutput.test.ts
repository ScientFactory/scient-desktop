import { describe, expect, it } from "vite-plus/test";

import {
  parseSyncTexForwardLocation,
  parseSyncTexInverseLocation,
  parseSyncTexRecords,
} from "./syncTexOutput.ts";

describe("SyncTeX command output", () => {
  it("parses multiple result blocks and preserves colons in values", () => {
    expect(
      parseSyncTexRecords(`SyncTeX result begin
Input:C:\\papers\\draft:one.tex
Line:42
SyncTeX result end
SyncTeX result begin
Page:2
h:18.5
v:72
SyncTeX result end`),
    ).toEqual([
      { Input: "C:\\papers\\draft:one.tex", Line: "42" },
      { Page: "2", h: "18.5", v: "72" },
    ]);
  });

  it("reads forward positions in SyncTeX big points", () => {
    expect(
      parseSyncTexForwardLocation(`SyncTeX result begin
Page:3
h:24.25
v:101.5
W:12
H:9.75
SyncTeX result end`),
    ).toEqual({ page: 3, x: 24.25, y: 101.5, width: 12, height: 9.75 });
  });

  it("accepts the older x/y position fields and rejects invalid records", () => {
    expect(
      parseSyncTexForwardLocation(`SyncTeX result begin
Page:nope
x:12
y:24
SyncTeX result end
SyncTeX result begin
Page:1
x:12
y:24
SyncTeX result end`),
    ).toEqual({ page: 1, x: 12, y: 24, width: 0, height: 0 });
    expect(parseSyncTexForwardLocation("SyncTeX result begin\nPage:0\nh:1\nv:1\n")).toBeNull();
  });

  it("reads inverse source positions and normalizes an absent column", () => {
    expect(
      parseSyncTexInverseLocation(`SyncTeX result begin
Input:chapters/results.tex
Line:108.9
Column:-1
SyncTeX result end`),
    ).toEqual({ input: "chapters/results.tex", line: 108, column: null });
    expect(
      parseSyncTexInverseLocation("SyncTeX result begin\nInput:main.tex\nLine:0\n"),
    ).toBeNull();
  });
});
