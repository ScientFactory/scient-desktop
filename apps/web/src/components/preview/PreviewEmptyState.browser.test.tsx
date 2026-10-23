import { act, render as renderUi, type Screen } from "../../../test/render";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

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

function setup() {
  vi.clearAllMocks();
  mocks.servers = [];
}

async function renderPreview(
  recentEntries: Array<{ url: string; lastVisitedAt: number; title?: string }>,
) {
  return renderUi(
    <PreviewEmptyState
      threadRef={threadRef}
      environmentId={environmentId}
      threadId="thread-current"
      environmentHttpBaseUrl="http://localhost:3773"
      recentEntries={recentEntries}
      onRemoveRecent={onRemoveRecent}
      onOpenUrl={onOpenUrl}
    />,
  );
}

function button(screen: Screen, name: string) {
  const match = [...screen.container.querySelectorAll("button")].find(
    (element) => element.getAttribute("aria-label") === name || element.textContent?.includes(name),
  );
  expect(match, `button ${name}`).toBeDefined();
  return match!;
}

describe("PreviewEmptyState", () => {
  it("lists a recent entry and a live server matching its host:port, and opens or forgets entries", async () => {
    setup();
    mocks.servers = [server(5173)];
    await using screen = await renderPreview([
      {
        url: "https://myapp.test/admin#users",
        lastVisitedAt: Date.UTC(2026, 9, 20),
        title: "Admin",
      },
      {
        url: "http://localhost:5173/",
        lastVisitedAt: Date.UTC(2026, 9, 20),
        title: "Recent Local",
      },
    ]);
    const text = screen.container.textContent;
    expect(text).toContain("Recently used");
    // SCIENT-FORK:START — a server no thread owns stays under the collapsed secondary action.
    expect(text).not.toContain("Local previews");
    expect(text).toContain("Recent Local");
    expect(text).not.toContain("node");
    // SCIENT-FORK:END

    await act(async () => button(screen, "Admin").click());
    expect(onOpenUrl).toHaveBeenCalledExactlyOnceWith("https://myapp.test/admin#users");

    await act(async () => button(screen, "Remove myapp.test/admin#users from history").click());
    expect(onRemoveRecent).toHaveBeenCalledExactlyOnceWith("https://myapp.test/admin#users");
  });

  it("shows only the recents group when no servers are found", async () => {
    setup();
    await using screen = await renderPreview([{ url: "https://myapp.test/", lastVisitedAt: 0 }]);
    expect(screen.container.textContent).toContain("Recently used");
    expect(screen.container.textContent).not.toContain("Local previews");
  });
});

// SCIENT-FORK:START
vi.mock(import("./PreviewFaviconIcon"), () => ({
  PreviewFaviconIcon: () => <span data-favicon-icon />,
}));
{
  async function renderMarkup(node: import("react").ReactNode) {
    await using screen = await renderUi(node);
    return screen.container.innerHTML;
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

  async function render(
    recentEntries: Array<{ url: string; lastVisitedAt: number; title?: string }>,
  ) {
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
    it("offers other browser-ready servers through a collapsed secondary action", async () => {
      mocks.servers = [server(8080)];
      const html = await render([]);
      expect(html).toContain("Find another local server");
      expect(html).toContain(">1<");
      expect(html).not.toContain("localhost:8080");
      expect(html).not.toContain("node");
    });

    it("shows a server owned by the current thread as a project preview", async () => {
      mocks.servers = [
        {
          ...server(5173),
          terminal: { threadId: ThreadId.make("thread-current"), terminalId: "terminal-1" },
        },
      ];
      const html = await render([]);
      expect(html).toContain("Local previews");
      expect(html).toContain("node");
      expect(html).toContain("data-favicon-icon");
      expect(html).not.toContain("Find another local server");
    });

    it("renders an out-of-range lastVisitedAt entry without throwing", async () => {
      mocks.servers = [];
      let html = "";
      html = await render([{ url: "https://myapp.test/", lastVisitedAt: 1e20 }]);
      expect(html).toContain("myapp.test");
      expect(html).toContain("Remove");
    });
  });
}
// SCIENT-FORK:END
