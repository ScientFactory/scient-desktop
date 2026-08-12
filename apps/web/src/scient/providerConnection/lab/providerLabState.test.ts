import { describe, expect, it } from "vite-plus/test";

import {
  activeClaude,
  activeCodex,
  activeProvider,
  makeProviderLabState,
  nextProviderLabState,
  providersForSnapshot,
  setActiveProviderSnapshot,
  switchActiveProvider,
} from "./providerLabState";

describe("provider full-app lab state", () => {
  it("starts without reading a real provider, account, or model", () => {
    const state = makeProviderLabState();
    const codex = activeCodex(state);
    expect(codex.installed).toBe(false);
    expect(codex.auth.status).toBe("unauthenticated");
    expect(codex.models).toEqual([]);
  });

  it("projects the selected computer into the real runtime contract", () => {
    const [codex] = providersForSnapshot("nothing-installed", "win32-x64");
    expect(codex?.connection?.runtime?.target).toBe("win32-x64");
  });

  it("models Claude without reading an account or replacing the Codex simulation", () => {
    const state = makeProviderLabState("installed-signed-out", "linux-x64", "claudeAgent");
    expect(state.providers).toHaveLength(2);
    expect(activeProvider(state).driver).toBe("claudeAgent");
    expect(activeClaude(state).installed).toBe(true);
    expect(activeClaude(state).connection?.runtime?.target).toBe("linux-x64");
    expect(activeCodex(state).installed).toBe(false);
  });

  it("advances the Claude browser handoff through verification to a ready model", () => {
    const waiting = makeProviderLabState("authorization-code", "darwin-arm64", "claudeAgent");
    const verifying = nextProviderLabState(waiting);
    expect(activeClaude(verifying!).connection?.operation?.status).toBe("verifying");
    const connected = nextProviderLabState(verifying!);
    expect(activeClaude(connected!).auth.status).toBe("authenticated");
    expect(activeClaude(connected!).models[0]?.slug).toBe("claude-sonnet-4-6");
  });

  it("keeps a ready provider available while another provider is configured", () => {
    const codexReady = makeProviderLabState("connected", "darwin-arm64", "codex");
    const claudeSelected = switchActiveProvider(codexReady, "claudeAgent", "Selected Claude.");
    const claudeInstalled = setActiveProviderSnapshot(
      claudeSelected,
      "installed-signed-out",
      "Installed Claude.",
    );

    expect(activeCodex(claudeInstalled).status).toBe("ready");
    expect(activeCodex(claudeInstalled).models[0]?.slug).toBe("gpt-5.4");
    expect(activeClaude(claudeInstalled).installed).toBe(true);
    expect(activeClaude(claudeInstalled).auth.status).toBe("unauthenticated");
  });

  it("advances connection state without contacting a provider", () => {
    const waiting = makeProviderLabState("browser-sign-in");
    const verifying = nextProviderLabState(waiting);
    expect(activeCodex(verifying!).connection?.operation?.status).toBe("verifying");
    const connected = nextProviderLabState(verifying!);
    expect(activeCodex(connected!).auth.status).toBe("authenticated");
    expect(activeCodex(connected!).models[0]?.slug).toBe("gpt-5.4");
  });

  it("models an update without replacing the previous working version early", () => {
    const available = makeProviderLabState("update-available");
    expect(activeCodex(available).versionAdvisory?.latestVersion).toBe("0.148.0");

    const updating = makeProviderLabState("updating");
    expect(activeCodex(updating).version).toBe("0.147.0");
    expect(activeCodex(updating).connection?.runtime?.operation?.action).toBe("update");
    expect(activeCodex(updating).connection?.runtime?.operation?.status).toBe("downloading");

    let updated = updating;
    for (let step = 0; step < 5; step += 1) updated = nextProviderLabState(updated)!;
    expect(activeCodex(updated!).version).toBe("0.148.0");
    expect(activeCodex(updated!).versionAdvisory?.status).toBe("current");
    expect(activeCodex(updated!).connection?.runtime?.previousManagedVersion).toBe("0.147.0");
  });
});
