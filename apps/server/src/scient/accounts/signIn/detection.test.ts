import * as Schema from "effect/Schema";
import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { SignInDetection, signInDetectionScript } from "./detection.ts";
import { decideSignIn } from "./decision.ts";
import { readAccountCookies, typeAccountValue } from "../agent/browserOperations.ts";

const decodeDetection = Schema.decodeUnknownSync(SignInDetection);

it("detects static login steps, refuses look-alike fills, and reads only the requested site's HttpOnly cookies over CDP", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("https://**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<form><input name="username"><input type="password"><button>Sign in</button></form>',
      }),
    );
    const detect = async () => decodeDetection(await page.evaluate(signInDetectionScript));
    await page.goto("https://login.example.com");
    const combined = await detect();
    expect(combined.username).not.toBeNull();
    expect(combined.password).not.toBeNull();
    await typeAccountValue(page, {
      origin: combined.origin,
      selector: combined.password,
      text: "synthetic-value",
      clear: true,
    });
    expect(await page.locator("input[type=password]").inputValue()).toBe("synthetic-value");
    await page.setContent('<form><input autocomplete="username"><button>Next</button></form>');
    expect(await detect()).toMatchObject({
      password: null,
      otp: null,
      signedIn: false,
    });
    await page.setContent('<form><input type="password"><button>Continue</button></form>');
    expect(await detect()).toMatchObject({ username: null, signedIn: false });
    await page.setContent(
      '<form><input autocomplete="one-time-code"><button>Verify</button></form>',
    );
    expect((await detect()).otp).not.toBeNull();
    // regression: a one-form login whose 2FA field is named after the site's own scheme.
    await page.setContent(
      '<form><input type="email" name="email"><input type="password" name="password"><input type="text" name="totpmfa"><button>Log in</button></form>',
    );
    const oneForm = await detect();
    expect(oneForm.otp).toContain("input:nth-of-type(3)");
    expect(oneForm.username).toContain("input:nth-of-type(1)");
    await page.setContent('<div class="captcha">Complete this check</div>');
    expect((await detect()).challenge).toBe("captcha");
    await page.goto("https://example.com.attacker.test");
    const lookalike = await detect();
    expect(
      decideSignIn(lookalike, ["example.com"], { username: true, password: true, otp: true }).type,
    ).toBe("needs-user");
    await expect(
      typeAccountValue(page, {
        origin: "https://login.example.com",
        selector: lookalike.password,
        text: "synthetic-value",
        clear: true,
      }),
    ).rejects.toThrow("allowed origin");
    expect(await page.locator("input[type=password]").inputValue()).toBe("");
    await context.addCookies([
      {
        name: "session",
        value: "synthetic-cookie",
        domain: "login.example.com",
        path: "/",
        secure: true,
        httpOnly: true,
      },
      {
        name: "other",
        value: "synthetic-other",
        domain: "unrelated.test",
        path: "/",
        secure: true,
      },
    ]);
    const cdp = await context.newCDPSession(page);
    const cookies = await readAccountCookies(cdp, { urls: ["https://login.example.com/"] });
    expect(cookies).toMatchObject([{ name: "session", httpOnly: true }]);
    expect(cookies).toHaveLength(1);
  } finally {
    await browser.close();
  }
});
