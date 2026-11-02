import { describe, expect, it } from "vite-plus/test";

import { ompDashboardThroughLink, ompDashboardUrl, ompOpensDashboard } from "./OmpDashboardPage.ts";

describe("ompOpensDashboard", () => {
  it("matches the dashboard commands only", () => {
    expect(ompOpensDashboard("/stats")).toBe(true);
    expect(ompOpensDashboard("  /stats --port 4000")).toBe(true);
    expect(ompOpensDashboard("/trace")).toBe(true);
    expect(ompOpensDashboard("/statsx")).toBe(false);
    expect(ompOpensDashboard("/status")).toBe(false);
    expect(ompOpensDashboard("show me /stats")).toBe(false);
  });
});

describe("ompDashboardUrl", () => {
  it("finds the address the agent reports", () => {
    expect(
      ompDashboardUrl(
        "Dashboard available at: http://127.0.0.1:3847 (sessions sync in the background)\n\n",
      ),
    ).toBe("http://127.0.0.1:3847");
    expect(
      ompDashboardUrl("Dashboard already running at: http://localhost:3847 (requested … ignored)"),
    ).toBe("http://localhost:3847");
    expect(ompDashboardUrl("http://[::1]:3847/#/traces?s=%2Fa%2Fb.jsonl\n\n")).toBe(
      "http://[::1]:3847/#/traces?s=%2Fa%2Fb.jsonl",
    );
  });

  it("ignores progress lines and other sites", () => {
    expect(ompDashboardUrl("Syncing session files...")).toBeUndefined();
    expect(ompDashboardUrl("See https://example.org:443/stats")).toBeUndefined();
    expect(ompDashboardUrl("Stats dashboard failed: port in use")).toBeUndefined();
  });
});

describe("ompDashboardThroughLink", () => {
  const sessions = { root: "/state/scient-agent-sessions", link: "/agent/root/agent/sessions" };
  const file = "/state/scient-agent-sessions/abc/2026-11-01_x.jsonl";

  it("names the conversation through the dashboard's sessions link", () => {
    const text = `http://127.0.0.1:3847/#/traces?s=${encodeURIComponent(file)}\n\n`;
    expect(ompDashboardUrl(ompDashboardThroughLink(text, sessions))).toBe(
      `http://127.0.0.1:3847/#/traces?s=${encodeURIComponent("/agent/root/agent/sessions/abc/2026-11-01_x.jsonl")}`,
    );
  });

  it("leaves the text alone without a link or for other folders", () => {
    const text = `http://127.0.0.1:3847/#/traces?s=${encodeURIComponent(file)}`;
    expect(ompDashboardThroughLink(text, undefined)).toBe(text);
    const other = `http://127.0.0.1:3847/#/traces?s=${encodeURIComponent("/elsewhere/a.jsonl")}`;
    expect(ompDashboardThroughLink(other, sessions)).toBe(other);
  });
});
