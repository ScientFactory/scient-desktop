import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { resolveMediaActionUrl, type MediaActionLocation } from "./mediaActionUrl";

describe("media action access", () => {
  it("obtains fresh exact-resource access without replacing the displayed URL", async () => {
    const source: MediaActionLocation = {
      src: "https://environment.test/api/assets/expired-token",
      asset: {
        environmentId: EnvironmentId.make("environment-1"),
        resource: { _tag: "workspace-file", cwd: "/workspace", relativePath: "figure.png" },
      },
    };
    const resolve = vi
      .fn()
      .mockResolvedValueOnce({
        httpBaseUrl: "https://environment.test",
        relativeUrl: "/api/assets/fresh-1",
      })
      .mockResolvedValueOnce({
        httpBaseUrl: "https://environment.test",
        relativeUrl: "/api/assets/fresh-2",
      });
    expect(await resolveMediaActionUrl(source, resolve)).toBe(
      "https://environment.test/api/assets/fresh-1",
    );
    expect(await resolveMediaActionUrl(source, resolve)).toBe(
      "https://environment.test/api/assets/fresh-2",
    );
    expect(resolve).toHaveBeenNthCalledWith(1, source.asset);
    expect(resolve).toHaveBeenNthCalledWith(2, source.asset);
    expect(source.src).toBe("https://environment.test/api/assets/expired-token");
  });

  it("does not request workspace capabilities for external or data images", async () => {
    const resolve = vi.fn();
    for (const src of ["https://images.test/figure.svg", "data:image/png;base64,AQID"]) {
      expect(await resolveMediaActionUrl({ src }, resolve)).toBe(src);
    }
    expect(resolve).not.toHaveBeenCalled();
    await expect(resolveMediaActionUrl({ src: null }, resolve)).rejects.toThrow("unavailable");
  });

  it("propagates access failure instead of falling back to an expired URL", async () => {
    const source: MediaActionLocation = {
      src: "https://environment.test/api/assets/expired-token",
      asset: {
        environmentId: EnvironmentId.make("environment-1"),
        resource: { _tag: "workspace-file", cwd: "/workspace", relativePath: "figure.png" },
      },
    };
    await expect(
      resolveMediaActionUrl(source, async () => {
        throw new Error("Reconnect first");
      }),
    ).rejects.toThrow("Reconnect first");
  });
});
