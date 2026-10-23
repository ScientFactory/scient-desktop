import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["scient", "scient-next-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it.each([
    "scient://attacker/welcome",
    "scient://app:123/welcome",
    "scient://app/auth/callback",
    "scient://user@ app/welcome",
    "scient://app/welcome/../evil",
    // Upstream T3's desktop scheme and hosted origin belong to another product.
    "t3code://app/welcome",
    "t3code-dev://app/welcome",
    "https://app.t3.codes/welcome",
    "https://attacker.example/welcome",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
