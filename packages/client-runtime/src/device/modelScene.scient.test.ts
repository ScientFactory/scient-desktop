// @effect-diagnostics nodeBuiltinImport:off - reads the bundled device models from disk.
// @effect-diagnostics globalFetch:off - stands in for the renderer's fetch that loadDeviceModel uses.
import * as NodeFSP from "node:fs/promises";
import { Mesh, Texture } from "three";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { createImportedPhoneScene, loadDeviceModel } from "./modelScene.ts";
import type { DeviceModelSource } from "./model.ts";
import { phoneDisplayLayout } from "./phoneScene.ts";

const modelsDirectory = new URL(
  "../../../../apps/web/src/components/device/models/",
  import.meta.url,
);

// The loader runs in the renderer; Node lacks the image APIs it decodes textures with.
function stubBrowserImages(files: Map<string, Uint8Array<ArrayBuffer>>) {
  const nodeFetch = globalThis.fetch;
  vi.stubGlobal("self", globalThis);
  vi.stubGlobal("location", { href: "http://localhost/" });
  vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const bytes = files.get(url);
    if (bytes) return Promise.resolve(new Response(bytes));
    return nodeFetch(input, init);
  });
  vi.stubGlobal("createImageBitmap", () => Promise.resolve({ width: 1, height: 1, close() {} }));
  vi.stubGlobal(
    "Image",
    class {
      height = 1;
      onload: (() => void) | null = null;
      set src(_value: string) {
        queueMicrotask(() => this.onload?.());
      }
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it.each(["iphone-18-pro", "iphone-18-pro-max", "ipad-pro-13-m5"] as const)(
  "decodes the bundled %s model and keeps its display normalized for the viewer",
  async (id) => {
    const url = `http://localhost/${id}.glb`;
    const bytes = new Uint8Array(await NodeFSP.readFile(new URL(`${id}.glb`, modelsDirectory)));
    stubBrowserImages(new Map([[url, bytes]]));
    const source: DeviceModelSource = { id, url };

    const model = await loadDeviceModel(source, new AbortController().signal);

    const screens: Mesh[] = [];
    model.asset.traverse((object) => {
      if (object instanceof Mesh && object.name === "device-screen") screens.push(object);
    });
    expect(screens).toHaveLength(1);
    const scene = createImportedPhoneScene(
      model.asset,
      new Texture(),
      phoneDisplayLayout(null, 1206, 2622),
    );
    expect(scene.height).toBeGreaterThan(2.2);
    scene.dispose();
    model.dispose();
  },
);
