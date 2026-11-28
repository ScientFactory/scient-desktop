import * as Schema from "effect/Schema";
import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { SignInDetection, signInDetectionScript } from "./detection.ts";
import { decideSignIn } from "./decision.ts";
import {
  accountsWorldDispatch,
  evaluateInAccountsWorld,
  readAccountCookies,
  typeAccountValue,
} from "../agent/browserOperations.ts";

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
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).refused).toBeUndefined();
    // The form back saying so: the site refused the password.
    answer.body = `<form><p>Incorrect username or password</p><input type="password"><button>Sign in</button></form>`;
    await page.goto("https://login.example.com/form");
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).refused).toBe(true);
    // A limit stops everything, even with the form still showing.
    answer.status = 429;
    await page.goto("https://login.example.com/form");
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).limited).toBe(true);
    answer.status = 200;
    answer.body = `<form><input type="password"><p>Too many failed attempts.</p><button>Sign in</button></form>`;
    await page.goto("https://login.example.com/form");
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).limited).toBe(true);
  } finally {
    await browser.close();
  }
});

it("says a page that never painted didn't load, even with an empty CAPTCHA box on it", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    const answer = {
      body: '<div id="captcha" style="width:300px;height:80px"></div><script>/* never ran */</script>',
    };
    await page.route("https://**/*", (route) =>
      route.fulfill({
        contentType: "text/html",
        status: 200,
        // The other origin's CAPTCHA, which the sign-in page can't look into.
        body: route.request().url().startsWith("https://challenges.example.net/")
          ? '<input type="checkbox" aria-label="I am not a robot">'
          : answer.body,
      }),
    );
    // regression: run 4's HUJI page stayed blank and the band said "Solve the check."
    await page.goto("https://idp.example.ac.il/login");
    const blank = decodeDetection(await page.evaluate(signInDetectionScript));
    expect(blank).toMatchObject({ blank: true, challenge: null });
    const saved = { username: true, password: true, otp: false };
    expect(decideSignIn(blank, ["idp.example.ac.il"], saved)).toEqual({
      type: "needs-user",
      kind: "other",
      notLoaded: true,
      message: "The sign-in page didn't load. Open it in the browser.",
    });
    // Once it shows, its CAPTCHA is the person's to solve again.
    answer.body =
      '<p>Prove you are human</p><div id="captcha"><iframe src="about:blank" width="300" height="80"></iframe></div>';
    await page.goto("https://idp.example.ac.il/login");
    const check = decodeDetection(await page.evaluate(signInDetectionScript));
    expect(check.blank).toBeUndefined();
    expect(check.challenge).toBe("captcha");
    // A CAPTCHA served in a frame from another origin is all the page shows: still a check.
    answer.body =
      '<iframe src="https://challenges.example.net/recaptcha/anchor" title="reCAPTCHA" width="304" height="78"></iframe>';
    await page.goto("https://idp.example.ac.il/login");
    const framed = decodeDetection(await page.evaluate(signInDetectionScript));
    expect(framed).toMatchObject({ challenge: "captcha" });
    expect(framed.blank).toBeUndefined();
    // An empty CAPTCHA box beside a logo is no check.
    answer.body =
      '<img alt="" width="120" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="><div id="captcha" style="width:300px;height:80px"></div>';
    await page.goto("https://idp.example.ac.il/login");
    const logo = decodeDetection(await page.evaluate(signInDetectionScript));
    expect(logo.challenge).toBeNull();
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
    const cdp = await context.newCDPSession(page);
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
    await typeAccountValue(page, cdp, {
      origin: combined.origin,
      selector: combined.password,
      text: "synthetic-value",
      clear: true,
    });
    expect(await page.locator("input[type=password]").inputValue()).toBe("synthetic-value");
    // While the tab is recorded, a secret goes only where the page masks it.
    await expect(
      typeAccountValue(
        page,
        cdp,
        {
          origin: combined.origin,
          selector: combined.username!,
          text: "482913",
          clear: true,
          secret: true,
        },
        true,
      ),
    ).rejects.toThrow(/recorded/);
    expect(await page.locator("input[name=username]").inputValue()).toBe("");
    await typeAccountValue(
      page,
      cdp,
      {
        origin: combined.origin,
        selector: combined.password!,
        text: "synthetic-value",
        clear: true,
        secret: true,
      },
      true,
    );
    // Cleanup after the page changed: the same selector now names a field the user typed in.
    await page.setContent('<form><input name="note"><input value="user-text"></form>');
    await typeAccountValue(page, cdp, {
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
      typeAccountValue(page, cdp, {
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
    const passkey = decodeDetection(await page.evaluate(signInDetectionScript));
    expect([passkey.challenge, passkey.via]).toEqual(["passkey", undefined]);
    // The factor, in the person's words: a hardware key, a code the site texted.
    await page.setContent("<p>Insert your security key and touch it</p>");
    const key = decodeDetection(await page.evaluate(signInDetectionScript));
    expect([key.challenge, key.via]).toEqual(["passkey", "security-key"]);
    await page.setContent(
      '<p>We sent a text message to the number ending in 42</p><input autocomplete="one-time-code">',
    );
    expect(decodeDetection(await page.evaluate(signInDetectionScript)).via).toBe("text");
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
    // Microsoft's page: Yes, after ticking "Don't show this again".
    const kmsi = await detect(
      '<h1>Stay signed in?</h1><label><input type="checkbox" name="DontShowAgain"><span>Don\'t show this again</span></label><button>No</button><button>Yes</button>',
    );
    expect(kmsi.stay).toBeDefined();
    expect(kmsi.remember).toBeDefined();
    expect(
      (await detect("<p>AADSTS53000: Device is not in required device state: compliant.</p>"))
        .managedDevice,
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

it("tells a code box the site texted or mailed from one an authenticator app answers", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    let detected: SignInDetection | undefined;
    let body = "";
    await page.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body }),
    );
    const sent = async (text: string) => {
      body = `<form><p>${text}</p><input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>`;
      await page.goto("https://login.example.com/verify");
      const seen = decodeDetection(await page.evaluate(signInDetectionScript));
      expect(seen.otp).not.toBeNull();
      detected = seen;
      return seen.otpSent;
    };
    // regression: every code box counted as the saved key's, so a texted code was answered with it.
    expect(await sent("We sent a code by text message to the number ending in 42.")).toBe("text");
    expect(await sent("Enter the code we emailed to d***@example.com.")).toBe("email");
    expect(await sent("Enter the 6-digit code from your authenticator app.")).toBeUndefined();
    // Another way to get a code is an option, not this challenge.
    // regression: the SMS button made the authenticator's box a texted one.
    body = `<form><label for="c">Enter the code from your authenticator app</label><input id="c" autocomplete="one-time-code" inputmode="numeric"><button>Send a code by SMS</button><button>Verify</button></form>`;
    await page.goto("https://login.example.com/verify");
    detected = decodeDetection(await page.evaluate(signInDetectionScript));
    expect(detected.otpSent).toBeUndefined();
    expect(detected.otpApp).toBe(true);
    // regression: other languages, and an authenticator hint beside the SMS, fell through.
    expect(await sent("Nous avons envoyé un code à votre téléphone.")).toBe("text");
    expect(await sent("We texted you a code. Or use your authenticator app.")).toBe("text");
  } finally {
    await browser.close();
  }
});

it("finds authenticator wording only in the code box's own visible section", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    let body = "";
    await page.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body }),
    );
    const read = async (html: string) => {
      body = html;
      await page.goto("https://login.example.com/verify");
      return decodeDetection(await page.evaluate(signInDetectionScript));
    };
    const box = '<input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button>';
    // regression: hidden text, and help prose beside the form, counted as the challenge.
    expect(
      (
        await read(
          `<form><p>Enter the code.</p><p hidden>Use your authenticator app.</p>${box}</form>`,
        )
      ).otpApp,
    ).toBeUndefined();
    expect(
      (
        await read(
          `<aside>Tip: an authenticator app keeps you safe.</aside><form><p>Enter the code.</p>${box}</form>`,
        )
      ).otpApp,
    ).toBeUndefined();
    expect(
      (
        await read(
          `<form><label for="c">Enter the code from your authenticator app</label><input id="c" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form>`,
        )
      ).otpApp,
    ).toBe(true);
    // A box that only mentions a phone is one the key may not answer.
    expect(
      (await read(`<form><p>Enter the code for your phone.</p>${box}</form>`)).otpDelivery,
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

it("vetoes the key on a phone, a text or a mail in the field, its challenge or just above it", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    let body = "";
    await page.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body }),
    );
    const read = async (html: string, path = "verify") => {
      body = html;
      await page.goto(`https://login.example.com/${path}`);
      return decodeDetection(await page.evaluate(signInDetectionScript));
    };
    const box = '<input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button>';
    const labelled = (extra = "") =>
      `<label for="c">Enter the code from your authenticator app</label><input id="c" autocomplete="one-time-code" inputmode="numeric"${extra}><button>Verify</button>`;
    const appBox = labelled();
    // regression: the field's own placeholder escaped the veto, and its name counted as evidence.
    for (const placeholder of ["SMS verification code", "Email verification code"]) {
      const named = await read(
        `<form><p>Enter the code.</p><input name="authenticatorCode" autocomplete="one-time-code" placeholder="${placeholder}"><button>Verify</button></form>`,
      );
      expect(named.otpDelivery).toBe(true);
      expect(named.otpApp).toBeUndefined();
    }
    expect(
      (
        await read(
          `<form><p>Enter the code.</p><input name="authenticatorCode" id="authenticatorCode" autocomplete="one-time-code"><button>Verify</button></form>`,
        )
      ).otpApp,
    ).toBeUndefined();
    // An accessible description naming a phone vetoes too.
    expect(
      (
        await read(
          `<form>${labelled(' aria-describedby="d"')}<span id="d" hidden>Sent to your phone</span></form>`,
        )
      ).otpDelivery,
    ).toBe(true);
    // An SMS instruction above the form, or a phone beside the app in it, still vetoes.
    const above = await read(
      `<h2>Check your phone</h2><p>We sent you a code by SMS.</p><form>${appBox}</form>`,
    );
    expect(above.otpDelivery).toBe(true);
    expect(above.otpApp).toBeUndefined();
    const aboveOnly = await read(
      `<p>Use the code for your phone.</p><form><p>Enter the code.</p>${box}</form>`,
    );
    expect(aboveOnly.otpDelivery).toBe(true);
    const mixed = await read(
      `<form><p>Enter the code from your phone. Tip: an authenticator app is safer.</p>${box}</form>`,
    );
    expect(mixed.otpDelivery).toBe(true);
    // regression: a footer's "Call us" vetoed an authenticator's challenge.
    const footer = await read(`<form>${appBox}</form><footer>Call us on 1-800-555-0100.</footer>`);
    expect(footer.otpApp).toBe(true);
    expect(footer.otpDelivery).toBeUndefined();
    const nav = await read(
      `<nav><a href="/">Home</a> Questions? Email us.</nav><main><form>${appBox}</form></main><div class="site-footer">Text STOP to unsubscribe</div>`,
    );
    expect(nav.otpApp).toBe(true);
    expect(nav.otpDelivery).toBeUndefined();
    // An option not chosen is another way, not this challenge.
    const options = await read(
      `<form><label><input type="radio" name="how" checked> Authenticator app</label><label><input type="radio" name="how"> Text me a code</label>${appBox}</form>`,
    );
    expect(options.otpApp).toBe(true);
    expect(options.otpDelivery).toBeUndefined();
    // regression: help text, by its class, was the page's frame, and a channel-less notice that
    // a code was just sent went unread.
    for (const html of [
      `<form>${appBox}<div class="help-text">Use the code from your email.</div></form>`,
      `<form>${appBox}</form><p class="help-text">Use the code from your email.</p>`,
      `<div class="banner">We just sent you a verification code.</div><div></div><div></div><div></div><main><section><div><form>${appBox}</form></div></section></main>`,
      `<p>A new code has been sent.</p><form>${appBox}</form>`,
    ]) {
      const seen = await read(html);
      expect(seen.otpDelivery).toBe(true);
      expect(seen.otpApp).toBeUndefined();
    }
    // A frame class on the form's own surroundings hides nothing.
    expect(
      (
        await read(
          `<div class="help-page"><form><p>We sent a code to your phone.</p>${box}</form></div>`,
        )
      ).otpDelivery,
    ).toBe(true);
  } finally {
    await browser.close();
  }
});

it("presses only a code form's own enabled native submitter, and none in a form with two", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await (await browser.newContext()).newPage();
    let body = "";
    await page.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body }),
    );
    const read = async (html: string) => {
      body = html;
      await page.goto("https://login.example.com/verify");
      return decodeDetection(await page.evaluate(signInDetectionScript));
    };
    const box = '<p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric">';
    // A native submitter the form owns is the one pressed.
    const native = await read(`<form>${box}<button id="only">Verify</button></form>`);
    expect(native).toMatchObject({ otpOnly: true });
    expect(native.submit).toMatch(/button:nth-of-type\(1\)$/);
    expect(native.otpNoSubmit).toBeUndefined();
    // regression: a lone custom control was pressed, and its script could submit anything; then
    // the form was sent without it. Now no submit is chosen, and the box has no way to be sent.
    const custom = await read(`<form>${box}<button type="button" id="only">Verify</button></form>`);
    expect(custom.submit).toBeNull();
    expect(custom.otpNoSubmit).toBe(true);
    // A disabled one is no way to send it either.
    const disabled = await read(`<form>${box}<button id="only" disabled>Verify</button></form>`);
    expect(disabled.submit).toBeNull();
    expect(disabled.otpNoSubmit).toBe(true);
    const two = await read(
      `<form>${box}<button type="button">Show</button><button id="go">Verify</button></form>`,
    );
    expect(two.otpOnly).toBeUndefined();
  } finally {
    await browser.close();
  }
});

it("tells a code box by its element in Scient's isolated world, and fills only that element", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.route("https://**/*", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<form><p id="status">Enter the code.</p><div id="row"><input id="code" autocomplete="one-time-code"></div><button>Verify</button></form><script>globalThis.__scientInstances = { prefix: "page", next: 1, ids: new WeakMap(), elements: new Map() };</script>',
      }),
    );
    await page.goto("https://login.example.com/verify");
    const read = async () =>
      decodeDetection(await evaluateInAccountsWorld(cdp, signInDetectionScript, 5_000));
    const first = await read();
    expect(first.otpBox).toMatch(/^[0-9a-f]{8}-\d+:[0-9a-f]{8}-\d+$/);
    // regression: the table lived on the page's own window, where the page could read or reset it.
    expect(await page.evaluate("globalThis.__scientInstances.prefix")).toBe("page");
    expect((await read()).otpBox).toBe(first.otpBox);
    // A passing "Verifying…" and a sibling that moves the field's selector are the same box.
    await page.evaluate(`document.getElementById("status").textContent = "Verifying…"`);
    await page.evaluate(`document.getElementById("row").before(document.createElement("div"))`);
    const moved = await read();
    expect(moved.otpBox).toBe(first.otpBox);
    expect(moved.otp).not.toBe(first.otp);
    // The fill finds that element by its instance, wherever its selector now points.
    const fill = (seen: typeof first, text: string) =>
      typeAccountValue(page, cdp, {
        origin: seen.origin,
        selector: seen.otp!,
        text,
        clear: true,
        secret: true,
        instance: seen.otpField,
        document: seen.document,
      });
    await fill(first, "482913");
    expect(await page.locator("#code").inputValue()).toBe("482913");
    // regression: a replacement between the read and the fill received the code at its selector.
    await page.evaluate(
      `(() => { const old = document.getElementById("code"); old.replaceWith(old.cloneNode(false)); })()`,
    );
    await expect(fill(moved, "551177")).rejects.toThrow(/changed after Scient read it/);
    expect(await page.locator("#code").inputValue()).not.toBe("551177");
    // The replacement is a new box.
    expect((await read()).otpBox).not.toBe(first.otpBox);
  } finally {
    await browser.close();
  }
});

it("types the key only if the field, its container and what it asks for still hold after focus", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let body = "";
    await page.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body }),
    );
    const challenge = (onFocus: string, plain = false) =>
      `<form id="one">${plain ? '<p id="say">Enter the 6-digit code.</p>' : '<label id="say" for="code">Enter the code from your authenticator app</label>'}<input id="code" autocomplete="one-time-code"><button>Verify</button></form><script>document.getElementById("code").addEventListener("focus", () => { ${onFocus} }, { once: true });</script>`;
    const attempt = async (
      onFocus: string,
      mode: "automatic" | "generic" | "explicit",
      passwordSent = false,
    ) => {
      body = challenge(onFocus, mode === "generic");
      await page.goto("https://login.example.com/verify");
      const seen = decodeDetection(
        await evaluateInAccountsWorld(cdp, signInDetectionScript, 5_000),
      );
      expect(mode === "generic" ? seen.otpOnly : seen.otpApp).toBe(true);
      const typed = typeAccountValue(page, cdp, {
        origin: seen.origin,
        selector: seen.otp!,
        text: "482913",
        clear: true,
        secret: true,
        instance: seen.otpField,
        document: seen.document,
        container: seen.otpContainer,
        mode,
        ...(passwordSent ? { passwordSent: true } : {}),
      });
      return typed.then(
        () => "typed",
        (error: Error) => error.message,
      );
    };
    // An unchanged challenge takes the key.
    expect(await attempt("", "automatic")).toBe("typed");
    expect(await page.locator("#code").inputValue()).toBe("482913");
    // regression: focus redrew the challenge for a texted code, and the key went in anyway.
    const texted = `document.getElementById("say").textContent = "Enter the code we texted to your phone.";`;
    for (const mode of ["automatic", "explicit"] as const) {
      expect(await attempt(texted, mode)).toMatch(/changed after Scient read it/);
      expect(await page.locator("#code").inputValue()).toBe("");
    }
    // A saved key's plain box (AMENDMENTS 63a): typed while the page speaks of no delivered code,
    // and not once focus shows a way to have it texted.
    expect(await attempt("", "generic")).toBe("typed");
    expect(
      await attempt(
        `document.body.insertAdjacentHTML("beforeend", '<p><a href="/resend">Resend the code by SMS</a></p>');`,
        "generic",
      ),
    ).toMatch(/changed after Scient read it/);
    expect(await page.locator("#code").inputValue()).toBe("");
    // regression: focus revealed a control only Chromium names with a code (a menu item's label),
    // and the key went in before the send could see it.
    expect(
      await attempt(
        `document.body.insertAdjacentHTML("beforeend", '<div role="menu"><div role="menuitem" tabindex="0" aria-label="Get a new code" style="display:inline-block;width:16px;height:16px"></div></div>');`,
        "generic",
      ),
    ).toMatch(/changed after Scient read it/);
    expect(await page.locator("#code").inputValue()).toBe("");
    // regression: focus took the box's only words of a code away, and the key went in. After the
    // password the box is a code challenge without them, which only the run can tell the page.
    const unsaid = `document.getElementById("say").remove();`;
    expect(await attempt(unsaid, "generic")).toMatch(/changed after Scient read it/);
    expect(await page.locator("#code").inputValue()).toBe("");
    expect(await attempt(unsaid, "generic", true)).toBe("typed");
    // regression: focus disabled the one button that would send the code, and the key went in.
    const unsendable = `document.querySelector("#one button").disabled = true;`;
    expect(await attempt(unsendable, "automatic")).toMatch(/changed after Scient read it/);
    expect(await page.locator("#code").inputValue()).toBe("");
    // regression: focus took the field out of its form, where it stands, and the key went in on
    // every path. Its form is the same one after focus, or nothing is typed.
    const formless = `document.getElementById("code").setAttribute("form", "nowhere");`;
    for (const mode of ["automatic", "explicit", "generic"] as const) {
      expect(await attempt(formless, mode)).toMatch(/changed after Scient read it/);
      expect(await page.locator("#code").inputValue()).toBe("");
    }
    // Moved into another challenge on focus: not the one inspected.
    expect(
      await attempt(
        `const two = document.createElement("form"); document.body.append(two); two.append(document.getElementById("code"));`,
        "automatic",
      ),
    ).toMatch(/changed after Scient read it/);
    expect(await page.locator("#code").inputValue()).toBe("");
  } finally {
    await browser.close();
  }
});

it("clears a typed code by its field's identity, moved or not, and fails when it can't", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await page.route("https://**/*", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: '<form><p>Enter the code from your authenticator app.</p><div id="row"><input id="code" autocomplete="one-time-code"></div><button>Verify</button></form>',
      }),
    );
    await page.goto("https://login.example.com/verify");
    const seen = decodeDetection(await evaluateInAccountsWorld(cdp, signInDetectionScript, 5_000));
    const record = {
      origin: seen.origin,
      selector: seen.otp!,
      instance: seen.otpField,
      document: seen.document,
    };
    const type = () =>
      typeAccountValue(page, cdp, { ...record, text: "482913", clear: true, secret: true });
    const clear = () =>
      typeAccountValue(page, cdp, { ...record, text: "", clear: true, expected: "482913" });
    await type();
    // regression: the clear followed the old selector, so a moved field kept its digits.
    await page.evaluate(`document.getElementById("row").before(document.createElement("div"))`);
    await clear();
    expect(await page.locator("#code").inputValue()).toBe("");
    // Replaced by a copy that carries the digits: the clear can't show them gone, so it fails.
    await type();
    await page.evaluate(
      `(() => { const old = document.getElementById("code"); old.replaceWith(old.cloneNode(true)); })()`,
    );
    await expect(clear()).rejects.toThrow();
    expect(await page.locator("#code").inputValue()).toBe("482913");
  } finally {
    await browser.close();
  }
});

it("checks again at the setter what focus can change: read-only, unmasked, a value not Scient's", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let body = "";
    await page.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body }),
    );
    const open = async (type: string, onFocus: string, value = "") => {
      body = `<form><input id="f" type="${type}" value="${value}"><button>Go</button></form><script>document.getElementById("f").addEventListener("focus", () => { ${onFocus} }, { once: true });</script>`;
      await page.goto("https://login.example.com/form");
    };
    const write = (text: string, extra: Record<string, unknown> = {}, recording = false) =>
      typeAccountValue(
        page,
        cdp,
        {
          origin: "https://login.example.com",
          selector: "#f",
          text,
          clear: true,
          secret: true,
          ...extra,
        },
        recording,
      ).then(
        () => "written",
        (error: Error) => error.message,
      );
    // regression: focus made the field read-only, and the value went in anyway.
    await open("password", `document.getElementById("f").readOnly = true;`);
    expect(await write("synthetic-value")).toMatch(/could not be filled/);
    expect(await page.locator("#f").inputValue()).toBe("");
    // regression: focus unmasked the field while the tab was recorded.
    await open("password", `document.getElementById("f").type = "text";`);
    expect(await write("482913", {}, true)).toMatch(/recorded/);
    expect(await page.locator("#f").inputValue()).toBe("");
    // regression: a clear erased the value the page put there on focus.
    await open("text", `document.getElementById("f").value = "the person's own";`, "482913");
    expect(await write("", { expected: "482913" })).toBe("written");
    expect(await page.locator("#f").inputValue()).toBe("the person's own");
  } finally {
    await browser.close();
  }
});

it("sends a key from the accounts world only for the very field, button and challenge inspected", async () => {
  // Frames of other sites in their own processes, as in a full browser.
  const browser = await chromium.launch({ headless: true, args: ["--site-per-process"] });
  // The site's answer to a code it was sent, held until released; posts counts what reached it.
  let held = Promise.withResolvers<void>();
  const holding: Array<Promise<void>> = [];
  const answerHeld = async () => {
    held.resolve();
    await Promise.all(holding);
    held = Promise.withResolvers<void>();
  };
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let body = "";
    let posts = 0;
    let answeredPosts = 0;
    await page.route("https://**/*", (route) => {
      const url = new URL(route.request().url());
      // A worker that posts the code it is given to the site's API.
      if (url.pathname === "/worker.js")
        return route.fulfill({
          contentType: "text/javascript",
          body: "onmessage = (event) => fetch('https://api.example.com/verify', { method: 'POST', body: event.data });",
        });
      if (route.request().method() !== "POST")
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: url.hostname === "login.example.com" ? body : "",
        });
      posts++;
      const answered = held.promise.then(() => {
        answeredPosts++;
        return route.fulfill({
          contentType: "application/json",
          headers: { "access-control-allow-origin": "*" },
          body: "{}",
        });
      });
      holding.push(answered);
      return answered;
    });
    // The form answers a submission by marking itself busy, as a sign-in form does while it sends.
    const answers = `onsubmit="event.preventDefault(); window.sent = (window.sent ?? 0) + 1; window.under = document.getElementById('say').textContent; this.setAttribute('aria-busy', 'true');"`;
    const label = '<label id="say" for="code">Enter the code from your authenticator app</label>';
    const send = async (
      html: string,
      between = "",
      answerMs?: number,
      responseMs?: number,
      mode: "automatic" | "generic" = "automatic",
      passwordSent = false,
    ) => {
      body = html;
      await page.goto("https://login.example.com/verify");
      const seen = decodeDetection(
        await evaluateInAccountsWorld(cdp, signInDetectionScript, 5_000),
      );
      expect(mode === "automatic" ? seen.otpApp : seen.otpOnly).toBe(true);
      // What the page does after the last read and before the send.
      if (between) await page.evaluate(between);
      const outcome = await accountsWorldDispatch(page, cdp, {
        world: "accounts",
        origin: seen.origin,
        instance: seen.otpField,
        document: seen.document,
        container: seen.otpContainer,
        submitInstance: seen.submitInstance,
        mode,
        ...(passwordSent ? { passwordSent: true } : {}),
        ...(answerMs === undefined ? {} : { answerMs }),
        ...(responseMs === undefined ? {} : { responseMs }),
      })?.then(
        (result) => ({ result, answeredPosts }),
        (error: Error) => error.message,
      );
      return {
        outcome: typeof outcome === "string" ? outcome : (outcome?.result.unanswered ?? "sent"),
        answeredWhenDone: typeof outcome === "string" ? undefined : outcome?.answeredPosts,
        sent: await page.evaluate("window.sent ?? 0"),
        under: await page.evaluate("window.under ?? null"),
      };
    };
    const withButton = `<form ${answers}>${label}<input id="code" autocomplete="one-time-code"><button id="go">Verify</button></form>`;
    const noButton = `<form ${answers}>${label}<input id="code" autocomplete="one-time-code"></form>`;
    expect(await send(withButton)).toMatchObject({ outcome: "sent", sent: 1 });
    // A key goes only by the person's own press: an enabled native submitter its field's form owns.
    // regression: an authenticator's box was sent through a button another form owns. Its form owns
    // none, so nothing is sent, and the other form never submits.
    const foreign = `<form ${answers}>${label}<input id="code" autocomplete="one-time-code"><button form="other" id="go">Verify</button></form><form id="other" hidden onsubmit="event.preventDefault(); window.foreign = (window.foreign ?? 0) + 1;"></form>`;
    expect(await send(foreign)).toMatchObject({
      outcome: expect.stringMatching(/no button or form/),
      sent: 0,
    });
    expect(await page.evaluate("window.foreign ?? 0")).toBe(0);
    // regression: a custom control ran a script that pressed another form's submitter, and then the
    // form was sent without any button. Neither happens: nothing is sent.
    const relay = `<form ${answers}><p id="say">Enter the 6-digit code.</p><input id="code" autocomplete="one-time-code" inputmode="numeric"><div role="button" tabindex="0" onclick="document.getElementById('ext').click()">Verify</div></form><form hidden onsubmit="event.preventDefault(); window.foreign = (window.foreign ?? 0) + 1;"><button id="ext">Go</button></form>`;
    expect(await send(relay, "", undefined, undefined, "generic")).toMatchObject({
      outcome: expect.stringMatching(/no button or form/),
      sent: 0,
    });
    expect(await page.evaluate("window.foreign ?? 0")).toBe(0);
    // regression: with an SMS submit before Verify, the first submitter, the SMS one, was pressed
    // and its action got the code. Two usable submitters, one for delivery: none is pressed.
    const smsFirst = `<form action="/verify" method="post">${label}<input id="code" autocomplete="one-time-code"><button formaction="/sms">Text me instead</button><button>Verify</button></form>`;
    const postsBefore = posts;
    expect(await send(smsFirst)).toMatchObject({
      outcome: expect.stringMatching(/no button or form/),
      sent: 0,
    });
    expect(posts).toBe(postsBefore);
    // regression: after the read, the one button became one Chromium names "Resend by SMS" (an
    // image's alt only it reads), and it was pressed anyway.
    expect(
      await send(
        withButton,
        `document.getElementById("go").innerHTML = '<img alt="Resend by SMS" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E">';`,
      ),
    ).toMatchObject({ outcome: expect.stringMatching(/changed/), sent: 0 });
    // regression: a disabled Verify, the only one, was bypassed by submitting the form itself.
    const disabled = `<form ${answers}>${label}<input id="code" autocomplete="one-time-code"><button id="go" disabled>Verify</button></form>`;
    expect(await send(disabled)).toMatchObject({
      outcome: expect.stringMatching(/no button or form/),
      sent: 0,
    });
    // regression: a custom-only form, submitted without a button, put the code in the address of a
    // GET request. With no native button nothing is sent, and the address keeps no code.
    const customGet = `<form>${label}<input id="code" name="code" autocomplete="one-time-code"><div role="button" tabindex="0">Verify</div></form>`;
    expect(await send(customGet)).toMatchObject({
      outcome: expect.stringMatching(/no button or form/),
    });
    expect(page.url()).not.toContain("code=");
    // regression: with no form at all, the key went out through whatever button the page had.
    const formless = `<div role="dialog">${label}<input id="code" autocomplete="one-time-code"><button id="go" onclick="window.sent = (window.sent ?? 0) + 1;">Verify</button></div>`;
    expect(await send(formless)).toMatchObject({
      outcome: expect.stringMatching(/no button or form/),
      sent: 0,
    });
    // The page's one plain box, by a saved key (AMENDMENTS 63a): sent while nothing on the page
    // speaks of a delivered code, and never as an authenticator's.
    const plainBox = `<form ${answers}><p id="say">Enter the 6-digit code.</p><input id="code" autocomplete="one-time-code" inputmode="numeric"><button id="go">Verify</button></form>`;
    expect(await send(plainBox, "", undefined, undefined, "generic")).toMatchObject({
      outcome: "sent",
      sent: 1,
    });
    expect(
      await send(
        plainBox,
        `document.body.insertAdjacentHTML("beforeend", '<p><a href="/resend">Resend the code by SMS</a></p>');`,
        undefined,
        undefined,
        "generic",
      ),
    ).toMatchObject({ outcome: expect.stringMatching(/changed/), sent: 0 });
    // regression: a control only Chromium names with a code (a menu item's label), added after the
    // read, didn't stop the send.
    expect(
      await send(
        plainBox,
        `document.body.insertAdjacentHTML("beforeend", '<div role="menu"><div role="menuitem" tabindex="0" aria-label="Get a new code" style="display:inline-block;width:16px;height:16px"></div></div>');`,
        undefined,
        undefined,
        "generic",
      ),
    ).toMatchObject({ outcome: expect.stringMatching(/changed/), sent: 0 });
    // The box's words of a code gone after the read: only after the password is it still a code
    // challenge, which the run tells the send.
    const unsaid = `document.getElementById("say").textContent = "";`;
    expect(await send(plainBox, unsaid, undefined, undefined, "generic")).toMatchObject({
      outcome: expect.stringMatching(/changed/),
      sent: 0,
    });
    expect(await send(plainBox, unsaid, undefined, undefined, "generic", true)).toMatchObject({
      outcome: "sent",
      sent: 1,
    });
    // regression: the click resolved a selector, so an identical replacement button took it.
    expect(
      await send(
        withButton,
        `(() => { const old = document.getElementById("go"); old.replaceWith(old.cloneNode(true)); })()`,
      ),
    ).toMatchObject({ outcome: expect.stringMatching(/changed/), sent: 0 });
    // regression: a redraw for a texted code after the last read was sent anyway.
    expect(
      await send(
        withButton,
        `document.getElementById("say").textContent = "Enter the code we texted to your phone";`,
      ),
    ).toMatchObject({ outcome: expect.stringMatching(/changed/), sent: 0 });
    // regression: with no button the send focused the field first, and its focus handler switched
    // the prompt to SMS before the form was submitted. With no button there is no send at all.
    const switchesOnFocus = `${noButton}<script>document.getElementById("code").addEventListener("focus", () => { document.getElementById("say").textContent = "Enter the code we texted to your phone"; });</script>`;
    expect(await send(switchesOnFocus)).toMatchObject({
      outcome: expect.stringMatching(/no button or form/),
      sent: 0,
    });
    // regression: with no form, Enter went to whatever had focus, here another field. No checked
    // way to send it: nothing is sent, and no key is pressed.
    const noForm = `<div role="dialog">${label}<input id="code" autocomplete="one-time-code"><input id="other"></div><script>document.getElementById("code").addEventListener("focus", () => document.getElementById("other").focus()); document.getElementById("other").addEventListener("keydown", (event) => { if (event.key === "Enter") window.sent = (window.sent ?? 0) + 1; });</script>`;
    expect(await send(noForm)).toMatchObject({
      outcome: expect.stringMatching(/no button or form/),
      sent: 0,
    });
    // A button that only answers a real press: the script click is ignored and the page stays as
    // it was. A picture it loads on the click is no answer to the code. Silent, and told so.
    const trustedOnly = `<form ${answers}>${label}<input id="code" autocomplete="one-time-code"><button id="go" onclick="new Image().src = '/pixel.png'; if (!event.isTrusted) event.preventDefault();">Verify</button></form>`;
    expect(await send(trustedOnly, "", 500)).toMatchObject({ outcome: "silent", sent: 0 });
    // regression: a site still answering its request after the look for an answer was taken to
    // want a real press, so the code was taken back while the site had it. Its answer is waited
    // for, and nothing is sent again.
    const posting = (to: string) =>
      `<form onsubmit="event.preventDefault(); fetch('${to}', { method: 'POST', body: document.getElementById('code').value });">${label}<input id="code" autocomplete="one-time-code"><button id="go">Verify</button></form>`;
    // The site answers after 4 s, past the look for an answer: the send returns only with it.
    const answeredLate = async (html: string) => {
      const sending = send(html);
      await page.waitForTimeout(4_000);
      await answerHeld();
      return sending;
    };
    expect(await answeredLate(posting("/verify-code"))).toMatchObject({
      outcome: "sent",
      answeredWhenDone: 1,
    });
    expect(posts).toBe(1);
    // regression: a code posted to the site's API on another origin was taken for silence.
    posts = 0;
    answeredPosts = 0;
    expect(await answeredLate(posting("https://api.example.com/verify"))).toMatchObject({
      outcome: "sent",
      answeredWhenDone: 1,
    });
    expect(posts).toBe(1);
    // regression: a worker's POST and a form posted into another site's frame weren't seen, so
    // the send was taken for silence while the site had the code.
    posts = 0;
    answeredPosts = 0;
    const byWorker = `<form onsubmit="event.preventDefault(); new Worker('/worker.js').postMessage(document.getElementById('code').value);">${label}<input id="code" autocomplete="one-time-code"><button id="go">Verify</button></form>`;
    expect(await answeredLate(byWorker)).toMatchObject({ outcome: "sent", answeredWhenDone: 1 });
    expect(posts).toBe(1);
    posts = 0;
    answeredPosts = 0;
    const intoFrame = `<form action="https://verify.other.test/code" method="post" target="sink">${label}<input id="code" name="code" autocomplete="one-time-code"><button id="go">Verify</button></form><iframe name="sink" src="https://verify.other.test/blank"></iframe>`;
    expect(await answeredLate(intoFrame)).toMatchObject({ outcome: "sent", answeredWhenDone: 1 });
    expect(posts).toBe(1);
    // An answer that doesn't come in time: told as still with the site, sent once.
    posts = 0;
    answeredPosts = 0;
    expect(await send(posting("https://api.example.com/verify"), "", 500, 500)).toMatchObject({
      outcome: "in flight",
      answeredWhenDone: 0,
    });
    expect(posts).toBe(1);
  } finally {
    // Held answers go out first: closing the browser under one fails its route.
    await answerHeld();
    await browser.close();
  }
});
