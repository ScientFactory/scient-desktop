import { describe, expect, it, vi } from "vite-plus/test";

import { tiffFixture } from "../../../../test/tiffFixture";
import { readTiffPlane } from "./tiffPreview";
import { openTiffSource } from "./tiffSource";

function serve(bytes: ArrayBuffer, mode: "ranges" | "whole" | "stale") {
  const served = { bytes: 0 };
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (mode === "stale") return new Response(null, { status: 409 });
    const range = /^bytes=(\d+)-(\d+)$/u.exec(new Headers(init?.headers).get("range") ?? "");
    if (mode === "whole" || !range) {
      served.bytes += bytes.byteLength;
      return new Response(bytes.slice(0), { status: 200 });
    }
    const start = Number(range[1]);
    if (start >= bytes.byteLength) return new Response(null, { status: 416 });
    const end = Math.min(Number(range[2]), bytes.byteLength - 1);
    served.bytes += end - start + 1;
    return new Response(bytes.slice(start, end + 1), {
      status: 206,
      headers: { "content-range": `bytes ${start}-${end}/${bytes.byteLength}` },
    });
  };
  return { fetch, served };
}

const stack = () =>
  tiffFixture(
    Array.from({ length: 8 }, (_, page) => ({
      width: 512,
      height: 512,
      bits: 16 as const,
      data: Array.from({ length: 512 * 512 }, (_, index) => page * 1_000 + (index % 7)),
    })),
  );

describe("openTiffSource", () => {
  it("reads only the directories and rows of the requested page", async () => {
    const bytes = await stack();
    const server = serve(bytes, "ranges");
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(server.fetch);
    const readWhole = vi.fn<(src: string, signal: AbortSignal) => Promise<ArrayBuffer>>();
    const tiff = await openTiffSource("https://environment.test/stack.tif", readWhole);
    const result = await readTiffPlane(tiff, { plane: 6 });
    expect(result.info).toMatchObject({ plane: 6, planes: 8, range: [6_000, 6_006] });
    expect(readWhole).not.toHaveBeenCalled();
    expect(server.served.bytes).toBeLessThan(bytes.byteLength / 3);
  });

  it("falls back to reading the whole file when the server ignores ranges", async () => {
    const bytes = await stack();
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(serve(bytes, "whole").fetch);
    const readWhole = vi.fn(async () => bytes.slice(0));
    const tiff = await openTiffSource("https://environment.test/stack.tif", readWhole);
    expect((await readTiffPlane(tiff, { plane: 1 })).info.range).toEqual([1_000, 1_006]);
    expect(readWhole).toHaveBeenCalledOnce();
  });

  it("keeps the size limit message when the fallback read is too large", async () => {
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(serve(new ArrayBuffer(8), "whole").fetch);
    const readWhole = vi.fn(async () => {
      throw new Error("Preview limited to files under 50 MB.");
    });
    const opening = openTiffSource("https://environment.test/big.tif", readWhole);
    await expect(opening).rejects.toThrow("Preview limited to files under 50 MB.");
    await expect(opening).rejects.toMatchObject({ kind: "format" });
  });

  it("reports an expired file URL as a load failure so the viewer can renew it", async () => {
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(serve(new ArrayBuffer(8), "stale").fetch);
    const opening = openTiffSource("https://environment.test/old.tif", vi.fn());
    await expect(opening).rejects.toMatchObject({ name: "TiffPreviewError", kind: "load" });
  });
});
