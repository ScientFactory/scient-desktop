import * as Schema from "effect/Schema";
import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { SignInDetection, signInDetectionScript } from "./detection.ts";
import { decideSignIn } from "./decision.ts";
import { readAccountCookies, typeAccountValue } from "../agent/browserOperations.ts";

const decodeDetection = Schema.decodeUnknownSync(SignInDetection);

it("calls a failed page broken, but not a sign-in form that answers with an error status", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const answer = { status: 400, body: "<h1>Bad request</h1>" };
    await page.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html", ...answer }),
    );
    await page.goto("https://login.example.com/old-step");
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).broken).toBe(true);
    answer.status = 401;
    answer.body = '<form><input type="password"><button>Sign in</button></form>';
    await page.goto("https://login.example.com/form");
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).broken).toBeUndefined();
  } finally {
    await browser.close();
  }
});

it("treats Google's failed-attempts page as a limit, not a step to finish", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(
      "<h1>Account recovery</h1><h2>Too many failed attempts</h2><button>Try another way to sign in</button>",
    );
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).limited).toBe(true);
  } finally {
    await browser.close();
  }
});

it("lists one choice per remembered account, whichever way a site marks its rows", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const choices = async (html: string) => {
      await page.setContent(html);
      const found = decodeDetection(await page.evaluate(signInDetectionScript)).accountChoices;
      return found?.map(({ email }) => email);
    };
    expect(
      await choices(
        '<ul><li><div data-identifier="a@example.com">A</div></li><li><div data-identifier="b@example.com">B</div></li></ul>',
      ),
    ).toEqual(["a@example.com", "b@example.com"]);
    expect(
      await choices(
        "<ul><li><button>Ada Lovelace a@example.com</button></li></ul><button>Use another account</button>",
      ),
    ).toEqual(["a@example.com"]);
    // A later step shows the chosen account as a chip that goes back to the start.
    expect(
      await choices("<button>a@example.com</button><button>Try another way</button>"),
    ).toBeUndefined();
    expect(await choices("<p>Nothing to choose</p>")).toBeUndefined();
  } finally {
    await browser.close();
  }
});

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
    // Cleanup after the page changed: the same selector now names a field the user typed in.
    await page.setContent('<form><input name="note"><input value="user-text"></form>');
    await typeAccountValue(page, {
      origin: combined.origin,
      selector: combined.password,
      text: "",
      clear: true,
      expected: "synthetic-value",
    });
    expect(await page.locator("input[value]").inputValue()).toBe("user-text");
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

it("extracts only an unambiguous, visible local push match number", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const [html, expected] of [
      ["<div>Enter the number shown to sign in <strong>42</strong></div>", "42"],
      ["<section>Verify with number: tap the number <span>7</span></section>", "7"],
      ["<div>Matching number <b>123</b></div>", "123"],
      ["<p>Approve sign-in on your phone</p><div>Invoice <b>42</b></div>", undefined],
      ['<div>Number shown <b style="display:none">42</b></div>', undefined],
      ["<div>Number shown <b>1234</b></div>", undefined],
      ["<div>Tap the number <b>12</b><b>34</b></div>", undefined],
    ] as const) {
      await page.setContent(html);
      const result = decodeDetection(await page.evaluate(signInDetectionScript));
      expect(result.challenge).toBe("push");
      expect(result.number).toBe(expected);
    }
    await page.setContent("<p>Use your passkey with Touch ID</p>");
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).challenge).toBe("passkey");
  } finally {
    await browser.close();
  }
});

it("finds remember-me and trust-device boxes, including styled ones, and Stay signed in", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const detect = async (html: string) => {
      await page.setContent(html);
      return decodeDetection(await page.evaluate(signInDetectionScript));
    };
    const login = '<form><input name="username"><input type="password">';
    expect(
      (await detect(`${login}<label><input type="checkbox">Keep me signed in</label></form>`))
        .remember,
    ).toBeDefined();
    expect(
      (
        await detect(
          `${login}<input id="r" type="checkbox" style="position:absolute;width:0;height:0;opacity:0"><label for="r">Trust this device</label></form>`,
        )
      ).remember,
    ).toBeDefined();
    expect(
      (await detect(`${login}<label><input type="checkbox">Public computer</label></form>`))
        .remember,
    ).toBeUndefined();
    expect(
      (await detect(`${login}<label><input type="checkbox" checked>Remember me</label></form>`))
        .remember,
    ).toBeUndefined();
    expect(
      (await detect("<h1>Stay signed in?</h1><button>No</button><button>Yes</button>")).stay,
    ).toBeDefined();
  } finally {
    await browser.close();
  }
});
