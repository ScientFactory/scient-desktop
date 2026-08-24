import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { ModelPickerSidebar } from "./ModelPickerSidebar";

const INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

const snapshot: ServerProvider = {
  instanceId: INSTANCE_ID,
  driver: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  version: "2.1.170",
  status: "warning",
  message: "Claude CLI command `/private/runtime/claude` was not found.",
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-09T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["claude_console"],
    canDisconnect: false,
    operation: null,
  },
};

const entry: ProviderInstanceEntry = {
  instanceId: INSTANCE_ID,
  driverKind: ProviderDriverKind.make("claudeAgent"),
  displayName: "Claude",
  enabled: true,
  installed: true,
  status: "warning",
  isDefault: true,
  isAvailable: true,
  snapshot,
  models: [],
};

function render(setupAvailable: boolean): string {
  return renderToStaticMarkup(
    <ModelPickerSidebar
      instanceEntries={[entry]}
      selectedInstanceId="favorites"
      setupAvailableInstanceIds={setupAvailable ? new Set([INSTANCE_ID]) : new Set()}
      showFavorites={false}
      onSelectInstance={() => undefined}
    />,
  );
}

describe("ModelPickerSidebar provider setup", () => {
  it("renders the favorites entry without provider-scoped tooltip state", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerSidebar
        instanceEntries={[entry]}
        selectedInstanceId="favorites"
        showFavorites
        onSelectInstance={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Favorites"');
  });

  it("keeps a not-ready provider selectable when an inline setup surface exists", () => {
    const markup = render(true);

    expect(markup).toContain('aria-label="Claude needs setup. Select it to install or reconnect."');
    expect(markup).not.toContain("/private/runtime/claude");
    expect(markup).not.toContain("disabled");
  });

  it("keeps unsupported not-ready providers disabled", () => {
    const markup = render(false);

    expect(markup).toContain("disabled");
    expect(markup).toContain(
      "Claude is unavailable. Open Settings → Providers to install or reconnect it.",
    );
    expect(markup).not.toContain("/private/runtime/claude");
  });
});

describe("ModelPickerSidebar provider lock", () => {
  it("exposes the provider-specific fork guidance to assistive technology", () => {
    const readyEntry: ProviderInstanceEntry = {
      ...entry,
      status: "ready",
      snapshot: {
        ...snapshot,
        status: "ready",
        auth: { status: "authenticated", required: true },
      },
    };
    const markup = renderToStaticMarkup(
      <ModelPickerSidebar
        instanceEntries={[readyEntry]}
        selectedInstanceId="favorites"
        disabledInstanceIds={new Set([INSTANCE_ID])}
        getDisabledInstanceTooltip={() =>
          "Claude is unavailable in this conversation. Fork to continue with Claude."
        }
        showFavorites={false}
        onSelectInstance={() => undefined}
      />,
    );

    expect(markup).toContain(
      'aria-label="Claude is unavailable in this conversation. Fork to continue with Claude."',
    );
  });

  it("prioritizes unavailable-runtime guidance over conversation locking", () => {
    const markup = renderToStaticMarkup(
      <ModelPickerSidebar
        instanceEntries={[entry]}
        selectedInstanceId="favorites"
        disabledInstanceIds={new Set([INSTANCE_ID])}
        getDisabledInstanceTooltip={() =>
          "Claude is unavailable in this conversation. Fork to continue with Claude."
        }
        showFavorites={false}
        onSelectInstance={() => undefined}
      />,
    );

    expect(markup).toContain(
      'aria-label="Claude is unavailable. Open Settings → Providers to install or reconnect it."',
    );
    expect(markup).not.toContain("Fork to continue");
    expect(markup).not.toContain("/private/runtime/claude");
  });
});
