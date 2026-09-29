// @effect-diagnostics nodeBuiltinImport:off -- tests construct host-native OS file-open arguments before the Effect runtime exists.
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
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
  it("collects Finder events after ready before an empty cold-development handoff", async () => {
    const { app } = await import("electron");
    const module = await import("./openedConversationFiles.ts");
    module.captureConversationFileOpens();
    vi.useFakeTimers();
    try {
      let settled = false;
      const startup = module
        .prepareConversationFileOpening({
          deferStartupUntilReviewed: true,
          collectLaunchEvents: true,
        })
        .then((value) => {
          settled = true;
          return value;
        });
      await vi.advanceTimersByTimeAsync(100);
      expect(settled).toBe(false);
      app.emit("open-file", { preventDefault() {} }, "/tmp/late-launch.scic");
      await vi.advanceTimersByTimeAsync(150);
      expect(await startup).toBe(false);
      expect(mocks.review).toHaveBeenCalledWith("/tmp/late-launch.scic", false);
      expect(module.takeOpenedConversationFileList()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
  it("defers managed startup until all pending previews finish", async () => {
    const { app } = await import("electron");
    const module = await import("./openedConversationFiles.ts");
    module.captureConversationFileOpens();
    app.emit("open-file", { preventDefault() {} }, "/tmp/first.scic");
    app.emit("open-file", { preventDefault() {} }, "/tmp/second.scic");
    const identity = { dev: "1", ino: "2", size: "3", mtimeNs: "4" };
    let cancel!: () => void;
    mocks.review.mockResolvedValueOnce(identity).mockReturnValueOnce(
      new Promise((resolve) => {
        cancel = () => resolve(null);
      }),
    );
    const onAccepted = vi.fn();
    let started = false;
    const startup = module
      .prepareConversationFileOpening({ deferStartupUntilReviewed: true, onAccepted })
      .then((value) => {
        started = value;
        return value;
      });
    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledTimes(2));
    expect(started).toBe(false);
    expect(onAccepted).toHaveBeenCalledWith("/tmp/first.scic", identity, false);
    cancel();
    expect(await startup).toBe(true);
  });
  it("rechecks handed-off file identity without a duplicate review", async () => {
    const directory = await NodeFSP.mkdtemp(
      NodePath.join(NodeOS.tmpdir(), "scient-approved-handoff-"),
    );
    try {
      const path = NodePath.join(directory, "conversation.scic");
      await NodeFSP.writeFile(path, "synthetic fixture");
      const stat = await NodeFSP.lstat(path, { bigint: true });
      const file = {
        path,
        readOnly: false as const,
        identity: {
          dev: String(stat.dev),
          ino: String(stat.ino),
          size: String(stat.size),
          mtimeNs: String(stat.mtimeNs),
        },
      };
      const module = await import("./openedConversationFiles.ts");
      module.captureConversationFileOpens();
      await module.installApprovedConversationFileHandoff([file]);
      expect(await module.prepareConversationFileOpening()).toBe(true);
      expect(mocks.review).not.toHaveBeenCalled();
      await NodeFSP.writeFile(path, "changed fixture contents");
      await expect(module.installApprovedConversationFileHandoff([file])).rejects.toThrow(
        "changed during development startup",
      );
    } finally {
      await NodeFSP.rm(directory, { recursive: true, force: true });
    }
  });
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
    const directory = NodeOS.tmpdir();
    const path = NodePath.join(directory, "hello world.scic");
    app.emit(
      "second-instance",
      {},
      ["scient", "--preview-conversation", NodeURL.pathToFileURL(path).href],
      directory,
    );
    mocks.review.mockResolvedValue(null);
    expect(await module.prepareConversationFileOpening()).toBe(false);
    expect(mocks.review).toHaveBeenCalledWith(path, true);
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
  it("coalesces repeated opens while the same file is being reviewed", async () => {
    const { app } = await import("electron");
    const module = await import("./openedConversationFiles.ts");
    module.captureConversationFileOpens();
    app.emit("open-file", { preventDefault() {} }, "/tmp/repeated.scic");
    let cancel!: () => void;
    mocks.review.mockReturnValue(
      new Promise((resolve) => {
        cancel = () => resolve(null);
      }),
    );
    const startup = module.prepareConversationFileOpening();
    await vi.waitFor(() => expect(mocks.review).toHaveBeenCalledOnce());
    app.emit("open-file", { preventDefault() {} }, "/tmp/repeated.scic");
    cancel();
    expect(await startup).toBe(false);
    expect(mocks.review).toHaveBeenCalledOnce();
  });
});
