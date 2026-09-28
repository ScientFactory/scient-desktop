// @vitest-environment happy-dom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  assetState: "success" as "success" | "failure",
  resources: [] as Array<unknown>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    testState.resources.push(resource);
    return testState.assetState === "failure"
      ? { _tag: "Failure" }
      : { _tag: "Success", url: "https://signed.test/asset.png" };
  },
}));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("~/state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("~/state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("~/remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("~/editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "~/components/ChatMarkdown";

import { remoteImageAddress } from "./remoteImageAddress";

const threadRef = {
  environmentId: EnvironmentId.make("env-remote-images"),
  threadId: ThreadId.make("thread-remote-images"),
};

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.assetState = "success";
  testState.resources = [];
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  cleanups.push(async () => {
    await act(() => root.unmount());
  });
  const render = (text: string, options: { isStreaming?: boolean; githubMedia?: boolean } = {}) =>
    act(() =>
      root.render(
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
  return { host, render };
}

function imageSources(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll("img"), (image) => image.getAttribute("src") ?? "");
}

function remoteRequests(host: HTMLElement): string[] {
  const sources = Array.from(host.querySelectorAll("source"), (source) =>
    source.getAttribute("srcset"),
  );
  return [...imageSources(host), ...sources].filter(
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
    const { host, render } = await mount();
    await render("Result:\n\n![Tumour growth](https://images.example.org/lab/growth.png?run=7)");

    expect(remoteRequests(host)).toEqual([]);
    const card = host.querySelector<HTMLElement>('[role="group"]');
    expect(card?.getAttribute("aria-label")).toBe("Web image: Tumour growth");
    expect(card?.textContent).toContain("Tumour growth");
    expect(card?.textContent).toContain("images.example.org/lab/growth.png");
    expect(card?.getAttribute("data-markdown-copy")).toBe(
      "![Tumour growth](https://images.example.org/lab/growth.png?run=7)",
    );

    await act(() => loadButton(host).click());

    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(imageSources(host)).toEqual(["https://images.example.org/lab/growth.png?run=7"]);
    expect(host.querySelector("img")?.getAttribute("alt")).toBe("Tumour growth");
  });

  it("opens the address in the system browser through the ordinary external-link path", async () => {
    const { host, render } = await mount();
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
    expect(remoteRequests(host)).toEqual([]);
  });

  it("names the card, its link, and its button for keyboard and screen-reader users", async () => {
    const { host, render } = await mount();
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
  });

  it("gates raw HTML images, protocol-relative sources, and picture sources", async () => {
    const { host, render } = await mount();
    await render(
      [
        '<img src="https://cdn.example.net/raw.png" alt="raw">',
        "",
        "![relative](//cdn.example.net/relative.png)",
        "",
        '<picture><source srcset="https://cdn.example.net/wide.webp 2x"><img src="https://cdn.example.net/narrow.png" alt="picture"></picture>',
      ].join("\n"),
    );

    expect(remoteRequests(host)).toEqual([]);
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

  it("gates remote videos written with image syntax", async () => {
    const { host, render } = await mount();
    await render("![Run](https://media.example.org/run.mp4)");

    expect(host.querySelector("video")).toBeNull();
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe("Web video: Run");
    expect(loadButton(host).textContent).toBe("Load video");
  });

  it("leaves workspace images unchanged", async () => {
    const { host, render } = await mount();
    await render("Plot ![plot](results/plot.png) inline");

    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(imageSources(host)).toEqual(["https://signed.test/asset.png"]);
    expect(testState.resources).toContainEqual(expect.objectContaining({ _tag: "workspace-file" }));
  });

  it("gates an image inside a link while the surrounding link keeps working", async () => {
    const { host, render } = await mount();
    await render("[![build](https://ci.example.org/badge.svg)](https://ci.example.org/runs/9)");

    expect(remoteRequests(host)).toEqual([]);
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
    expect(host.querySelector("a img")?.getAttribute("src")).toBe(
      "https://ci.example.org/badge.svg",
    );
  });

  it("keeps GitHub media on the authenticated proxy and never falls back to a direct fetch", async () => {
    const { host, render } = await mount();
    const markdown = "![shot](https://github.com/user-attachments/assets/0123-abcd)";
    await render(markdown, { githubMedia: true });

    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(host.innerHTML).toContain("https://signed.test/asset.png");

    testState.assetState = "failure";
    await render(`${markdown}\n`, { githubMedia: true });

    expect(remoteRequests(host).filter((src) => src.includes("github.com"))).toEqual([]);
    expect(host.querySelector('[role="group"]')?.getAttribute("aria-label")).toBe(
      "Web image: shot",
    );
    await act(() => loadButton(host).click());
    expect(imageSources(host)).toEqual(["https://github.com/user-attachments/assets/0123-abcd"]);
  });

  it("keeps the card, and then the loaded image, stable while a message streams", async () => {
    const { host, render } = await mount();
    const image = "![chart](https://images.example.org/chart.png)";
    await render(`Working on it.\n\n${image}\n\nStill`, { isStreaming: true });
    const card = host.querySelector('[role="group"]');
    expect(card).not.toBeNull();

    await render(`Working on it.\n\n${image}\n\nStill streaming the rest`, { isStreaming: true });
    expect(host.querySelector('[role="group"]')).toBe(card);
    expect(remoteRequests(host)).toEqual([]);

    await act(() => loadButton(host).click());
    const loaded = host.querySelector("img");
    expect(loaded?.getAttribute("src")).toBe("https://images.example.org/chart.png");

    await render(`Working on it.\n\n${image}\n\nStill streaming the rest, and more`, {
      isStreaming: true,
    });
    await render(`Working on it.\n\n${image}\n\nStill streaming the rest, and more.`);
    expect(host.querySelector('[role="group"]')).toBeNull();
    expect(host.querySelector("img")).toBe(loaded);
  });
});

describe("remoteImageAddress", () => {
  it("classifies web sources as remote and everything Scient serves as local", () => {
    expect(remoteImageAddress("https://a.example/x/y.png?q=1", "scient://app")).toEqual({
      url: "https://a.example/x/y.png?q=1",
      host: "a.example",
      label: "a.example/x/y.png",
    });
    expect(remoteImageAddress("HTTP://a.example", "scient://app")?.label).toBe("a.example");
    expect(remoteImageAddress("//a.example/p.png", null)?.url).toBe(
      `${window.location.protocol}//a.example/p.png`,
    );
    expect(remoteImageAddress("http://127.0.0.1:4000/p.png", "scient://app")?.host).toBe(
      "127.0.0.1:4000",
    );
    expect(remoteImageAddress("https://xn--e1afmkfd.example/p", null)?.host).toBe(
      "xn--e1afmkfd.example",
    );
    for (const local of ["data:image/png;base64,AA==", "blob:https://a/1", "results/p.png"]) {
      expect(remoteImageAddress(local, null)).toBeNull();
    }
    expect(remoteImageAddress("http://localhost:5173/p.png", "http://localhost:5173")).toBeNull();
  });

  it("still treats an unparsable web address as remote and shows it verbatim", () => {
    expect(remoteImageAddress("https://[bad", null)).toEqual({
      url: "https://[bad",
      host: "https://[bad",
      label: "https://[bad",
    });
  });
});
