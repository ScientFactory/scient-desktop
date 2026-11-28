import * as Schema from "effect/Schema";
import { chromium } from "playwright-core";
import { expect, it } from "vite-plus/test";
import { accountsWorldEvaluation } from "../agent/browserOperations.ts";
import { DELIVERY_CHANNELS, SignInDetection, signInDetectionScript } from "./detection.ts";

/**
 * The contract for which code boxes the saved authenticator key answers by itself; the rule is in
 * docs/internals/scient-accounts.md ("No surprise codes"). Every reviewed case is a row.
 */
const decode = Schema.decodeUnknownSync(SignInDetection);
const box = '<input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button>';
const form = (text: string) => `<form><p>${text}</p>${box}</form>`;
/** A code field whose own label says to take its code from an authenticator app. */
const labelled = (label: string, extra = "") =>
  `<label for="code">${label}</label><input id="code" autocomplete="one-time-code" inputmode="numeric"${extra}><button>Verify</button>`;
const appBox = labelled("Enter the code from your authenticator app");

const cases: ReadonlyArray<{
  readonly round: number;
  readonly name: string;
  readonly html: string;
  /** An earlier page of the same sign-in run, read first. */
  readonly earlier?: string;
  /** The verdict where the saved key is no evidence: on a login that signs in only when asked. */
  readonly verdict: "key" | "hand off";
  /** With a saved key, the default (AMENDMENTS 63a), where it differs: the page's one plain box. */
  readonly saved?: "key" | "hand off";
}> = [
  // Authenticator pages.
  {
    round: 4,
    name: "authenticator app instruction",
    html: `<form>${appBox}</form>`,
    verdict: "key",
  },
  {
    round: 4,
    name: "six-digit authenticator code",
    html: `<form>${labelled("Enter the 6-digit code from your authenticator app")}</form>`,
    verdict: "key",
  },
  {
    round: 4,
    name: "authenticator, with a Send a code by SMS button",
    // Round 36: two native submitters, one for delivery, so none is pressed.
    html: `<form>${appBox}<button>Send a code by SMS</button></form>`,
    verdict: "hand off",
  },
  {
    round: 7,
    name: "footer Call us beside authenticator instructions",
    html: `<form>${appBox}</form><footer>Call us on 1-800-555-0100.</footer>`,
    verdict: "key",
  },
  {
    round: 8,
    name: "footer SMS support beside authenticator instructions",
    html: `<form>${appBox}</form><footer>SMS support is available around the clock.</footer>`,
    verdict: "key",
  },
  {
    round: 7,
    name: "nav and site-footer text beside authenticator instructions",
    html: `<nav><a href="/">Home</a> Questions? Email us.</nav><main><form>${appBox}</form></main><div class="site-footer">Text STOP to unsubscribe</div>`,
    verdict: "key",
  },
  {
    round: 7,
    name: "unchosen Text me a code option",
    html: `<form><label><input type="radio" name="how" checked> Authenticator app</label><label><input type="radio" name="how"> Text me a code</label>${appBox}</form>`,
    verdict: "key",
  },
  {
    round: 10,
    name: "authenticator code as the field's label",
    html: `<form><label for="c">Authenticator code</label><input id="c" autocomplete="one-time-code"><button>Verify</button></form>`,
    verdict: "key",
  },
  {
    round: 10,
    name: "open your authenticator app, then enter",
    html: `<form>${labelled("Open your authenticator app and enter the code it shows")}</form>`,
    verdict: "key",
  },
  // Delivered codes.
  {
    round: 3,
    name: "texted code",
    html: form("We sent a code by text message to the number ending in 42."),
    verdict: "hand off",
  },
  {
    round: 3,
    name: "emailed code",
    html: form("Enter the code we emailed to d***@example.com."),
    verdict: "hand off",
  },
  {
    round: 3,
    name: "French texted code",
    html: form("Nous avons envoyé un code à votre téléphone."),
    verdict: "hand off",
  },
  {
    round: 3,
    name: "texted code with an authenticator hint",
    html: form("We texted you a code. Or use your authenticator app."),
    verdict: "hand off",
  },
  {
    round: 5,
    name: "a box that only names a phone",
    html: form("Enter the code for your phone."),
    verdict: "hand off",
  },
  {
    round: 6,
    name: "SMS instruction above the form",
    html: `<p>We sent you a code by SMS.</p><form>${appBox}</form>`,
    verdict: "hand off",
  },
  {
    round: 6,
    name: "code from your phone with incidental authenticator wording",
    html: form("Enter the code from your phone. Tip: an authenticator app is safer."),
    verdict: "hand off",
  },
  {
    round: 7,
    name: "authenticatorCode with an SMS placeholder",
    html: `<form><p>Enter the code.</p><input name="authenticatorCode" autocomplete="one-time-code" placeholder="SMS verification code"><button>Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 7,
    name: "authenticatorCode with an Email placeholder",
    html: `<form><p>Enter the code.</p><input name="authenticatorCode" autocomplete="one-time-code" placeholder="Email verification code"><button>Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 7,
    name: "a hidden description naming a phone",
    html: `<form>${labelled("Enter the code from your authenticator app", ' aria-describedby="d"')}<span id="d" hidden>Sent to your phone</span></form>`,
    verdict: "hand off",
  },
  {
    round: 7,
    name: "a phone above a plain form",
    html: `<p>Use the code for your phone.</p><form><p>Enter the code.</p>${box}</form>`,
    verdict: "hand off",
  },
  {
    round: 7,
    name: "a help-page wrapper around a phone",
    html: `<div class="help-page"><form><p>We sent a code to your phone.</p>${box}</form></div>`,
    verdict: "hand off",
  },
  {
    round: 8,
    name: "help-text email line in the form",
    html: `<form>${appBox}<div class="help-text">Use the code from your email.</div></form>`,
    verdict: "hand off",
  },
  {
    round: 8,
    name: "help-text email line after the form",
    html: `<form>${appBox}</form><p class="help-text">Use the code from your email.</p>`,
    verdict: "hand off",
  },
  {
    round: 8,
    name: "a distant notice that a code was just sent",
    html: `<div class="banner">We just sent you a verification code.</div><div></div><div></div><div></div><main><section><div><form>${appBox}</form></div></section></main>`,
    verdict: "hand off",
  },
  {
    round: 8,
    name: "a new code has been sent",
    html: `<p>A new code has been sent.</p><form>${appBox}</form>`,
    verdict: "hand off",
  },
  {
    round: 9,
    name: "recovery address with authenticator help",
    html: `<form><p>Enter the code delivered to your recovery address.</p>${box}<p>Having trouble with your authenticator app?</p></form>`,
    verdict: "hand off",
  },
  {
    round: 10,
    name: "a backup address",
    html: form("Enter the code we sent to your backup address."),
    verdict: "hand off",
  },
  {
    round: 10,
    name: "authenticator instruction beside a recovery address",
    html: `<form>${labelled("Enter the code from your authenticator app or the one delivered to your recovery address")}</form>`,
    verdict: "hand off",
  },
  // No affirmative instruction.
  {
    round: 4,
    name: "a generic code box",
    html: form("Enter the code."),
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 4,
    name: "a generic verification code",
    html: form("Enter the verification code."),
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 5,
    name: "hidden authenticator text",
    html: `<form><p>Enter the code.</p><p hidden>Use your authenticator app.</p>${box}</form>`,
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 5,
    name: "an aside tip naming an authenticator",
    html: `<aside>Tip: an authenticator app keeps you safe.</aside><form><p>Enter the code.</p>${box}</form>`,
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 7,
    name: "authenticatorCode by name and id only",
    html: `<form><p>Enter the code.</p><input name="authenticatorCode" id="authenticatorCode" autocomplete="one-time-code"><button>Verify</button></form>`,
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 9,
    name: "only help about an authenticator",
    html: `<form><p>Enter the code.</p>${box}<p>Having trouble with your authenticator app?</p></form>`,
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 9,
    name: "a help link about an authenticator",
    html: `<form><p>Enter the code.</p>${box}<a href="/help">Use your authenticator app to get a code</a></form>`,
    verdict: "hand off",
  },
  {
    round: 10,
    name: "authenticator named only as an alternative",
    html: form("Enter the code. If you can't get it, set up an authenticator app."),
    verdict: "hand off",
  },
  {
    round: 11,
    name: "a generic box whose description explains the authenticator's code",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" aria-describedby="about"><p id="about">The code from your authenticator app changes every 30 seconds.</p><button>Verify</button></form>`,
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 11,
    name: "one box for a backup code or the authenticator's",
    html: form("Enter a backup code or the code from your authenticator app."),
    verdict: "hand off",
  },
  {
    round: 11,
    name: "authenticator box with a distant paragraph about SMS support",
    html: `<main><form>${appBox}</form><div>Account</div><div>Billing</div><div>Settings</div><section><p>Our SMS support line answers account questions.</p></section></main>`,
    verdict: "key",
  },
  {
    round: 11,
    name: "authenticator wording under a channel-less code-on-its-way banner",
    html: `<div class="banner">A code is on its way.</div><div></div><div></div><div></div><main><section><div><form>${appBox}</form></div></section></main>`,
    verdict: "hand off",
  },
  {
    round: 11,
    name: "an authenticator explained in prose, not asked for",
    html: form("Your authenticator app shows a new code every 30 seconds."),
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 11,
    name: "an authenticator named in the field's title only",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" title="Code from your authenticator app"><button>Verify</button></form>`,
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 12,
    name: "authenticator instructions only in a paragraph near the field",
    html: form("Enter the code from your authenticator app."),
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 12,
    name: "a generic box beside another form's authenticator label",
    html: `<form><p>Enter the code.</p>${box}</form><form><label for="other">Code from your authenticator app</label><input id="other" name="nickname"></form>`,
    verdict: "hand off",
  },
  {
    round: 12,
    name: "a generic box beside another field's imperative label",
    html: `<form><label for="other">Enter the code from your authenticator app</label><input id="other" name="nickname"><p>Enter the code.</p>${box}</form>`,
    verdict: "hand off",
  },
  {
    round: 12,
    name: "a German either/or of the authenticator and a backup code",
    html: `<form>${labelled("Geben Sie entweder den Code aus Ihrer Authenticator-App oder einen Backup-Code ein")}</form>`,
    verdict: "hand off",
  },
  {
    round: 12,
    name: "an authenticator label with a second sentence offering a backup code",
    html: `<form>${appBox}<p>You can also use a backup code.</p></form>`,
    verdict: "hand off",
  },
  {
    round: 12,
    name: "two code boxes on the page",
    html: `<form>${appBox}<input name="otp2" autocomplete="one-time-code"></form>`,
    verdict: "hand off",
  },
  {
    round: 12,
    name: "an authenticator box beside a second form",
    html: `<form role="search"><input name="q" type="search"></form><form>${appBox}</form>`,
    verdict: "hand off",
  },
  {
    round: 13,
    name: "a second box named only by its own label",
    html: `<form>${appBox}<label for="second">Verification code</label><input id="second" name="second"></form>`,
    verdict: "hand off",
  },
  {
    round: 13,
    name: "a stale accessible label against the visible one",
    html: `<form><label for="code">Enter the verification code</label><input id="code" autocomplete="one-time-code" aria-label="Code from your authenticator app"><button>Verify</button></form>`,
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 14,
    name: "a second box named only through aria-labelledby",
    html: `<form>${appBox}<span id="second-name">Verification code</span><input aria-labelledby="second-name" name="second"></form>`,
    verdict: "hand off",
  },
  {
    round: 14,
    name: "a rendered label hidden from assistive tech, against an authenticator name",
    html: `<form><label for="code" aria-hidden="true">Enter the verification code</label><input id="code" autocomplete="one-time-code" aria-label="Code from your authenticator app"><button>Verify</button></form>`,
    verdict: "hand off",
    saved: "key",
  },
  // With a saved key: a plain box, unless the run spoke of a delivered code.
  {
    round: 22,
    name: "SMS chosen on an earlier screen, then a generic 6-digit box",
    earlier: `<form><p>How should we send your code?</p><label><input type="radio" name="via" checked> Text message</label><label><input type="radio" name="via"> Email</label><button>Send code</button></form>`,
    html: form("Enter the 6-digit code."),
    verdict: "hand off",
  },
  {
    round: 22,
    name: "a sent screen earlier, then a generic box",
    earlier: `<p>We sent a code to your phone.</p><form><button>Continue</button></form>`,
    html: form("Enter the code."),
    verdict: "hand off",
  },
  {
    round: 22,
    name: "a choice of an email code earlier, then a generic box",
    earlier: `<form><p>Verify it's you</p><button>Email me a code</button><button>Use my authenticator app</button></form>`,
    html: form("Enter the code."),
    verdict: "hand off",
  },
  {
    round: 22,
    name: "a password page earlier, then a generic 6-digit box",
    earlier: `<form><input name="user"><input type="password" name="password"><button>Sign in</button></form>`,
    html: form("Enter the 6-digit code."),
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 22,
    name: "a generic box with a link to resend it by SMS",
    html: `${form("Enter the 6-digit code.")}<p><a href="/resend">Resend the code by SMS</a></p>`,
    verdict: "hand off",
  },
  {
    round: 22,
    name: "a generic box in one of two forms",
    html: `<form role="search"><input name="q" type="search"></form>${form("Enter the code.")}`,
    verdict: "hand off",
  },
  // Round 23: cues the plain box missed, and fields for other data.
  {
    round: 23,
    name: "a generic box asking whether the code arrived",
    html: `${form("Enter the code.")}<p>Didn't receive your code? <a href="/resend">Send it again</a></p>`,
    verdict: "hand off",
  },
  {
    round: 23,
    name: "a generic box with a Resend code button",
    html: `<form><p>Enter the code.</p>${box}<button type="button">Resend code</button></form>`,
    verdict: "hand off",
  },
  {
    round: 23,
    name: "a generic box with a Use a backup code button",
    html: `<form><p>Enter the code.</p>${box}<button type="button">Use a backup code</button></form>`,
    verdict: "hand off",
  },
  {
    round: 23,
    name: "a Text me a code submit input earlier, then a generic box",
    earlier: `<form><p>Verify it's you</p><input type="submit" value="Text me a code"></form>`,
    html: form("Enter the code."),
    verdict: "hand off",
  },
  {
    round: 23,
    name: "a labelled postal-code field",
    html: `<form><label for="zip">Postal code</label><input id="zip" autocomplete="postal-code" inputmode="numeric" maxlength="6"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  {
    round: 23,
    name: "a numeric birth-date field",
    html: `<form><label for="dob">Date of birth</label><input id="dob" inputmode="numeric" maxlength="8"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  {
    round: 23,
    name: "a plain box with no word of a code, first in the run",
    html: form("Enter it below."),
    verdict: "hand off",
  },
  {
    round: 23,
    name: "a plain box with no word of a code, after the password",
    earlier: `<form><input name="user"><input type="password" name="password"><button>Sign in</button></form>`,
    html: form("Enter it below."),
    verdict: "hand off",
    saved: "key",
  },
  // Round 24: the box itself must say it takes a code, and nothing names other data.
  {
    round: 24,
    name: "a Birthdate field after the password",
    earlier: `<form><input name="user"><input type="password" name="password"><button>Sign in</button></form>`,
    html: `<form><label for="birthdate">Birthdate</label><input id="birthdate" inputmode="numeric" maxlength="8"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  {
    round: 24,
    name: "a Customer PIN field under Verify your identity",
    html: `<h1>Verify your identity</h1><form><label for="pin">Customer PIN</label><input id="pin" inputmode="numeric" maxlength="6"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  {
    round: 24,
    name: "a box whose own words name no code, after the password",
    earlier: `<form><input name="user"><input type="password" name="password"><button>Sign in</button></form>`,
    html: `<form><p>Enter your code.</p><input inputmode="numeric" maxlength="6"><button>Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 24,
    name: "a generic box beside an icon-only backup-code link",
    html: `${form("Enter the code.")}<span role="link" tabindex="0" aria-label="Use a backup code" style="display:inline-block;width:16px;height:16px"></span>`,
    verdict: "hand off",
  },
  {
    round: 24,
    name: "a generic box with a resend button named by aria-labelledby",
    html: `<form><p>Enter the code.</p>${box}<span id="again" hidden>Resend code</span><button type="button" aria-labelledby="again" style="width:16px;height:16px"></button></form>`,
    verdict: "hand off",
  },
  {
    round: 24,
    name: "a PIN code field",
    html: `<form><p>Enter the code.</p><label for="pin">PIN code</label><input id="pin" inputmode="numeric" maxlength="6"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  {
    round: 24,
    name: "a field named zipCode",
    html: `<form><p>Enter the code.</p><input name="zipCode" inputmode="numeric" maxlength="6"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  // Round 25: a request for a code in any words, and purposes however they are written.
  {
    round: 25,
    name: "a generic box with a Send a new verification code button",
    html: `<form><p>Enter the code.</p>${box}<button type="button">Send a new verification code</button></form>`,
    verdict: "hand off",
  },
  {
    round: 25,
    name: "a generic box with a Get another code link",
    html: `${form("Enter the code.")}<p><a href="/again">Get another code</a></p>`,
    verdict: "hand off",
  },
  {
    round: 25,
    name: "an Account number field, spaced with a no-break space, after the password",
    earlier: `<form><input name="user"><input type="password" name="password"><button>Sign in</button></form>`,
    html: `<form><label for="code">Account\u00a0number</label><input id="code" name="code" inputmode="numeric" maxlength="8"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  {
    round: 25,
    name: "an Account # field after the password",
    earlier: `<form><input name="user"><input type="password" name="password"><button>Sign in</button></form>`,
    html: `<form><label for="code">Account #</label><input id="code" name="code" inputmode="numeric" maxlength="8"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  {
    round: 25,
    name: "an Account \uff03 field (a fullwidth number sign) after the password",
    earlier: `<form><input name="user"><input type="password" name="password"><button>Sign in</button></form>`,
    html: `<form><label for="code">Account \uff03</label><input id="code" name="code" inputmode="numeric" maxlength="8"><button>Continue</button></form>`,
    verdict: "hand off",
  },
  // Round 26: a control whose short name asks for a code.
  {
    round: 26,
    name: "a generic box with a standalone Get code button",
    html: `<form><p>Enter the code.</p>${box}<button type="button">Get code</button></form>`,
    verdict: "hand off",
  },
  {
    round: 26,
    name: "a Get code button earlier, then a generic box",
    earlier: `<form><p>Verify it's you</p><button>Get code</button></form>`,
    html: form("Enter the code."),
    verdict: "hand off",
  },
  {
    round: 27,
    name: "a generic box with an icon before Get code",
    html: `<form><p>Enter the code.</p>${box}<button type="button"><span aria-hidden="true">⟳</span> Get code</button></form>`,
    verdict: "hand off",
  },
  {
    round: 27,
    name: "a generic box with a Get code button whose label repeats a longer name",
    html: `<form><p>Enter the code.</p>${box}<button type="button" aria-label="Get a verification code">Get a verification code</button></form>`,
    verdict: "hand off",
  },
  // Round 28: any control but the code's own submit that names a code.
  {
    round: 28,
    name: "a generic box with a Click here to get a code link",
    html: `${form("Enter the code.")}<p><a href="/get">Click here to get a code</a></p>`,
    verdict: "hand off",
  },
  {
    round: 28,
    name: "a generic box whose own submit says Verify code",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button>Verify code</button></form>`,
    verdict: "hand off",
    saved: "key",
  },
  {
    round: 28,
    name: "a generic box with a Need help with your code? link",
    html: `${form("Enter the code.")}<p><a href="/help">Need help with your code?</a></p>`,
    verdict: "hand off",
  },
  // Round 29: one unambiguous submit, and controls as Chromium names them.
  {
    round: 29,
    name: "a generic box with Get code before Verify in the same form",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button>Get code</button><button>Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 29,
    name: "a generic box beside a menu item named Get a new code",
    html: `${form("Enter the code.")}<div role="menu"><div role="menuitem" tabindex="0" aria-label="Get a new code" style="display:inline-block;width:16px;height:16px"></div></div>`,
    verdict: "hand off",
  },
  {
    round: 29,
    name: "a generic box beside a button named by its image's alt",
    html: `${form("Enter the code.")}<div><button type="button"><img alt="Resend code" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></button></div>`,
    verdict: "hand off",
  },
  {
    round: 29,
    name: "a generic box whose form has Verify and Cancel buttons",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button><button type="button">Cancel</button></form>`,
    verdict: "hand off",
  },
  // Round 30: a real form that owns the box, and a submit that doesn't itself ask for a code.
  {
    round: 30,
    name: "a form-less dialog with one Verify, beside another page button",
    html: `<div role="dialog"><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></div><button>Continue</button>`,
    verdict: "hand off",
  },
  {
    round: 30,
    name: "a generic box whose form's one submit is Get code",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button>Get code</button></form>`,
    verdict: "hand off",
  },
  // Round 31: the submit's own name as Chromium computes it, and every control the form owns.
  {
    round: 31,
    name: "a generic box whose one submit is an image named Get code",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><input type="image" alt="Get code" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></form>`,
    verdict: "hand off",
  },
  {
    round: 31,
    name: "a generic box whose one submit is named only by its image's alt, Get code",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button><img alt="Get code" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></button></form>`,
    verdict: "hand off",
  },
  {
    round: 31,
    name: "a generic box whose form owns a second button from outside it",
    html: `<form id="verify"><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form><button form="verify" type="button">Cancel</button>`,
    verdict: "hand off",
  },
  // Round 32: form ownership as the DOM has it.
  {
    round: 32,
    name: "a generic box with Verify and an external image submit owned by its form",
    html: `<form id="verify"><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></form><input type="image" form="verify" alt="Continue" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">`,
    verdict: "hand off",
  },
  {
    round: 32,
    name: "a generic box whose one button inside belongs to another, hidden form",
    html: `<form><p>Enter the code.</p><input autocomplete="one-time-code" inputmode="numeric"><button form="other">Verify</button></form><form id="other" hidden></form>`,
    verdict: "hand off",
  },
  // Round 33: every key path submits through the field's own form, or not at all.
  {
    round: 33,
    name: "authenticator instructions in a dialog with no form",
    html: `<div role="dialog">${appBox}</div>`,
    verdict: "hand off",
  },
  // Round 35: only the person's own press, an enabled native submitter of the field's form.
  {
    round: 35,
    name: "authenticator instructions whose only Verify is disabled",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button disabled>Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 35,
    name: "a generic box in a GET form whose only Verify is a custom control",
    html: `<form><p>Enter the code.</p><input name="code" autocomplete="one-time-code" inputmode="numeric"><div role="button" tabindex="0">Verify</div></form>`,
    verdict: "hand off",
  },
  // Round 36: one usable native submitter, as the platform tells usable, and not for delivery.
  {
    round: 36,
    name: "authenticator instructions whose Verify is in a disabled fieldset",
    html: `<form><fieldset disabled><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button>Verify</button></fieldset></form>`,
    verdict: "hand off",
  },
  {
    round: 36,
    name: "authenticator instructions whose Verify is collapsed to no size",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button style="width:0;height:0;padding:0;border:0;overflow:hidden">Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 36,
    name: "authenticator instructions whose Verify is inert",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><div inert><button>Verify</button></div></form>`,
    verdict: "hand off",
  },
  {
    round: 36,
    name: "authenticator instructions with an SMS submit before Verify",
    html: `<form action="/verify" method="post"><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button formaction="/sms">Text me instead</button><button>Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 36,
    name: "authenticator instructions whose field is fully transparent",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric" style="opacity:0"><button>Verify</button></form>`,
    verdict: "hand off",
  },
  // Round 37: CSS inertness, and a submitter for delivery by any name Chromium knows or its action.
  {
    round: 37,
    name: "authenticator instructions whose Verify is CSS-inert",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button style="interactivity:inert">Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 37,
    name: "authenticator instructions whose Verify sits under pointer-events: none",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><div style="pointer-events:none"><button>Verify</button></div></form>`,
    verdict: "hand off",
  },
  {
    round: 37,
    name: "authenticator instructions whose field is CSS-inert",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric" style="interactivity:inert"><button>Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 37,
    name: "authenticator instructions whose one submit is Get a new code",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button>Get a new code</button></form>`,
    verdict: "hand off",
  },
  {
    round: 37,
    name: "authenticator instructions whose one submit is named Resend by SMS through aria-labelledby",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><span id="again" hidden>Resend by SMS</span><button aria-labelledby="again">Go</button></form>`,
    verdict: "hand off",
  },
  {
    round: 37,
    name: "authenticator instructions whose one submit is named only by its image's alt, Resend by SMS",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button><img alt="Resend by SMS" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></button></form>`,
    verdict: "hand off",
  },
  {
    round: 38,
    name: "authenticator instructions whose one submit is an aria-hidden icon whose image says Resend by SMS",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button aria-hidden="true"><img alt="Resend by SMS" width="16" height="16" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E"></button></form>`,
    verdict: "hand off",
  },
  {
    round: 38,
    name: "authenticator instructions whose one submit is an aria-hidden Verify",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button aria-hidden="true">Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 38,
    name: "authenticator instructions whose one submit is an unnamed icon",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button><svg width="16" height="16"></svg></button></form>`,
    verdict: "hand off",
  },
  {
    round: 38,
    name: "authenticator instructions whose one submit is named Go",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button>Go</button></form>`,
    verdict: "hand off",
  },
  {
    round: 38,
    name: "authenticator instructions whose Verify Chromium names Go Verify, from CSS content",
    html: `<style>.go::before{content:"Go "}</style><form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button class="go">Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 40,
    name: "authenticator instructions whose Verify has the title WhatsApp",
    html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button title="WhatsApp">Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 40,
    name: "authenticator instructions whose Verify Chromium names Verify via Telegram, from CSS content",
    html: `<style>.via::after{content:" via Telegram"}</style><form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button class="via">Verify</button></form>`,
    verdict: "hand off",
  },
  {
    round: 41,
    name: "a code box labelled as a Viber code",
    html: `<form>${labelled("Enter your Viber code")}</form>`,
    verdict: "hand off",
  },
  // Where a lone Verify sends, from the form or its own formaction: a delivery or a request for a
  // code is refused; a verify address with a code word isn't.
  ...[
    { round: 37, action: "/sms" },
    { round: 38, action: "/mfa/resend_otp" },
    { round: 38, action: "/mfa/sendSmsCode" },
    { round: 38, action: "/mfa/%73ms" },
    { round: 39, action: "/mfa/request-new-code" },
    { round: 40, action: "/mfa/WhatsApp" },
    { round: 40, action: "/mfa/requestnewcode" },
    { round: 39, action: "/mfa/verify-code", verdict: "key" as const },
    { round: 41, action: "/oauth/callback", verdict: "key" as const },
    { round: 41, action: "/mfa/verify?context=signin", verdict: "key" as const },
  ].flatMap(({ round, action, verdict = "hand off" as const }) => [
    {
      round,
      name: `authenticator instructions whose Verify inherits the form's ${action} action`,
      html: `<form action="${action}" method="post">${appBox}</form>`,
      verdict,
    },
    {
      round,
      name: `authenticator instructions whose Verify posts to ${action} through formaction`,
      html: `<form><label for="code">Enter the code from your authenticator app</label><input id="code" autocomplete="one-time-code" inputmode="numeric"><button formaction="${action}">Verify</button></form>`,
      verdict,
    },
  ]),
];

// Read as the server browser reads it: in the accounts world, with Chromium's control names.
const withReader = async (
  run: (read: (html: string) => Promise<SignInDetection>) => Promise<void>,
) => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    let body = "";
    await page.route("https://**/*", (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body }),
    );
    await run(async (html) => {
      body = html;
      await page.goto("https://login.example.com/verify");
      return decode(
        await accountsWorldEvaluation(
          cdp,
          { expression: signInDetectionScript, world: "accounts" },
          5_000,
        ),
      );
    });
  } finally {
    await browser.close();
  }
};

it("answers every reviewed code box as the contract says", async () => {
  await withReader(async (read) => {
    const wrong: string[] = [];
    for (const { name, html, earlier, verdict, saved = verdict } of cases) {
      // The run's cue: any page of it, this one included, speaking of a delivered code; and
      // whether it came after the password.
      const before = earlier === undefined ? undefined : await read(earlier);
      const cue = before?.codeCue === true;
      const seen = await read(html);
      expect(seen.otp, name).not.toBeNull();
      // A key goes only into a field with a form of its own, whatever its evidence.
      const vetoed =
        seen.otpDelivery === true ||
        seen.otpSent !== undefined ||
        seen.otpNoForm === true ||
        seen.otpNoSubmit === true ||
        seen.otpUnusable === true;
      const key = !vetoed && seen.otpApp === true;
      const challenge = seen.otpContext === true || (before?.password ?? null) !== null;
      const plain = !vetoed && seen.otpOnly === true && challenge && !cue && seen.codeCue !== true;
      if ((key ? "key" : "hand off") !== verdict) wrong.push(`${name}: expected ${verdict}`);
      if ((key || plain ? "key" : "hand off") !== saved)
        wrong.push(`${name}: with a saved key, expected ${saved}`);
    }
    expect(wrong).toEqual([]);
  });
});

it("refuses every delivery channel alike in the field, the submitter's names and action, and Chromium's name", async () => {
  await withReader(async (read) => {
    const admitted: string[] = [];
    for (const channel of DELIVERY_CHANNELS) {
      const field = await read(`<form>${labelled(`Enter your ${channel} code`)}</form>`);
      if (field.otpDelivery !== true) admitted.push(`field: ${channel}`);
      const pages = {
        title: `<form>${appBox.replace("<button>", `<button title="${channel}">`)}</form>`,
        action: `<form action="/mfa/${channel}" method="post">${appBox}</form>`,
        chromium: `<style>.via::after{content:" via ${channel}"}</style><form>${appBox.replace("<button>", '<button class="via">')}</form>`,
      };
      for (const [where, html] of Object.entries(pages))
        if ((await read(html)).otpNoSubmit !== true) admitted.push(`${where}: ${channel}`);
    }
    expect(admitted).toEqual([]);
  });
});
