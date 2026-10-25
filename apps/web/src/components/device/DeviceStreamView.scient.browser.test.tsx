import { useEffect, useSyncExternalStore } from "react";
import { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render, stubGlobal } from "../../../test/render";

const accessStore = {
  value: { httpBase: "http://test", wsBase: "ws://test", query: {}, credentials: true },
  listeners: new Set<() => void>(),
  refresh() {
    accessStore.value = { ...accessStore.value };
    for (const listener of accessStore.listeners) listener();
  },
  subscribe(listener: () => void) {
    accessStore.listeners.add(listener);
    return () => accessStore.listeners.delete(listener);
  },
};
vi.mock(import("~/state/device"), async (original) => ({
  ...(await original()),
  useDeviceHubAccess: () => useSyncExternalStore(accessStore.subscribe, () => accessStore.value),
  refreshDeviceHubAccess: () => accessStore.refresh(),
}));
let viewerMounts = 0;
let viewerUnmounts = 0;
// The 3D phone frame needs WebGL; the test only cares whether it stays mounted.
vi.mock(import("./DevicePhoneViewport"), async (original) => ({
  ...(await original()),
  DevicePhoneViewport: function Viewer(): React.ReactElement {
    useEffect(() => {
      viewerMounts++;
      return () => {
        viewerUnmounts++;
      };
    }, []);
    return <></>;
  },
}));

import { DeviceStreamView } from "./DeviceStreamView";

const srcDescriptor = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src")!;
const removeAttribute = Element.prototype.removeAttribute;
function stubImages(_fixture: _Fixture) {
  // Only the remote MJPEG transport is intercepted. Published frames use native PNG decoding.
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get(this: HTMLImageElement) {
      return _fixture.imageSources.get(this) ?? srcDescriptor.get!.call(this);
    },
    set(this: HTMLImageElement, value: string) {
      if (!value.startsWith(accessStore.value.httpBase)) {
        srcDescriptor.set!.call(this, value);
        return;
      }
      if (!_fixture.images.includes(this)) _fixture.images.push(this);
      _fixture.imageSources.set(this, value);
    },
  });
  Element.prototype.removeAttribute = function (this: Element, name: string) {
    if (this instanceof HTMLImageElement && name === "src") _fixture.imageSources.delete(this);
    return removeAttribute.call(this, name);
  };
}
function restoreImages() {
  Object.defineProperty(HTMLImageElement.prototype, "src", srcDescriptor);
  Element.prototype.removeAttribute = removeAttribute;
}
async function publishFrame(_fixture: _Fixture, image: HTMLImageElement) {
  await act(async () => {
    srcDescriptor.set!.call(image, _fixture.frameUrl);
    await image.decode();
  });
  expect(image.naturalWidth).toBe(400);
  expect(image.naturalHeight).toBe(800);
}

async function setup(_fixture: _Fixture, h264 = false, platform: "ios" | "android" = "ios") {
  viewerMounts = 0;
  viewerUnmounts = 0;
  _fixture.images = [];
  await using stack = new AsyncDisposableStack();
  stubImages(_fixture);
  stack.defer(restoreImages);
  stack.use(fakeTimers());
  const touches: unknown[] = [];
  let videoBody: ReadableStreamDefaultController<Uint8Array> | undefined;
  let output: VideoFrameOutputCallback | undefined;
  if (h264) {
    stack.use(
      stubGlobal(
        "VideoDecoder",
        class {
          static isConfigSupported = async () => ({ supported: true });
          state = "unconfigured";
          constructor(callbacks: VideoDecoderInit) {
            output = callbacks.output;
          }
          configure() {
            this.state = "configured";
          }
          close() {
            this.state = "closed";
          }
        },
      ),
    );
    stack.use(stubGlobal("EncodedVideoChunk", vi.fn()));
  } else {
    // Without WebCodecs the iOS client streams MJPEG.
    const videoDecoder = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
    if (videoDecoder) {
      Reflect.deleteProperty(globalThis, "VideoDecoder");
      stack.defer(() => {
        Object.defineProperty(globalThis, "VideoDecoder", videoDecoder);
      });
    }
  }
  stack.use(
    stubGlobal("fetch", (url: string, init: RequestInit) => {
      if (url.endsWith("stream.avcc")) {
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                videoBody = controller;
                init.signal?.addEventListener("abort", () =>
                  controller.error(new Error("aborted")),
                );
              },
            }),
          ),
        );
      }
      return Promise.resolve(new Response("prime"));
    }),
  );
  const sockets: Array<{ onmessage?: (event: { data: ArrayBuffer }) => void }> = [];
  const sent: unknown[] = [];
  stack.use(
    stubGlobal(
      "WebSocket",
      class {
        static OPEN = 1;
        readyState = 1;
        constructor() {
          sockets.push(this);
        }
        onmessage?: (event: { data: ArrayBuffer }) => void;
        send(message: string | Uint8Array) {
          if (typeof message === "string") {
            sent.push(message);
          } else if (message[0] === 0x03) {
            touches.push(JSON.parse(new TextDecoder().decode(message.subarray(1))));
          }
        }
        close() {}
      },
    ),
  );
  const view = (visible: boolean) => (
    <DeviceStreamView
      hostId="local"
      environmentId={EnvironmentId.make("test")}
      deviceId="test"
      platform={platform}
      visible={visible}
      allowPhoneView={h264}
    />
  );
  _fixture.container = document.createElement("div");
  _fixture.container.style.cssText = "width: 400px; height: 800px; display: flex";
  const screen = stack.use(await render(view(true), { container: _fixture.container }));
  const environment = stack.move();
  return {
    images: _fixture.images,
    show: (visible: boolean) => screen.rerender(view(visible)),
    [Symbol.asyncDispose]: () => environment.disposeAsync(),
    sent,
    touches,
    configure() {
      const json = new TextEncoder().encode(
        JSON.stringify({ width: 400, height: 800, orientation: "portrait" }),
      );
      const packet = new Uint8Array(1 + json.length);
      packet[0] = 0x82;
      packet.set(json, 1);
      sockets[0]?.onmessage?.({ data: Uint8Array.of(0x83).buffer });
      sockets[0]?.onmessage?.({ data: packet.buffer });
      videoBody?.enqueue(new Uint8Array([0, 0, 0, 5, 1, 1, 0x64, 0, 0x1f]));
    },
    frame() {
      const source = new OffscreenCanvas(400, 800);
      source.getContext("2d")!.fillRect(0, 0, 400, 800);
      output?.(new VideoFrame(source, { timestamp: 0 }));
    },
  };
}

const alert = (_fixture: _Fixture) => _fixture.container.querySelector('[role="alert"]');
const reconnect = (_fixture: _Fixture) =>
  act(async () =>
    [..._fixture.container.querySelectorAll("button")]
      .find((button) => button.textContent?.includes("Reconnect"))!
      .click(),
  );

// Restored from the upstream-deleted DeviceStreamView.browser.test.tsx.
// regression: dca7b59bea feat(devices): add simulator and emulator support (#10677)
it("removes MJPEG requests while hidden and reconnects when shown", async () => {
  await using _fixture = _createFixture();

  await using stream = await setup(_fixture);
  const { images, show } = stream;
  expect(images[0]!.src).toContain("stream.mjpeg");
  await show(false);
  expect(_fixture.container.querySelectorAll("img")).toHaveLength(0);
  expect(images[0]!.src).toBe("");
  expect(vi.getTimerCount()).toBe(0);
  await show(true);
  expect(images.at(-1)!.src).toContain("stream.mjpeg");
});

// regression: 9f73ca3677 fix(devices): recover simulator streams after failures (#12639)
it("offers Reconnect after the shared timeout and receives a frame after retry with unchanged access", async () => {
  await using _fixture = _createFixture();

  await using stream = await setup(_fixture);
  const { images } = stream;
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(alert(_fixture)?.textContent).toContain("No video");
  expect(images[0]!.src).toBe("");
  await reconnect(_fixture);
  expect(alert(_fixture)).toBeNull();
  expect(images[1]!.src).toContain("stream.mjpeg");
  await publishFrame(_fixture, images[1]!);
  expect(_fixture.container.querySelector('[role="status"]')).toBeNull();
  expect(_fixture.container.querySelectorAll("button")).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
});

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const frame = document.createElement("canvas");
  frame.width = 400;
  frame.height = 800;
  frame.getContext("2d")!.fillRect(0, 0, 400, 800);
  return {
    frameUrl: frame.toDataURL("image/png"),
    imageSources: new WeakMap<HTMLImageElement, string>(),
    images: [] as HTMLImageElement[],
    container: undefined! as HTMLDivElement,
    stack,
    async [Symbol.asyncDispose]() {
      await stack.disposeAsync();
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;
