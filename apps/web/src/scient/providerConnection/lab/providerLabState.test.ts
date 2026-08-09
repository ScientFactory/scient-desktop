import { describe, expect, it } from "vite-plus/test";

import {
  activeCodex,
  makeProviderLabState,
  nextProviderLabState,
  providersForSnapshot,
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
    expect(activeCodex(updating).updateState?.status).toBe("running");

    const updated = nextProviderLabState(updating);
    expect(activeCodex(updated!).version).toBe("0.148.0");
    expect(activeCodex(updated!).versionAdvisory?.status).toBe("current");
  });
});
