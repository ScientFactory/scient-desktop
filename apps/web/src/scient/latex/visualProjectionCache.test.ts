import { describe, expect, it } from "vite-plus/test";
import { projectLatexVisualDocument } from "./latexVisualDocument";
import { createVisualProjectionCache } from "./visualProjectionCache";

describe("projection reuse", () => {
  it("requires both exact source and exact document setup", () => {
    const cache = createVisualProjectionCache(),
      source = "Text $x$.";
    const projection = projectLatexVisualDocument(source);
    cache.put(source, "first setup", projection);
    expect(cache.get(source, "first setup")).toBe(projection);
    expect(cache.get("Outside edit", "first setup")).toBeNull();
    expect(cache.get(source, "changed macros")).toBeNull();
    cache.put("Outside edit", "first setup", projection);
    expect(cache.get("Outside edit", "first setup")).toBeNull();
  });

  it("evicts the least recently opened document and rejects oversized entries", () => {
    const cache = createVisualProjectionCache(2);
    for (const source of ["First", "Second"])
      cache.put(source, source, projectLatexVisualDocument(source));
    expect(cache.get("First", "First")).not.toBeNull();
    cache.put("Third", "Third", projectLatexVisualDocument("Third"));
    expect(cache.get("Second", "Second")).toBeNull();
    expect(cache.get("First", "First")).not.toBeNull();
    const tiny = createVisualProjectionCache(4, 1);
    tiny.put("Text", "Text", projectLatexVisualDocument("Text"));
    expect(tiny.get("Text", "Text")).toBeNull();
  });
});
