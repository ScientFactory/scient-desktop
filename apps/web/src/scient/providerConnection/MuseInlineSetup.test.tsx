import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ProviderLifecycleController } from "./useProviderLifecycleController";

const auth = vi.hoisted(() => ({ state: null as ProviderAuthState | null }));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: auth.state, error: null }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/server", () => ({
  serverEnvironment: new Proxy({}, { get: () => () => ({}) }),
}));
vi.mock("./useProviderEnableAction", () => ({
  useProviderEnableAction: () => ({ access: "granted" }),
}));

const { MuseInlineSetup } = await import("./MuseInlineSetup");

const instanceId = ProviderInstanceId.make("muse");
const provider: ServerProvider = {
  instanceId,
  driver: ProviderDriverKind.make("muse"),
  enabled: true,
  installed: true,
  version: "1.4.7-R6101.1",
  status: "ready",
  auth: { status: "unknown", canLogout: true },
  checkedAt: "2026-10-13T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};
const idle: ProviderAuthState = {
  instanceId,
  flowId: null,
  phase: "idle",
  authorizationUrl: null,
  expiresAt: null,
  credentialOwner: "provider",
  accountVerified: false,
  methods: [
    { id: "muse_device", name: "Meta account", description: null, type: "agent" },
    { id: "muse_key", name: "Meta API key", description: null, type: "credentials" },
  ],
  interaction: null,
  message: null,
};

function render(state: ProviderAuthState) {
  auth.state = state;
  const controller = { openAuthorizationPage: vi.fn(async () => undefined) };
  return renderToStaticMarkup(
    <MuseInlineSetup
      controller={controller as unknown as ProviderLifecycleController}
      displayName="Muse Code"
      environmentId={EnvironmentId.make("environment")}
      provider={provider}
    />,
  );
}

describe("Muse composer account setup", () => {
  beforeEach(() => {
    auth.state = null;
  });

  it("offers the assisted sign-in actions without explanatory copy", () => {
    const markup = render(idle);
    expect(markup).toContain("Sign in to Muse");
    expect(markup).toContain("Sign in with Meta");
    expect(markup).toContain("Use API key");
    expect(markup).not.toContain("Provider default");
    expect(markup).not.toContain("shared account");
  });

  it("shows the device code with reopen and cancel while the flow waits", () => {
    const markup = render({
      ...idle,
      flowId: "flow",
      phase: "waiting",
      interaction: {
        type: "deviceCode",
        id: "interaction",
        url: "https://auth.meta.com/oauth/device/",
        userCode: "ABCD-EFGH",
      },
    });
    expect(markup).toContain("ABCD-EFGH");
    expect(markup).toContain("Reopen sign-in page");
    expect(markup).toContain("Cancel");
    expect(markup).not.toContain("Sign in with Meta");
  });

  it("asks for the API key in a secret field", () => {
    const markup = render({
      ...idle,
      flowId: "flow",
      phase: "waiting",
      interaction: {
        type: "credentials",
        id: "interaction",
        fields: [{ name: "apiKey", label: "Meta API key", secret: true }],
      },
    });
    expect(markup).toContain('type="password"');
    expect(markup).toContain("Meta API key");
  });

  it("reports a completed native write as saved, never as verified", () => {
    const markup = render({ ...idle, flowId: "flow", phase: "idle" });
    expect(markup).toContain("Sign-in saved");
    expect(markup).toContain(">Sign out<");
    expect(markup).not.toContain("Signed in");
  });
});
