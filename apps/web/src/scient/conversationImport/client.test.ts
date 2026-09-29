import { SCIC_MEDIA_TYPE } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../lib/runtime", () => ({ runtime: { runPromise: vi.fn() } }));
vi.mock("../../state/session", () => ({ readPreparedConnection: () => null }));

const { uploadConversationFile } = await import("./client");
const { ConversationImportNotice } = await import("./importDialog.logic");

class FakeUpload extends EventTarget {}

class FakeXhr extends EventTarget {
  static last: FakeXhr | null = null;
  readonly upload = new FakeUpload();
  readonly headers = new Map<string, string>();
  status = 0;
  sent: unknown = null;
  aborted = false;
  constructor() {
    super();
    FakeXhr.last = this;
  }
  open(method: string, url: string) {
    this.headers.set(":request", `${method} ${url}`);
  }
  setRequestHeader(name: string, value: string) {
    this.headers.set(name, value);
  }
  send(body: unknown) {
    this.sent = body;
  }
  abort() {
    this.aborted = true;
    this.dispatchEvent(new Event("abort"));
  }
  progress(loaded: number, total: number) {
    this.upload.dispatchEvent(
      Object.assign(new Event("progress"), { lengthComputable: true, loaded, total }),
    );
  }
  finish(status: number) {
    this.status = status;
    this.dispatchEvent(new Event("load"));
  }
}

beforeEach(() => {
  FakeXhr.last = null;
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});

afterEach(() => vi.unstubAllGlobals());

const url = "http://127.0.0.1/api/scient/conversation-import/v1/upload/token";

describe("uploadConversationFile", () => {
  it("posts the file, reports progress, and resolves when the server accepts it", async () => {
    const file = new File(["archive"], "notes.scic");
    const onProgress = vi.fn();
    const done = uploadConversationFile(url, file, {
      signal: new AbortController().signal,
      onProgress,
    });
    const request = FakeXhr.last!;
    expect(request.headers.get(":request")).toBe(`POST ${url}`);
    expect(request.headers.get("content-type")).toBe(SCIC_MEDIA_TYPE);
    expect(request.sent).toBe(file);
    request.progress(3, 7);
    expect(onProgress).toHaveBeenCalledWith(3, 7);
    request.finish(204);
    await expect(done).resolves.toBeUndefined();
  });

  it("stops the transfer when cancelled", async () => {
    const controller = new AbortController();
    const done = uploadConversationFile(url, new File(["# Notes"], "notes.md"), {
      signal: controller.signal,
      onProgress: () => {},
    });
    expect(FakeXhr.last!.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    controller.abort();
    expect(FakeXhr.last!.aborted).toBe(true);
    await expect(done).rejects.toMatchObject({ name: "AbortError" });
  });

  it("words a refused upload plainly, without the status code", async () => {
    const done = uploadConversationFile(url, new File(["archive"], "notes.scic"), {
      signal: new AbortController().signal,
      onProgress: () => {},
    });
    FakeXhr.last!.finish(409);
    const error = await done.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ConversationImportNotice);
    expect((error as Error).message).not.toContain("409");
  });
});
