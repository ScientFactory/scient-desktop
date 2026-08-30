import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  readSettings: vi.fn(),
  updateSettings: vi.fn(),
  query: vi.fn(),
  known: true,
}));
vi.mock("~/state/environments", () => ({
  usePrimaryEnvironmentId: () => "local-server",
  useEnvironment: (id: string) => (mocks.known ? { environmentId: id, label: id } : null),
}));
vi.mock("~/hooks/useSettings", () => ({
  useEnvironmentSettings: (id: string) => {
    mocks.readSettings(id);
    return { schemaVersion: 1, languages: {} };
  },
  useUpdateEnvironmentSettings: (id: string) => {
    mocks.updateSettings(id);
    return vi.fn();
  },
}));
vi.mock("~/state/compute", () => ({
  computeEnvironment: {
    runtimes: (target: unknown) => {
      mocks.query(target);
      return {};
    },
    refreshRuntimes: {},
  },
}));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: { languages: [] },
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("~/components/settings/settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SettingsSection: ({
    children,
    headerAction,
  }: {
    children: ReactNode;
    headerAction?: ReactNode;
  }) => (
    <section>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: () => null,
}));

import { ScientificComputingSettings } from "./ScientificComputingSettings";

describe("Scientific Computing environment ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.known = true;
  });

  it("reads, edits, and inspects the requested remote server, not the primary", () => {
    const markup = renderToStaticMarkup(
      <ScientificComputingSettings environmentId={EnvironmentId.make("remote-server")} />,
    );
    expect(markup).toContain("remote-server");
    expect(mocks.readSettings).toHaveBeenCalledWith("remote-server");
    expect(mocks.updateSettings).toHaveBeenCalledWith("remote-server");
    expect(mocks.query).toHaveBeenCalledWith({
      environmentId: "remote-server",
      input: { cwd: null, refresh: false },
    });
    expect(mocks.readSettings).not.toHaveBeenCalledWith("local-server");
  });

  it("uses the primary environment only when none was requested", () => {
    renderToStaticMarkup(<ScientificComputingSettings />);
    expect(mocks.readSettings).toHaveBeenCalledWith("local-server");
  });

  it("does not fall back to local settings when the requested server is missing", () => {
    mocks.known = false;
    const markup = renderToStaticMarkup(
      <ScientificComputingSettings environmentId={EnvironmentId.make("removed-server")} />,
    );
    expect(markup).toContain("This server is unavailable");
    expect(mocks.readSettings).not.toHaveBeenCalled();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
