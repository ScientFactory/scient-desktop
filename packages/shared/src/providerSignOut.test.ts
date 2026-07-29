import { describe, expect, it } from "vitest";

import { providerSignOutCommandArgs, providerSupportsSignOut } from "./providerSignOut";

describe("provider sign-out commands", () => {
  it("uses each supported provider CLI's fixed sign-out command", () => {
    expect(providerSignOutCommandArgs("codex")).toEqual(["logout"]);
    expect(providerSignOutCommandArgs("claudeAgent")).toEqual(["auth", "logout"]);
    expect(providerSignOutCommandArgs("cursor")).toEqual(["logout"]);
    expect(providerSignOutCommandArgs("grok")).toEqual(["logout"]);
  });

  it("does not advertise sign-out where no provider-owned command is supported", () => {
    expect(providerSupportsSignOut("codex")).toBe(true);
    expect(providerSupportsSignOut("antigravity")).toBe(false);
    expect(providerSupportsSignOut("droid")).toBe(false);
    expect(providerSupportsSignOut("kilo")).toBe(false);
    expect(providerSupportsSignOut("opencode")).toBe(false);
    expect(providerSupportsSignOut("pi")).toBe(false);
  });
});
