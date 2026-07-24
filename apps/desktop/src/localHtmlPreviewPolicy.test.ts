import { describe, expect, it } from "vitest";

import {
  isLocalOrPrivateNetworkUrl,
  localHtmlPreviewNavigationDisposition,
  localHtmlPreviewRequestAllowed,
} from "./localHtmlPreviewPolicy";

const ORIGIN = "http://g-123.preview.localhost:5000";

describe("localHtmlPreviewPolicy", () => {
  it("allows the exact preview origin and public web dependencies", () => {
    for (const url of [
      `${ORIGIN}/app.js`,
      "https://cdn.example/app.js",
      "wss://events.example/socket",
      "data:text/plain,ok",
      "blob:http://g-123.preview.localhost:5000/id",
    ]) {
      expect(localHtmlPreviewRequestAllowed({ url, allowedOrigin: ORIGIN })).toBe(true);
    }
  });

  it("denies local services, private networks, privileged schemes, and malformed URLs", () => {
    for (const url of [
      "http://localhost:3000/private",
      "http://other.preview.localhost:5000/private",
      "http://127.0.0.1:3000/private",
      "http://10.0.0.2/private",
      "http://172.16.0.2/private",
      "http://192.168.1.2/private",
      "http://169.254.169.254/latest/meta-data",
      "http://[::1]/private",
      "file:///Users/example/.ssh/id_rsa",
      "scient://settings",
      "not a url",
    ]) {
      expect(localHtmlPreviewRequestAllowed({ url, allowedOrigin: ORIGIN })).toBe(false);
    }
  });

  it("keeps preview navigation local and moves public destinations to a normal web tab", () => {
    expect(
      localHtmlPreviewNavigationDisposition({
        url: `${ORIGIN}/linked.html`,
        allowedOrigin: ORIGIN,
        isMainFrame: true,
      }),
    ).toBe("allow");
    expect(
      localHtmlPreviewNavigationDisposition({
        url: "https://example.com/",
        allowedOrigin: ORIGIN,
        isMainFrame: true,
      }),
    ).toBe("open-web");
    expect(
      localHtmlPreviewNavigationDisposition({
        url: "http://127.0.0.1:3000/",
        allowedOrigin: ORIGIN,
        isMainFrame: true,
      }),
    ).toBe("deny");
    expect(
      localHtmlPreviewNavigationDisposition({
        url: "https://frames.example/",
        allowedOrigin: ORIGIN,
        isMainFrame: false,
      }),
    ).toBe("allow");
  });

  it("recognizes representative private-network address forms", () => {
    expect(isLocalOrPrivateNetworkUrl("http://127.1/")).toBe(true);
    expect(isLocalOrPrivateNetworkUrl("http://[fd00::1]/")).toBe(true);
    expect(isLocalOrPrivateNetworkUrl("https://example.com/")).toBe(false);
  });
});
