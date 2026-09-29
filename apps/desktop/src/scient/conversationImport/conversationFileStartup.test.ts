import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({ review: vi.fn() }));
vi.mock("./reviewOpenedConversation.ts", () => ({ reviewOpenedConversation: mocks.review }));
vi.mock("electron", async () => {
  const NodeEvents = await import("node:events");
  return {
    app: Object.assign(new NodeEvents.EventEmitter(), { whenReady: async () => {} }),
    dialog: { showErrorBox: vi.fn() },
  };
});

beforeEach(async () => {
  const { app } = await import("electron");
  app.removeAllListeners();
  vi.resetModules();
  mocks.review.mockReset();
  mocks.review.mockResolvedValue(null);
});

describe("file-only startup boundary", () => {
  it("normal startup proceeds without a file-review window", async () => {
    const module = await import("./openedConversationFiles.ts");
    module.captureConversationFileOpens();
    expect(await module.prepareConversationFileOpening()).toBe(true);
    expect(mocks.review).not.toHaveBeenCalled();
  });
  it("cold cancellation refuses workspace startup and stages nothing", async () => {
    const { app } = await import("electron");
    const module = await import("./openedConversationFiles.ts");
    module.captureConversationFileOpens();
    app.emit("open-file", { preventDefault() {} }, "/tmp/example.scic");
    mocks.review.mockResolvedValue(null);
    expect(await module.prepareConversationFileOpening()).toBe(false);
    expect(module.takeOpenedConversationFileList()).toEqual([]);
    expect(mocks.review).toHaveBeenCalledWith("/tmp/example.scic", false);
  });
  it("holds startup until explicit acceptance", async () => {
    const { app } = await import("electron");
    const module = await import("./openedConversationFiles.ts");
    module.captureConversationFileOpens();
    app.emit("open-file", { preventDefault() {} }, "/tmp/example.scic");
    let accept!: (value: unknown) => void;
    mocks.review.mockReturnValue(
      new Promise((resolve) => {
        accept = resolve;
      }),
    );
    let started = false;
    const startup = module.prepareConversationFileOpening().then((value) => {
      started = value;
      return value;
    });
    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());
    expect(started).toBe(false);
    expect(module.takeOpenedConversationFileList()).toEqual([]);
    accept({ dev: "1", ino: "2", size: "3", mtimeNs: "4" });
    expect(await startup).toBe(true);
  });
  it("captures an early second-instance request and preserves read-only mode", async () => {
    const { app } = await import("electron");
    const module = await import("./openedConversationFiles.ts");
    module.captureConversationFileOpens();
    app.emit(
      "second-instance",
      {},
      ["scient", "--preview-conversation", "file:///tmp/hello%20world.scic"],
      "/tmp",
    );
    mocks.review.mockResolvedValue(null);
    expect(await module.prepareConversationFileOpening()).toBe(false);
    expect(mocks.review).toHaveBeenCalledWith("/tmp/hello world.scic", true);
  });
  it("warm opens still pass through local review", async () => {
    const { app } = await import("electron");
    const module = await import("./openedConversationFiles.ts");
    module.captureConversationFileOpens();
    expect(await module.prepareConversationFileOpening()).toBe(true);
    mocks.review.mockResolvedValue(null);
    app.emit("open-file", { preventDefault() {} }, "/tmp/later.scic");
    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledWith("/tmp/later.scic", false));
    expect(module.takeOpenedConversationFileList()).toEqual([]);
  });
});
