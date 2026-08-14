import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  servers: [] as Array<{
    host: string;
    port: number;
    url: string;
    requestedUrl: string;
    processName: string | null;
    pid: number | null;
    terminal: null | { threadId: string; terminalId: string };
    source: "scanner";
  }>,
}));

vi.mock("./useDiscoveredLocalServers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./useDiscoveredLocalServers")>();
  return {
    ...actual,
    useDiscoveredLocalServers: () => mocks.servers,
  };
});
vi.mock("./PreviewFaviconIcon", () => ({
  PreviewFaviconIcon: () => <span data-favicon-icon />,
}));

import { PreviewEmptyState } from "./PreviewEmptyState";

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
  return renderToStaticMarkup(
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
        terminal: { threadId: "thread-current", terminalId: "terminal-1" },
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
    expect(html).not.toContain("Local servers");
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
