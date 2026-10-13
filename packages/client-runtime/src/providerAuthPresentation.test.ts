import { describe, expect, it } from "vite-plus/test";
import {
  ProviderInstanceId,
  type ProviderAuthState,
  type ServerProvider,
} from "@t3tools/contracts";
import { providerAuthPresentation } from "./providerAuthPresentation.ts";

const provider = {
  installed: true,
  auth: { status: "unknown", canLogout: true },
} satisfies Pick<ServerProvider, "installed" | "auth">;
const state = {
  instanceId: ProviderInstanceId.make("muse_fixture"),
  flowId: "fixture",
  authorizationUrl: null,
  expiresAt: null,
  credentialOwner: "provider",
  phase: "succeeded",
  methods: [],
  interaction: null,
  message: "Account setup completed, verification unavailable.",
} satisfies ProviderAuthState;

describe("shared account presentation", () => {
  it("does not turn an explicitly unverified success into a signed-in account", () => {
    expect(providerAuthPresentation(provider, { ...state, accountVerified: false })).toMatchObject({
      active: false,
      signedIn: false,
      finished: true,
      canClearCredentials: true,
      unverifiedMessage: state.message,
    });
  });
  it("does not finish a verified provider whose status still says signed out", () => {
    expect(
      providerAuthPresentation(
        { ...provider, auth: { ...provider.auth, status: "unauthenticated" } },
        state,
      ).finished,
    ).toBe(false);
  });
  it("preserves older servers' unknown-plus-success behavior", () => {
    expect(providerAuthPresentation(provider, state).signedIn).toBe(true);
  });
  it("recognizes authoritative authenticated status and keeps active setup active", () => {
    expect(
      providerAuthPresentation(
        { ...provider, auth: { ...provider.auth, status: "authenticated" } },
        { ...state, phase: "verifying", accountVerified: false },
      ),
    ).toMatchObject({ signedIn: true, active: true });
  });
  it("does not offer credential clearing for an unavailable runtime or unsupported logout", () => {
    const unverified = { ...state, accountVerified: false };
    expect(
      providerAuthPresentation({ ...provider, installed: false }, unverified).canClearCredentials,
    ).toBe(false);
    expect(
      providerAuthPresentation(
        { ...provider, auth: { ...provider.auth, canLogout: false } },
        unverified,
      ).canClearCredentials,
    ).toBe(false);
  });
  it("does not invent completion when a client has no provider or auth state", () => {
    expect(providerAuthPresentation(undefined, undefined)).toMatchObject({
      active: false,
      signedIn: false,
      finished: false,
      canClearCredentials: false,
    });
  });
});
