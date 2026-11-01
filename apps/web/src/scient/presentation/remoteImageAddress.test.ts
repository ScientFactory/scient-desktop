import { describe, expect, it } from "vite-plus/test";

import { hasRemoteSrcSet, remoteImageAddress, srcSetCandidateUrls } from "./remoteImageAddress";

const DESKTOP = { baseUrl: "scient://app/index.html", appUrl: "scient://app/index.html" };
const WEB = {
  baseUrl: "https://scient.example/threads/1",
  appUrl: "https://scient.example/threads/1",
};

describe("remoteImageAddress", () => {
  it("classifies web sources as remote and everything Scient serves as local", () => {
    expect(remoteImageAddress("https://a.example/x/y.png?q=1", DESKTOP)).toEqual({
      url: "https://a.example/x/y.png?q=1",
      host: "a.example",
      label: "a.example/x/y.png",
    });
    expect(remoteImageAddress("http://127.0.0.1:4000/p.png", DESKTOP)?.host).toBe("127.0.0.1:4000");
    expect(remoteImageAddress("https://xn--e1afmkfd.example/p", DESKTOP)?.host).toBe(
      "xn--e1afmkfd.example",
    );
    for (const local of [
      "data:image/png;base64,AA==",
      "blob:https://a/1",
      "/logo.png",
      "logo.png",
      "https://scient.example/logo.png",
      "//scient.example/logo.png",
    ]) {
      expect(remoteImageAddress(local, WEB)).toBeNull();
    }
    // The desktop's private scheme is answered by its protocol handler, whatever the host.
    expect(remoteImageAddress("//cdn.example/logo.png", DESKTOP)).toBeNull();
    expect(remoteImageAddress("//cdn.example/logo.png", WEB)?.url).toBe(
      "https://cdn.example/logo.png",
    );
  });

  it.each([
    // remoteImageAddress resolves through the WHATWG URL parser, so one network-path form and one
    // scheme-normalization form stand for the rest (double or mixed slashes, newlines, case).
    ["a backslash network path", "/\\attacker.example/collect?secret=v"],
    ["a tab inside the scheme", "ht\ttps://attacker.example/collect"],
  ])("resolves %s the way the browser does", (_name, source) => {
    expect(remoteImageAddress(source, WEB)?.host).toBe("attacker.example");
  });

  it("treats addresses the parser rejects, and non-web schemes, as remote", () => {
    expect(remoteImageAddress("https://[bad", WEB)).toEqual({
      url: "https://[bad",
      host: "https://[bad",
      label: "https://[bad",
    });
    expect(remoteImageAddress("logo.png", { baseUrl: null, appUrl: null })).not.toBeNull();
    expect(remoteImageAddress("file://server/share/p.png", DESKTOP)).not.toBeNull();
  });
});

describe("srcset classification", () => {
  it("splits candidates by the HTML srcset rules", () => {
    expect(srcSetCandidateUrls("a.png 1x, b.png 2x")).toEqual(["a.png", "b.png"]);
    // A comma inside a URL belongs to it; trailing commas end a URL without descriptors.
    expect(srcSetCandidateUrls("a.png,b.png")).toEqual(["a.png,b.png"]);
    expect(srcSetCandidateUrls("a.png,, b.png")).toEqual(["a.png", "b.png"]);
    expect(srcSetCandidateUrls("data:image/png;base64,AA== 1x,\n//x.example/c 2x")).toEqual([
      "data:image/png;base64,AA==",
      "//x.example/c",
    ]);
    // A comma inside parenthesised descriptors does not start a new candidate.
    expect(srcSetCandidateUrls("a.png 100w (x, y), b.png")).toEqual(["a.png", "b.png"]);
    expect(srcSetCandidateUrls(" , ")).toEqual([]);
  });

  it("flags a source when any candidate reaches another server", () => {
    expect(hasRemoteSrcSet("/a.png 1x, data:image/png;base64,AA== 2x", WEB)).toBe(false);
    expect(hasRemoteSrcSet("/a.png 1x, /\\attacker.example/c 2x", WEB)).toBe(true);
    // In srcset a tab is a separator: the browser requests the same-origin "ht", not the host.
    expect(srcSetCandidateUrls("ht\ttps://attacker.example/c")).toEqual(["ht"]);
    expect(hasRemoteSrcSet("ht\ttps://attacker.example/c", WEB)).toBe(false);
    expect(hasRemoteSrcSet("data:image/png;base64,AA== 1x,\n\\\\attacker.example/c", WEB)).toBe(
      true,
    );
    expect(hasRemoteSrcSet("/a.png 100w (x, https://attacker.example/c), b.png", WEB)).toBe(false);
    expect(hasRemoteSrcSet("/a.png 100w, HTTPS://attacker.example/c 200w", WEB)).toBe(true);
    expect(hasRemoteSrcSet(undefined, WEB)).toBe(false);
  });
});
