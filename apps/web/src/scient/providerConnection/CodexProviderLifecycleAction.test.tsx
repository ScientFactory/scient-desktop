import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./useProviderLifecycleController", () => ({
  useProviderLifecycleController: () => ({}),
}));

import { CodexProviderLifecycleAction } from "./CodexProviderLifecycleAction";

const provider = (source: "scient_managed" | "system" | "missing"): ServerProvider => ({
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  enabled: true,
  installed: source !== "missing",
  version: source === "missing" ? null : "0.147.0",
  status: "ready",
  auth: { status: "authenticated", required: true, label: "ChatGPT" },
  checkedAt: "2026-08-23T08:00:00.000Z",
  models: [{ slug: "gpt-5", name: "GPT-5", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["codex_browser"],
    canDisconnect: true,
    operation: null,
    runtime: {
      source,
      supportTier: "fully_assisted",
      target: "darwin-arm64",
      actions: source === "scient_managed" ? ["repair", "remove"] : ["install"],
      managedVersion: source === "scient_managed" ? "0.147.0" : null,
      previousManagedVersion: null,
      operation: null,
      message: source === "missing" ? "Install available." : "Codex is ready.",
    },
  },
});

function render(source: "scient_managed" | "system" | "missing"): string {
  return renderToStaticMarkup(
    <CodexProviderLifecycleAction
      displayName="Codex"
      environmentId={EnvironmentId.make("local")}
      onManage={vi.fn()}
      provider={provider(source)}
    />,
  );
}

describe("CodexProviderLifecycleAction", () => {
  it("opens management when a healthy system runtime is available", () => {
    const markup = render("system");

    expect(markup).toContain(">Manage<");
    expect(markup).not.toContain(">Install<");
  });

  it("offers installation when no runtime remains", () => {
    expect(render("missing")).toContain(">Install<");
  });

  it("keeps Manage for an installed Scient-managed runtime", () => {
    expect(render("scient_managed")).toContain(">Manage<");
  });
});
