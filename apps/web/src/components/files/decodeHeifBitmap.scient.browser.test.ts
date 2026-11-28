import { expect, it } from "vite-plus/test";
import { decodeHeifBitmap } from "./decodeImagePreview";
import workerUrl from "./imageDecode.worker.ts?worker&url";
import photoUrl from "../../../test/fixtures/images/photo.heic?url";

function makeSyntheticHeifHeader(width: number, height: number): ArrayBuffer {
  const ispe = new Uint8Array(20);
  const ispeView = new DataView(ispe.buffer);
  ispeView.setUint32(0, ispe.byteLength);
  ispeView.setUint32(4, 0x69737065); // 'ispe'
  ispeView.setUint32(12, width);
  ispeView.setUint32(16, height);

  const ipco = new Uint8Array(8 + ispe.byteLength);
  const ipcoView = new DataView(ipco.buffer);
  ipcoView.setUint32(0, ipco.byteLength);
  ipcoView.setUint32(4, 0x6970636f); // 'ipco'
  ipco.set(ispe, 8);

  const iprp = new Uint8Array(8 + ipco.byteLength);
  const iprpView = new DataView(iprp.buffer);
  iprpView.setUint32(0, iprp.byteLength);
  iprpView.setUint32(4, 0x69707270); // 'iprp'
  iprp.set(ipco, 8);

  const meta = new Uint8Array(12 + iprp.byteLength);
  const metaView = new DataView(meta.buffer);
  metaView.setUint32(0, meta.byteLength);
  metaView.setUint32(4, 0x6d657461); // 'meta'
  meta.set(iprp, 12);

  return meta.buffer;
}

it("decodes HEIC to an ImageBitmap under the desktop content security policy", async () => {
  const bytes = await (await fetch(photoUrl)).arrayBuffer();
  const frame = document.createElement("iframe");
  frame.srcdoc = `<!doctype html><meta http-equiv="Content-Security-Policy" content="script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self' blob:"><script>
    onmessage = async ({ data }) => {
      const url = URL.createObjectURL(new Blob(['import ' + JSON.stringify(data.workerUrl)], { type: 'text/javascript' }));
      const worker = new Worker(url, { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.bitmap) {
          parent.postMessage({ width: data.bitmap.width, height: data.bitmap.height }, '*');
          data.bitmap.close();
        } else {
          parent.postMessage(data, '*');
        }
        worker.terminate();
        URL.revokeObjectURL(url);
      };
      worker.onerror = (event) => parent.postMessage({ error: event.message }, '*');
      worker.postMessage({ bytes: data.bytes, heif: true, output: 'bitmap' }, [data.bytes]);
    };
  </script>`;
  const controller = new AbortController();
  try {
    const loaded = new Promise<void>((resolve) =>
      frame.addEventListener("load", () => resolve(), { once: true }),
    );
    document.body.append(frame);
    await loaded;
    const decoded = new Promise<{ width?: number; height?: number; error?: string }>((resolve) => {
      window.addEventListener(
        "message",
        (event) => {
          if (event.source === frame.contentWindow) resolve(event.data);
        },
        { signal: controller.signal },
      );
    });
    frame.contentWindow!.postMessage(
      { bytes, workerUrl: new URL(workerUrl, location.href).href },
      "*",
      [bytes],
    );
    const result = await decoded;
    expect(result.error).toBeUndefined();
    expect([result.width, result.height]).toEqual([128, 128]);
  } finally {
    controller.abort();
    frame.remove();
  }
});

it("decodes HEIC bitmaps via decodeHeifBitmap and rejects malformed input cleanly", async () => {
  const blob = await (await fetch(photoUrl)).blob();
  const bitmap = await decodeHeifBitmap(blob);
  try {
    expect([bitmap.width, bitmap.height]).toEqual([128, 128]);
  } finally {
    bitmap.close();
  }

  await expect(decodeHeifBitmap(new Blob([new Uint8Array([1, 2, 3, 4])]))).rejects.toThrow();
});

it("allows up to 64 MP HEIF headers (including long edges > 16384 px) in bitmap mode while keeping PNG preview limits", async () => {
  const runWorker = (output: "png" | "bitmap", width: number, height: number) =>
    new Promise<{ failure?: { code: string } }>((resolve, reject) => {
      const worker = new Worker(new URL("./imageDecode.worker.ts", import.meta.url), {
        type: "module",
      });
      const bytes = makeSyntheticHeifHeader(width, height);
      worker.addEventListener("message", (event: MessageEvent<{ failure?: { code: string } }>) => {
        worker.terminate();
        resolve(event.data);
      });
      worker.addEventListener("error", (event) => {
        worker.terminate();
        reject(new Error(event.message));
      });
      worker.postMessage({ bytes, heif: true, output }, [bytes]);
    });

  // 8064 x 6048 = 48.77 MP: rejected by the 32 MP PNG preview cap, accepted by the 64 MP bitmap cap
  // (where validation passes and the stub header fails later during HEIC decoding).
  expect((await runWorker("png", 8064, 6048)).failure?.code).toBe("image-too-large");
  expect((await runWorker("bitmap", 8064, 6048)).failure?.code).not.toBe("image-too-large");

  // 18000 x 3000 = 54 MP with a long edge > 16384 px: rejected by PNG preview edge cap, accepted by bitmap mode.
  expect((await runWorker("png", 18_000, 3_000)).failure?.code).toBe("image-too-large");
  expect((await runWorker("bitmap", 18_000, 3_000)).failure?.code).not.toBe("image-too-large");

  // 10000 x 7000 = 70 MP: rejected in both modes.
  expect((await runWorker("bitmap", 10_000, 7_000)).failure?.code).toBe("image-too-large");
});
