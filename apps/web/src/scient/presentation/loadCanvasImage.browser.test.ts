import { stubGlobal as _fixtureStubGlobal } from "../../../test/render";
import { describe, expect, it, vi } from "vite-plus/test";
import { loadCanvasImage } from "./loadCanvasImage";

async function _cleanupFixture0(_fixture: _Fixture) {
  await vi.unstubAllGlobals();
}

function imageDecoder(_fixture: _Fixture, fails = false) {
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
  _fixture.stack.use(_fixtureStubGlobal("Image", TestImage));
  return sources;
}

describe("canvas image decoding", () => {
  it.each(["image/svg+xml", "image/svg+xml;charset=utf-8"])(
    "uses a lossless self-contained URL for %s",
    async (type) => {
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const sources = imageDecoder(_fixture);
      const createObjectURL = vi.fn();
      _fixture.stack.use(_fixtureStubGlobal("URL", { createObjectURL }));
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
      await using _fixture = _createFixture();
      _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

      const sources = imageDecoder(_fixture, fails);
      const createObjectURL = vi.fn(() => "blob:raster");
      const revokeObjectURL = vi.fn();
      _fixture.stack.use(_fixtureStubGlobal("URL", { createObjectURL, revokeObjectURL }));
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
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    imageDecoder(_fixture, true);
    await expect(loadCanvasImage(new Blob(["invalid"], { type: "image/svg+xml" }))).rejects.toThrow(
      /decode/,
    );
  });

  it.each(["error", "abort"])("settles failed SVG reads (%s)", async (event) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture0(_fixture));

    const sources = imageDecoder(_fixture);
    _fixture.stack.use(
      _fixtureStubGlobal(
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
      ),
    );
    await expect(loadCanvasImage(new Blob(["svg"], { type: "image/svg+xml" }))).rejects.toThrow(
      /read|cancelled/,
    );
    expect(sources).toEqual([]);
  });
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
