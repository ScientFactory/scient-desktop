// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { loadCanvasImage } from "./loadCanvasImage";

afterEach(() => vi.unstubAllGlobals());

function imageDecoder(fails = false) {
  const sources: string[] = [];
  class TestImage {
    listeners = new Map<string, () => void>();
    addEventListener(type: string, callback: () => void) {
      this.listeners.set(type, callback);
    }
    set src(value: string) {
      sources.push(value);
      this.listeners.get(fails ? "error" : "load")?.();
    }
  }
  vi.stubGlobal("Image", TestImage);
  return sources;
}

describe("canvas image decoding", () => {
  it.each(["image/svg+xml", "image/svg+xml;charset=utf-8"])(
    "uses a lossless self-contained URL for %s",
    async (type) => {
      const sources = imageDecoder();
      const createObjectURL = vi.fn();
      vi.stubGlobal("URL", { createObjectURL });
      const text = '<svg xmlns="http://www.w3.org/2000/svg"><text>שלום β 😀 # &amp;</text></svg>';
      await loadCanvasImage(new Blob([text], { type }));
      expect(createObjectURL).not.toHaveBeenCalled();
      expect(sources[0]).toMatch(/^data:image\/svg\+xml[;,]/);
      const encoded = sources[0]!.split(",")[1]!;
      expect(new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)))).toBe(
        text,
      );
    },
  );

  it.each([false, true])(
    "releases raster object URLs after decode (failure: %s)",
    async (fails) => {
      const sources = imageDecoder(fails);
      const createObjectURL = vi.fn(() => "blob:raster");
      const revokeObjectURL = vi.fn();
      vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
      const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
      const result = loadCanvasImage(blob);
      if (fails) await expect(result).rejects.toThrow(/decode/);
      else await result;
      expect(createObjectURL).toHaveBeenCalledWith(blob);
      expect(sources).toEqual(["blob:raster"]);
      expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:raster");
    },
  );

  it("propagates SVG image decode failures", async () => {
    imageDecoder(true);
    await expect(loadCanvasImage(new Blob(["invalid"], { type: "image/svg+xml" }))).rejects.toThrow(
      /decode/,
    );
  });

  it.each(["error", "abort"])("settles failed SVG reads (%s)", async (event) => {
    const sources = imageDecoder();
    vi.stubGlobal(
      "FileReader",
      class {
        listeners = new Map<string, () => void>();
        addEventListener(type: string, callback: () => void) {
          this.listeners.set(type, callback);
        }
        readAsDataURL() {
          this.listeners.get(event)?.();
        }
      },
    );
    await expect(loadCanvasImage(new Blob(["svg"], { type: "image/svg+xml" }))).rejects.toThrow(
      /read|cancelled/,
    );
    expect(sources).toEqual([]);
  });
});
