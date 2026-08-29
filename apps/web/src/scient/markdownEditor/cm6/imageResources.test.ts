import { describe, expect, it, vi } from "vite-plus/test";

import { MarkdownImageResourceScope } from "./imageResources";

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("MarkdownImageResourceScope", () => {
  it("coalesces concurrent requests and reports a resolved resource", async () => {
    const pending = deferred<string | null>();
    const resolver = vi.fn(() => pending.promise);
    const onResourceChange = vi.fn();
    const resources = new MarkdownImageResourceScope(resolver, onResourceChange);

    resources.request("images/chart.png");
    resources.request("images/chart.png");
    expect(resolver).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(resolver).toHaveBeenCalledOnce();

    pending.resolve("scient-asset://chart");
    await vi.waitFor(() => {
      expect(resources.lookup("images/chart.png")).toBe("scient-asset://chart");
    });
    expect(onResourceChange).toHaveBeenCalledOnce();
  });

  it("contains resolver failures and does not retry a settled failure", async () => {
    const resolver = vi.fn(async () => {
      throw new Error("missing image");
    });
    const onResourceChange = vi.fn();
    const resources = new MarkdownImageResourceScope(resolver, onResourceChange);

    resources.request("missing.png");
    await vi.waitFor(() => expect(onResourceChange).toHaveBeenCalledOnce());
    resources.request("missing.png");

    expect(resolver).toHaveBeenCalledOnce();
    expect(resources.lookup("missing.png")).toBeNull();
    expect(onResourceChange).toHaveBeenCalledOnce();
  });

  it("isolates equal authored paths between documents", async () => {
    const first = new MarkdownImageResourceScope(async () => "scient-asset://first", vi.fn());
    const second = new MarkdownImageResourceScope(async () => "scient-asset://second", vi.fn());

    first.request("image.png");
    second.request("image.png");
    await vi.waitFor(() => {
      expect(first.lookup("image.png")).toBe("scient-asset://first");
      expect(second.lookup("image.png")).toBe("scient-asset://second");
    });
  });

  it("suppresses late completions after disposal", async () => {
    const pending = deferred<string | null>();
    const onResourceChange = vi.fn();
    const resources = new MarkdownImageResourceScope(() => pending.promise, onResourceChange);

    resources.request("image.png");
    await Promise.resolve();
    resources.dispose();
    pending.resolve("scient-asset://late");
    await pending.promise;
    await Promise.resolve();

    expect(resources.lookup("image.png")).toBeNull();
    expect(onResourceChange).not.toHaveBeenCalled();
  });
});
