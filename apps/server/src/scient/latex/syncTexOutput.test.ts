import { describe, expect, it } from "vite-plus/test";

import {
  parseSyncTexForwardLocation,
  parseSyncTexForwardLocations,
  parseSyncTexInverseLocation,
  parseSyncTexInverseLocations,
  parseSyncTexRecords,
} from "./syncTexOutput.ts";

describe("SyncTeX command output", () => {
  it("parses multiple result blocks and preserves colons and spaces in values", () => {
    expect(
      parseSyncTexRecords(`SyncTeX result begin
Input: C:\\papers\\draft:one.tex${" "}
Line:42
SyncTeX result end
SyncTeX result begin
Page:2
h:18.5
v:72
SyncTeX result end`),
    ).toEqual([
      { Input: " C:\\papers\\draft:one.tex ", Line: "42" },
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
    ).toEqual({
      page: 3,
      x: 24.25,
      y: 101.5,
      box: { x: 24.25, y: 101.5, width: 12, height: 9.75 },
    });
  });

  it("prefers the target point over an RTL enclosing box", () => {
    expect(
      parseSyncTexForwardLocation(`SyncTeX result begin
Page:1
x:258.885529
y:496.694214
h:-81.624405
v:503.099152
W:621.624390
H:11.541193
SyncTeX result end`),
    ).toEqual({
      page: 1,
      x: 258.885529,
      y: 496.694214,
      box: { x: -81.624405, y: 503.099152, width: 621.62439, height: 11.541193 },
    });
  });

  it("preserves ordered candidates within one result envelope", () => {
    const output = `SyncTeX result begin
Output:main.pdf
Page:1
x:72
y:630.904724
h:-136.161240
v:632.971191
W:676.161255
H:10.302232
Output:main.pdf
Page:1
x:326.182983
y:630.904724
h:-136.161240
v:632.971191
W:676.161255
H:10.302232
SyncTeX result end`;
    expect(parseSyncTexForwardLocations(output).map(({ page, x, y }) => ({ page, x, y }))).toEqual([
      { page: 1, x: 72, y: 630.904724 },
      { page: 1, x: 326.182983, y: 630.904724 },
    ]);
    expect(parseSyncTexForwardLocation(output)).toMatchObject({ page: 1, x: 72, y: 630.904724 });
  });

  it("falls back to the enclosing-box origin and rejects invalid records", () => {
    expect(
      parseSyncTexForwardLocation(`SyncTeX result begin
Page:nope
x:12
y:24
SyncTeX result end
SyncTeX result begin
Page:1
h:12
v:24
SyncTeX result end`),
    ).toEqual({ page: 1, x: 12, y: 24, box: null });
    expect(parseSyncTexForwardLocation("SyncTeX result begin\nPage:0\nh:1\nv:1\n")).toBeNull();
    expect(parseSyncTexForwardLocation("SyncTeX result begin\nPage:1.5\nh:1\nv:1\n")).toBeNull();
  });

  it("reads inverse source positions and normalizes an absent column", () => {
    expect(
      parseSyncTexInverseLocation(`SyncTeX result begin
Input:chapters/results.tex
Line:108
Column:-1
SyncTeX result end`),
    ).toEqual({ input: "chapters/results.tex", line: 108, column: null });
    expect(
      parseSyncTexInverseLocation("SyncTeX result begin\nInput:main.tex\nLine:0\n"),
    ).toBeNull();
    expect(
      parseSyncTexInverseLocation(
        "SyncTeX result begin\nInput:main.tex\nLine:108\nColumn:0\nSyncTeX result end",
      ),
    ).toEqual({ input: "main.tex", line: 108, column: null });
    expect(
      parseSyncTexInverseLocation(
        "SyncTeX result begin\nInput:main.tex\nLine:108.5\nColumn:2\nSyncTeX result end",
      ),
    ).toBeNull();
  });

  it("keeps inverse candidates in helper order instead of overwriting the first match", () => {
    const output = `SyncTeX result begin
Output:main.pdf
Input:hebrew.tex
Line:51
Column:-1
Offset:0
Context:
Output:main.pdf
Input:hebrew.tex
Line:52
Column:-1
Offset:0
Context:
SyncTeX result end`;
    expect(parseSyncTexInverseLocations(output)).toEqual([
      { input: "hebrew.tex", line: 51, column: null },
      { input: "hebrew.tex", line: 52, column: null },
    ]);
    expect(parseSyncTexInverseLocation(output)).toEqual({
      input: "hebrew.tex",
      line: 51,
      column: null,
    });
  });
});
