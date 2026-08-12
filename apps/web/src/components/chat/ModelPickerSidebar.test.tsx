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
  auth: { status: "unauthenticated", required: true },
  checkedAt: "2026-08-09T08:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  connection: {
    methods: ["codex_browser"],
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
  it("keeps a not-ready provider selectable when an inline setup surface exists", () => {
    const markup = render(true);

    expect(markup).toContain('aria-label="Claude — Limited."');
    expect(markup).not.toContain("disabled");
  });

  it("keeps unsupported not-ready providers disabled", () => {
    const markup = render(false);

    expect(markup).toContain("disabled");
    expect(markup).toContain("Claude — Limited.");
  });
});
