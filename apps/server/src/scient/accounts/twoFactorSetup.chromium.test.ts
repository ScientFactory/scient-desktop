// @effect-diagnostics nodeBuiltinImport:off -- A random desktop secret for the test's seal key.
import * as NodeCrypto from "node:crypto";
import { AccountSetupPage, BrowserProfileId } from "@t3tools/contracts";
import { QrCode } from "@t3tools/shared/qrCode";
import { loginFieldsKitSource } from "@t3tools/shared/scientLoginFields";
import { pageSealKey, sealPageSecrets } from "@t3tools/shared/scientPageSeal";
import { setupPageScript } from "@t3tools/shared/scientSetupPage";
import { afterAll, beforeAll, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { chromium, type Browser, type Page } from "playwright-core";

import { fakeAccounts } from "./Accounts.testkit.ts";
import { AccountsService } from "./AccountsService.ts";
import { keepFromPage, setupKey } from "./twoFactorSetup.ts";

const KEY = "otpauth://totp/Example:ada%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example";
/** As long as real setups make them: a version-7 code, drawn 200 px wide as sites do. */
const LONG_KEY =
  "otpauth://totp/Example%20Research%20Portal:ada.lovelace%40university.example.edu?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP&issuer=Example%20Research%20Portal&algorithm=SHA1&digits=6&period=30";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(() => browser.close());

/** The QR as one SVG path, the way most sites (and Scient's own pairing code) draw it. */
const svgQr = (text: string) => {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  let d = "";
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) d += `M${x} ${y}h1v1h-1z`;
  return `<svg viewBox="0 0 ${qr.size} ${qr.size}" width="200" height="200"><rect width="${qr.size}" height="${qr.size}" fill="#fff"/><g transform="translate(0 0)"><path d="${d}" fill="#111"/></g></svg>`;
};

/** The same QR drawn on a canvas, the other common way. */
const canvasQr = (text: string) => {
  const qr = QrCode.encodeText(text, QrCode.Ecc.MEDIUM);
  const dark = [];
  for (let y = 0; y < qr.size; y++)
    for (let x = 0; x < qr.size; x++) if (qr.getModule(x, y)) dark.push([x, y]);
  return `<canvas id="qr" width="${qr.size * 6}" height="${qr.size * 6}"></canvas><script>
    const c = document.getElementById("qr").getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, ${qr.size * 6}, ${qr.size * 6}); c.fillStyle = "#000";
    for (const [x, y] of ${JSON.stringify(dark)}) c.fillRect(x * 6, y * 6, 6, 6);
  </script>`;
};

const setupPage = (qr: string) =>
  `<main><h1>Set up your authenticator app</h1>${qr}<label>Code <input name="code" autocomplete="one-time-code"></label><button>Verify</button></main>`;

it("reads a page's backup codes only where it names them, all of one shape", async () => {
  const page = await browser.newPage();
  try {
    const codesOf = async (html: string) => {
      await page.setContent(html);
      return page.evaluate(`(${loginFieldsKitSource}).recoveryCodes()`);
    };
    const list = ["7f3k-92ma", "x81q-4zr0", "m2p9-k7td", "q0w4-n8cs", "h5j2-u1ye"];
    const items = list.map((code) => `<li><code>${code}</code></li>`).join("");
    expect(await codesOf(`<h2>Save your recovery codes</h2><ul>${items}</ul>`)).toEqual(list);
    // The same list on a page that doesn't call them codes, or of mixed shapes, is not one.
    expect(await codesOf(`<h2>Order numbers</h2><ul>${items}</ul>`)).toEqual([]);
    expect(await codesOf(`<h2>Backup codes</h2><ul>${items}<li>1234567</li></ul>`)).toEqual([]);
  } finally {
    await page.close();
  }
});

/** A page of the browser, closed with the test. */
const openPage = Effect.acquireRelease(
  Effect.promise(() => browser.newPage()),
  (page: Page) => Effect.promise(() => page.close()),
);

/** The setup page as the desktop reads it, through the contract it crosses to the server in. */
const readSetup = (page: Page, html: string) =>
  Effect.promise(async () => {
    await page.setContent(html);
    return page.evaluate(setupPageScript);
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(AccountSetupPage)), Effect.orDie);

it.live("reads a setup page's key from its SVG or canvas QR, and only a TOTP key", () =>
  Effect.gen(function* () {
    const page = yield* openPage;
    const keyOf = (html: string) => Effect.map(readSetup(page, html), setupKey);
    expect((yield* keyOf(setupPage(svgQr(KEY))))?.uri).toBe(KEY);
    expect((yield* keyOf(setupPage(canvasQr(KEY))))?.uri).toBe(KEY);
    // A counter-based key would fall out of step with the site: it is not kept.
    expect(yield* keyOf(setupPage(svgQr(KEY.replace("totp", "hotp") + "&counter=1")))).toBe(
      undefined,
    );
  }).pipe(Effect.scoped),
);

it.live("holds a real-size setup key as a pending secret and gives back its current code", () =>
  Effect.gen(function* () {
    const page = yield* openPage;
    // Links longer than the contract takes beside the QR: cut to fit, never past the budget.
    const links = Array.from(
      { length: 4 },
      (_, index) => `<a href="${LONG_KEY}&n=${index}${"x".repeat(3000)}">key ${index}</a>`,
    ).join("");
    const setup = yield* readSetup(page, setupPage(svgQr(LONG_KEY)) + links);
    const held: Array<{ kind: string; value: string; origin: string; label?: string }> = [];
    const accounts = AccountsService.of({
      ...fakeAccounts({}).service,
      holdPending: (input) =>
        Effect.sync(() => {
          held.push({
            kind: input.kind,
            value: Redacted.value(input.value),
            origin: input.origin,
            ...(input.label ? { label: input.label } : {}),
          });
          return "pending-1";
        }),
    });
    // As the desktop seals it for the backend it runs: the page's origin, profile and document
    // bound to it. The app carries only this.
    const key = pageSealKey(NodeCrypto.randomBytes(32).toString("hex"));
    const now = yield* Clock.currentTimeMillis;
    const header = {
      at: now,
      origin: "https://portal.example.edu",
      profileId: BrowserProfileId.make("default"),
      documentId: "doc-1",
      offer: "two-factor-setup",
    };
    const text = JSON.stringify({ setup: { ...setup, uris: [] } });
    const seal = (sealKey = key, bound: Record<string, unknown> = header) =>
      sealPageSecrets(sealKey, bound, text)!;
    const keep = (sealed: string, documentId = "doc-1") =>
      keepFromPage({ offer: "two-factor-setup", documentId, sealed }, key).pipe(
        Effect.provideService(AccountsService, accounts),
      );
    const nothing = { found: false };
    // Changed on the way, sealed with another key (the app's own, another desktop's), presented
    // as another document's, or too old: nothing is held.
    const flipped = Buffer.from(seal(), "base64url");
    flipped[flipped.length - 1] = flipped.at(-1)! ^ 1;
    expect(yield* keep(flipped.toString("base64url"))).toEqual(nothing);
    expect(yield* keep(seal(pageSealKey("another-desktop")))).toEqual(nothing);
    expect(yield* keep(seal(), "doc-2")).toEqual(nothing);
    expect(yield* keep(seal(key, { ...header, at: now - 10 * 60_000 }))).toEqual(nothing);
    expect(held).toEqual([]);
    const once = seal();
    const answer = yield* keep(once);
    expect(answer).toMatchObject({ found: true, pendingId: "pending-1", period: 30 });
    expect("code" in answer ? answer.code : undefined).toMatch(/^\d{6}$/);
    // Each seal opens once: the same one again is nothing.
    expect(yield* keep(once)).toEqual(nothing);
    expect(held).toEqual([
      {
        kind: "totp",
        value: LONG_KEY,
        origin: "https://portal.example.edu",
        label: "ada.lovelace@university.example.edu",
      },
    ]);
  }).pipe(Effect.scoped),
);
