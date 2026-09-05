import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./ProviderRuntimeSection", () => ({
  ProviderRuntimeSection: () => <div>Runtime controls</div>,
}));

import { PiInlineSetup } from "./PiInlineSetup";

const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("pi"),
  driver: ProviderDriverKind.make("pi"),
  enabled: true,
  installed: true,
  version: "0.84.4",
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-09-05T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

function render(value: ServerProvider, managedRuntimePresentedExternally = false) {
  return renderToStaticMarkup(
    <PiInlineSetup
      environmentId={EnvironmentId.make("local")}
      provider={value}
      displayName="Pi"
      managedRuntimePresentedExternally={managedRuntimePresentedExternally}
    />,
  );
}

describe("PiInlineSetup", () => {
  it("shows only runtime controls before installation", () => {
    const markup = render({ ...provider, installed: false, status: "error" });
    expect(markup).toContain("Runtime controls");
    expect(markup).not.toContain("Connect a model provider");
    expect(markup).not.toContain("/login");
  });

  it("gives one actionable instruction when installed without models", () => {
    const markup = render(provider);
    expect(markup).toContain("Connect a model provider");
    expect(markup).toContain("Run /login in Pi on the server");
    expect(markup).not.toContain("no single Pi account");
    expect(markup).not.toContain("sandbox");
  });

  it("does not repeat a ready model inventory", () => {
    const markup = render(
      {
        ...provider,
        status: "ready",
        models: [{ slug: "qa/text", name: "Test model", isCustom: false, capabilities: null }],
      },
      true,
    );
    expect(markup).toBe("");
  });

  it("preserves model discovery failures instead of suggesting login", () => {
    const markup = render({ ...provider, status: "error", message: "Pi RPC timed out." });
    expect(markup).toContain("Could not load Pi models");
    expect(markup).toContain("Pi RPC timed out.");
    expect(markup).not.toContain("/login");
  });

  it("waits for a fresh probe before suggesting setup", () => {
    expect(render({ ...provider, probePending: true }, true)).toBe("");
  });

  it.each(["missing", "scient_managed"] as const)(
    "leaves %s runtime recovery to the runtime controls",
    (source) => {
      const markup = render({
        ...provider,
        status: "error",
        connection: {
          methods: [],
          canDisconnect: false,
          operation: null,
          runtime: {
            source,
            supportTier: "fully_assisted",
            target: "darwin-arm64",
            actions: source === "missing" ? ["install"] : ["repair"],
            managedVersion: null,
            previousManagedVersion: null,
            operation: null,
            message: "Runtime needs attention.",
          },
        },
      });
      expect(markup).toContain("Runtime controls");
      expect(markup).not.toContain("/login");
      expect(markup).not.toContain("Could not load Pi models");
    },
  );
});
