// @effect-diagnostics nodeBuiltinImport:off -- temporary regular-file fixtures for OS-opened-file identity checks.
import * as NodeEvents from "node:events";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ read: vi.fn(), load: vi.fn(), windows: [] as unknown[] }));
vi.mock("./localConversationPreview.ts", async (original) => ({
  ...(await original<typeof import("./localConversationPreview.ts")>()),
  readLocalConversationPreview: mocks.read,
}));
vi.mock("electron", async () => {
  const { EventEmitter: Emitter } = await import("node:events");
  class Window extends Emitter {
    destroyed = false;
    readonly webContents = Object.assign(new Emitter(), {
      mainFrame: {},
      setWindowOpenHandler: vi.fn(),
      session: {
        setPermissionCheckHandler: vi.fn(),
        setPermissionRequestHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
      },
    });
    readonly urls: string[] = [];
    readonly options: unknown;
    constructor(options: unknown) {
      super();
      this.options = options;
      mocks.windows.push(this);
    }
    setMenu() {}
    readonly setResizable = vi.fn();
    readonly setContentSize = vi.fn();
    isDestroyed() {
      return this.destroyed;
    }
    async loadURL(url: string) {
      this.urls.push(decodeURIComponent(url));
      await mocks.load();
    }
    show() {}
    close() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.emit("closed");
    }
    destroy() {
      this.close();
    }
  }
  return { BrowserWindow: Window, ipcMain: new Emitter() };
});
import { ipcMain } from "electron";
import { reviewOpenedConversation } from "./reviewOpenedConversation.ts";
import { LocalConversationPreviewError } from "./localConversationPreview.ts";

interface FakeWindow extends NodeEvents.EventEmitter {
  webContents: NodeEvents.EventEmitter & { mainFrame: object };
  options: {
    webPreferences: {
      sandbox: boolean;
      nodeIntegration: boolean;
      contextIsolation: boolean;
      partition: string;
    };
  };
  urls: string[];
  close(): void;
}
let directory: string;
let file: string;
let identity: { dev: string; ino: string; size: string; mtimeNs: string };
const window = () => mocks.windows[0] as FakeWindow;
const action = (
  value: string,
  sender: object = window().webContents,
  senderFrame: object = window().webContents.mainFrame,
) => {
  ipcMain.emit("scient:conversation-review-action", { sender, senderFrame }, value);
};
beforeEach(async () => {
  mocks.windows.length = 0;
  mocks.read.mockReset();
  mocks.load.mockReset();
  mocks.load.mockResolvedValue(undefined);
  directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "scient-local-review-"));
  file = NodePath.join(directory, "test.scic");
  await NodeFSP.writeFile(file, "fixture");
  const stat = await NodeFSP.lstat(file, { bigint: true });
  identity = {
    dev: stat.dev.toString(),
    ino: stat.ino.toString(),
    size: stat.size.toString(),
    mtimeNs: stat.mtimeNs.toString(),
  };
  mocks.read.mockResolvedValue({
    title: "Example",
    messages: [],
    messageCount: 2,
    attachmentCount: 0,
    truncated: false,
    identity,
  });
});
afterEach(async () => {
  vi.useRealTimers();
  for (const item of mocks.windows) (item as FakeWindow).close();
  await NodeFSP.rm(directory, { recursive: true, force: true });
});

describe("focused local conversation window", () => {
  it("settles cold startup when page loading hangs", async () => {
    vi.useFakeTimers();
    mocks.load.mockReturnValue(new Promise(() => {}));
    const result = reviewOpenedConversation(file);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await result).toBeNull();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(ipcMain.listenerCount("scient:conversation-review-action")).toBe(0);
  });
  it("settles on an unresponsive preview renderer", async () => {
    const result = reviewOpenedConversation(file);
    window().emit("unresponsive");
    expect(await result).toBeNull();
  });
  it("permits full import validation when only the local preview size is exceeded", async () => {
    mocks.read.mockRejectedValue(
      new LocalConversationPreviewError("unsupported-too-large", "Large snapshot", identity),
    );
    const result = reviewOpenedConversation(file);
    await vi.waitFor(() => expect(window().urls.at(-1)).toContain('id="continue"'));
    action("continue");
    expect(await result).toEqual(identity);
  });
  it("opens compact and grows only while the person reads the conversation", async () => {
    const result = reviewOpenedConversation(file);
    await vi.waitFor(() => expect(window().urls.at(-1)).toContain('id="continue"'));
    expect(window().options).toMatchObject({
      width: 440,
      height: 196,
      useContentSize: true,
      resizable: false,
    });
    const resized = window() as unknown as {
      setResizable: ReturnType<typeof vi.fn>;
      setContentSize: ReturnType<typeof vi.fn>;
    };
    action("expand", new NodeEvents.EventEmitter());
    expect(resized.setContentSize).not.toHaveBeenCalled();
    action("expand");
    expect(resized.setResizable).toHaveBeenLastCalledWith(true);
    expect(resized.setContentSize).toHaveBeenLastCalledWith(640, 600, true);
    action("collapse");
    expect(resized.setResizable).toHaveBeenLastCalledWith(false);
    expect(resized.setContentSize).toHaveBeenLastCalledWith(440, 196, true);
    action("cancel");
    expect(await result).toBeNull();
  });
  it("a read-only preview ignores resize requests", async () => {
    const result = reviewOpenedConversation(file, true);
    await vi.waitFor(() => expect(window().urls.at(-1)).toContain("Example"));
    action("expand");
    expect(
      (window() as unknown as { setContentSize: ReturnType<typeof vi.fn> }).setContentSize,
    ).not.toHaveBeenCalled();
    action("cancel");
    expect(await result).toBeNull();
  });
  it("read-only mode cannot initiate an import, even through its action channel", async () => {
    const result = reviewOpenedConversation(file, true);
    await vi.waitFor(() => expect(window().urls.at(-1)).toContain("Example"));
    expect(window().urls.at(-1)).not.toContain('id="continue"');
    action("continue");
    action("cancel");
    expect(await result).toBeNull();
  });
  it("admits only an explicit action from its own main frame", async () => {
    const result = reviewOpenedConversation(file);
    await vi.waitFor(() => expect(window().urls.at(-1)).toContain('id="continue"'));
    expect(window().options.webPreferences).toMatchObject({
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
    });
    expect(window().options.webPreferences.partition).not.toContain("persist:");
    action("continue", new NodeEvents.EventEmitter());
    action("continue", window().webContents, {});
    expect(ipcMain.listenerCount("scient:conversation-review-action")).toBe(1);
    action("continue");
    expect(await result).toEqual(identity);
    expect(ipcMain.listenerCount("scient:conversation-review-action")).toBe(0);
  });
  it("cancels pending reads when the window closes", async () => {
    mocks.read.mockImplementation(
      (_path, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        }),
    );
    const result = reviewOpenedConversation(file);
    await vi.waitFor(() => expect(mocks.read).toHaveBeenCalledOnce());
    action("cancel");
    expect(await result).toBeNull();
    expect(mocks.read.mock.calls[0]![1].aborted).toBe(true);
  });
  it("refuses a changed file after preview", async () => {
    const result = reviewOpenedConversation(file);
    await vi.waitFor(() => expect(window().urls.at(-1)).toContain('id="continue"'));
    await NodeFSP.writeFile(file, "different file contents");
    action("continue");
    await vi.waitFor(() => expect(window().urls.at(-1)).toContain("file changed"));
    expect(window().urls.at(-1)).not.toContain('id="continue"');
    action("cancel");
    expect(await result).toBeNull();
  });
  it("errors never expose an import action or raw parser error", async () => {
    mocks.read.mockRejectedValue(new Error("secret /private/path"));
    const result = reviewOpenedConversation(file);
    await vi.waitFor(() => expect(window().urls.at(-1)).toContain("could not safely preview"));
    expect(window().urls.at(-1)).not.toContain("/private/path");
    expect(window().urls.at(-1)).not.toContain('id="continue"');
    action("cancel");
    expect(await result).toBeNull();
  });
});
