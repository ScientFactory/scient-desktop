import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PreviewableServer } from "./useDiscoveredLocalServers";

const mocks = vi.hoisted(() => ({ servers: [] as PreviewableServer[] }));

vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));

import { PreviewEmptyState } from "./PreviewEmptyState";

const environmentId = EnvironmentId.make("env-1");
const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };
const onOpenUrl = vi.fn();
const onRemoveRecent = vi.fn();

let root: Root;
let container: HTMLDivElement;

function server(port: number): PreviewableServer {
  return {
    host: "localhost",
    port,
    url: `http://localhost:${port}`,
    requestedUrl: `http://localhost:${port}`,
    processName: "node",
    pid: 1,
    terminal: null,
    source: "scanner",
  } as PreviewableServer;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.servers = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render(
  recentEntries: Array<{ url: string; lastVisitedAt: number; title?: string }>,
) {
  await act(async () =>
    root.render(
      <PreviewEmptyState
        threadRef={threadRef}
        environmentId={environmentId}
        // SCIENT-FORK:START
        threadId="thread-current"
        environmentHttpBaseUrl="http://localhost:3773"
        // SCIENT-FORK:END
        recentEntries={recentEntries}
        onRemoveRecent={onRemoveRecent}
        onOpenUrl={onOpenUrl}
      />,
    ),
  );
}

function button(name: string) {
  const match = [...container.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent?.includes(name),
  );
  expect(match, `button ${name}`).toBeDefined();
  return match!;
}

describe("PreviewEmptyState", () => {
  it("lists a recent entry and a live server matching its host:port, and opens or forgets entries", async () => {
    mocks.servers = [server(5173)];
    await render([
      { url: "https://myapp.test/admin#users", lastVisitedAt: Date.now(), title: "Admin" },
      { url: "http://localhost:5173/", lastVisitedAt: Date.now(), title: "Recent Local" },
    ]);
    const text = container.textContent;
    expect(text).toContain("Recently used");
    // SCIENT-FORK:START — a server no thread owns stays under the collapsed secondary action.
    expect(text).not.toContain("Local previews");
    expect(text).toContain("Recent Local");
    expect(text).not.toContain("node");
    // SCIENT-FORK:END

    await act(async () => button("Admin").click());
    expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://myapp.test/admin#users");

    await act(async () => button("Remove myapp.test/admin#users from history").click());
    expect(onRemoveRecent).toHaveBeenCalledExactlyOnceWith("https://myapp.test/admin#users");
  });

  it("shows only the recents group when no servers are found", async () => {
    await render([{ url: "https://myapp.test/", lastVisitedAt: 0 }]);
    expect(container.textContent).toContain("Recently used");
    expect(container.textContent).not.toContain("Local previews");
  });

  it("keeps the original empty state when both groups are empty", async () => {
    await render([]);
    expect(container.textContent).toContain("No preview yet");
  });

  it("shows an entry with an out-of-range lastVisitedAt instead of crashing", async () => {
    await render([{ url: "https://myapp.test/", lastVisitedAt: 1e20 }]);
    expect(container.textContent).toContain("myapp.test");
    button("Remove myapp.test from history");
  });
});

// SCIENT-FORK:START
vi.mock(import("./PreviewFaviconIcon"), () => ({
  PreviewFaviconIcon: () => <span data-favicon-icon />,
}));
{
  function renderMarkup(node: import("react").ReactNode) {
    act(() => root.render(node));
    return container.innerHTML;
  }
  const environmentId = EnvironmentId.make("env-1");
  const threadRef = { environmentId, threadId: ThreadId.make("thread-1") };

  function server(port: number) {
    return {
      host: "localhost",
      port,
      url: `http://localhost:${port}`,
      requestedUrl: `http://localhost:${port}`,
      processName: "node",
      pid: 1,
      terminal: null,
      source: "scanner" as const,
    };
  }

  function render(recentEntries: Array<{ url: string; lastVisitedAt: number; title?: string }>) {
    return renderMarkup(
      <PreviewEmptyState
        threadRef={threadRef}
        environmentId={environmentId}
        threadId="thread-current"
        environmentHttpBaseUrl="http://localhost:3773"
        recentEntries={recentEntries}
        onRemoveRecent={() => undefined}
        onOpenUrl={() => undefined}
      />,
    );
  }

  describe("PreviewEmptyState", () => {
    it("keeps other browser-ready servers collapsed and shows actual history", () => {
      mocks.servers = [server(5173)];
      const html = render([
        { url: "https://myapp.test/admin#users", lastVisitedAt: Date.now(), title: "Admin" },
        { url: "http://localhost:5173/", lastVisitedAt: Date.now(), title: "Recent Local" },
      ]);
      expect(html).toContain("Recently used");
      expect(html).not.toContain("Find another local server");
      expect(html).toContain("myapp.test/admin#users");
      expect(html).toContain("Admin");
      expect(html).toContain("Recent Local");
      expect(html).not.toContain("node");
    });

    it("offers other browser-ready servers through a collapsed secondary action", () => {
      mocks.servers = [server(8080)];
      const html = render([]);
      expect(html).toContain("Find another local server");
      expect(html).toContain(">1<");
      expect(html).not.toContain("localhost:8080");
      expect(html).not.toContain("node");
    });

    it("shows a server owned by the current thread as a project preview", () => {
      mocks.servers = [
        {
          ...server(5173),
          terminal: { threadId: ThreadId.make("thread-current"), terminalId: "terminal-1" },
        },
      ];
      const html = render([]);
      expect(html).toContain("Local previews");
      expect(html).toContain("node");
      expect(html).toContain("data-favicon-icon");
      expect(html).not.toContain("Find another local server");
    });

    it("renders only the recents group when no servers are found", () => {
      mocks.servers = [];
      const html = render([{ url: "https://myapp.test/", lastVisitedAt: 0 }]);
      expect(html).toContain("Recently used");
      expect(html).not.toContain("Local previews");
    });

    it("keeps the original empty state when both groups are empty", () => {
      mocks.servers = [];
      const html = render([]);
      expect(html).toContain("No preview yet");
    });

    it("renders an out-of-range lastVisitedAt entry without throwing", () => {
      mocks.servers = [];
      let html = "";
      expect(() => {
        html = render([{ url: "https://myapp.test/", lastVisitedAt: 1e20 }]);
      }).not.toThrow();
      expect(html).toContain("myapp.test");
      expect(html).toContain("Remove");
    });
  });
}
// SCIENT-FORK:END
