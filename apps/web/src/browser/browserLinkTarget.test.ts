import type { BrowserLinkTarget } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { isSignInUrl, resolveLinkTarget } from "./browserLinkTarget";

const settings = vi.hoisted(() => ({ browserLinkTarget: "system" as BrowserLinkTarget }));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => settings,
}));

const click = { metaKey: false, ctrlKey: false };

describe("resolveLinkTarget", () => {
  it("leaves non-web schemes to the shell", () => {
    for (const url of ["mailto:someone@example.com", "vscode://file/x", "not a url"]) {
      expect(resolveLinkTarget({ url, event: click, preference: "app", canOpenInApp: true })).toBe(
        "system",
      );
    }
  });
});

describe("sign-in links", () => {
  const inApp = (url: string) =>
    resolveLinkTarget({ url, event: click, preference: "app", canOpenInApp: true });

  it("opens a sign-in in the system browser even when links open in-app", () => {
    // Where the user's accounts and passkeys are, with an address bar that
    // shows whose page is asking.
    expect(
      inApp(
        "https://claude.ai/oauth/authorize?client_id=abc&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback&state=s",
      ),
    ).toBe("system");
    expect(
      inApp("https://auth.openai.com/oauth/authorize?code_challenge=x&code_challenge_method=S256"),
    ).toBe("system");
    expect(inApp("http://localhost:54545/launch")).toBe("system");
    expect(inApp("http://127.0.0.1:1455/auth/callback?code=c&state=s")).toBe("system");
  });

  it("leaves other pages, local ones included, to the preference", () => {
    expect(inApp("https://docs.example.com/guide?client_id=abc")).toBe("app");
    expect(inApp("http://localhost:5173/")).toBe("app");
    expect(inApp("http://localhost:5173/callback")).toBe("app");
    expect(inApp("https://example.com/launch")).toBe("app");
    expect(isSignInUrl("not a url")).toBe(false);
  });
});
