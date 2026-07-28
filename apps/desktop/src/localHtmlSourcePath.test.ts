import { describe, expect, it, vi } from "vitest";

import {
  canonicalLocalHtmlSourcePath,
  isCanonicalLocalHtmlPathInside,
  normalizeLocalHtmlSourcePath,
} from "./localHtmlSourcePath";

describe("localHtmlSourcePath", () => {
  it("resolves Windows paths before comparison without lowercasing the requested spelling", () => {
    const realpath = vi.fn((value: string) => {
      if (value === "C:\\CaseSensitive\\Report.HTML") return value;
      if (value === "C:\\CaseSensitive\\report.html") return value;
      throw new Error("missing");
    });

    const upper = canonicalLocalHtmlSourcePath("C:/CaseSensitive/Report.HTML", {
      platform: "win32",
      realpath,
    });
    const lower = canonicalLocalHtmlSourcePath("C:/CaseSensitive/report.html", {
      platform: "win32",
      realpath,
    });

    expect(upper).toBe("C:\\CaseSensitive\\Report.HTML");
    expect(lower).toBe("C:\\CaseSensitive\\report.html");
    expect(upper).not.toBe(lower);
    expect(realpath.mock.calls.map(([value]) => value)).toEqual([
      "C:\\CaseSensitive\\Report.HTML",
      "C:\\CaseSensitive\\report.html",
    ]);
  });

  it("still converges alternate spelling when Windows realpath identifies one file", () => {
    const realpath = vi.fn(() => "C:\\Users\\Yaacov\\Report.HTML");

    expect(
      canonicalLocalHtmlSourcePath("c:/users/yaacov/report.html", {
        platform: "win32",
        realpath,
      }),
    ).toBe("C:\\Users\\Yaacov\\Report.HTML");
  });

  it("preserves an unresolved basename under its exact canonical parent", () => {
    const realpath = vi.fn((value: string) => {
      if (value === "C:\\CaseSensitive") return value;
      throw new Error("missing");
    });

    expect(
      canonicalLocalHtmlSourcePath("C:/CaseSensitive/Future.HTML", {
        platform: "win32",
        realpath,
      }),
    ).toBe("C:\\CaseSensitive\\Future.HTML");
  });

  it("uses exact canonical containment for case-sensitive Windows directories", () => {
    expect(
      isCanonicalLocalHtmlPathInside(
        "C:\\CaseSensitive\\Report.HTML",
        "C:\\CaseSensitive",
        "win32",
      ),
    ).toBe(true);
    expect(
      isCanonicalLocalHtmlPathInside(
        "C:\\casesensitive\\Report.HTML",
        "C:\\CaseSensitive",
        "win32",
      ),
    ).toBe(false);
    expect(normalizeLocalHtmlSourcePath("C:/CaseSensitive/Report.HTML", "win32")).toBe(
      "C:\\CaseSensitive\\Report.HTML",
    );
  });
});
