import {
  FORGET_SIGN_IN_LABEL,
  PASSWORD_REFUSED_TEXT,
  REMEMBER_SIGN_IN_LABEL,
  SITE_LIMITED_TEXT,
} from "@t3tools/shared/scientSignInPage";
import { loginFieldsKitSource } from "@t3tools/shared/scientLoginFields";
import { AccountHandoff } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const SignInDetection = Schema.Struct({
  origin: Schema.String,
  /** The whole address, where the path tells a finished sign-in from its start. */
  url: Schema.optional(Schema.String),
  username: Schema.NullOr(Schema.String),
  password: Schema.NullOr(Schema.String),
  otp: Schema.NullOr(Schema.String),
  /** The page says the code for `otp` was texted or mailed: no authenticator key answers it. */
  otpSent: Schema.optional(Schema.Literals(["text", "email"])),
  /** This challenge names an authenticator app: the saved key's code is the one it asks for. */
  otpApp: Schema.optional(Schema.Literal(true)),
  /**
   * The page's one code-like field, in its one form or dialog, with no veto and no other way
   * offered: a login with a saved key may answer it by itself, unless the run saw `codeCue`.
   */
  otpOnly: Schema.optional(Schema.Literal(true)),
  /** The code field belongs to no form: no key goes in, since it could only be sent another way. */
  otpNoForm: Schema.optional(Schema.Literal(true)),
  /**
   * Its form owns no single usable native submitter to press (none, several, or one for
   * delivery): no key goes in either.
   */
  otpNoSubmit: Schema.optional(Schema.Literal(true)),
  /** The code field itself isn't usable (disabled, inert, unseen or of no size): no key goes in. */
  otpUnusable: Schema.optional(Schema.Literal(true)),
  /** The field's words, its challenge or the instructions around it speak of a code. */
  otpContext: Schema.optional(Schema.Literal(true)),
  /**
   * The page, outside its frame, says a code was sent, offers or names a phone, a text or a mail
   * while it speaks of a code, asks whether the code arrived, or offers another way or method: a
   * delivered code may be on its way, here or on a later page.
   */
  codeCue: Schema.optional(Schema.Literal(true)),
  /**
   * The field's words, its challenge or the instructions above it speak of a phone, a text or a
   * mail, or the page says a code was sent: no key goes in by itself.
   */
  otpDelivery: Schema.optional(Schema.Literal(true)),
  /**
   * The code field and its container as element instances of this page load, read in Scient's
   * isolated world: the same element whatever its words or selector, a replacement a new one.
   */
  otpBox: Schema.optional(Schema.String),
  /** The code field's own instance and its container's, which a fill finds and checks them by. */
  otpField: Schema.optional(Schema.String),
  otpContainer: Schema.optional(Schema.String),
  /** The submit button's instance, so a replacement that takes over its selector is told apart. */
  submitInstance: Schema.optional(Schema.String),
  submit: Schema.NullOr(Schema.String),
  challenge: Schema.NullOr(Schema.Literals(["captcha", "passkey", "push"])),
  number: Schema.optional(Schema.String),
  /** A passkey prompt that asks for a hardware key, or a code the site texted. */
  via: AccountHandoff.fields.via,
  remember: Schema.optional(Schema.String),
  stay: Schema.optional(Schema.String),
  signInLink: Schema.optional(Schema.String),
  anotherWay: Schema.optional(Schema.String),
  limited: Schema.optional(Schema.Boolean),
  broken: Schema.optional(Schema.Boolean),
  /** Nothing shows: no text and no control. A CAPTCHA box on it is not a check to solve. */
  blank: Schema.optional(Schema.Boolean),
  /** The form is back saying it refused the password: for the person's card only. */
  refused: Schema.optional(Schema.Boolean),
  /** The organization admits the account only from a managed or compliant device. */
  managedDevice: Schema.optional(Schema.Boolean),
  accountChoices: Schema.optional(
    Schema.Array(Schema.Struct({ email: Schema.String, selector: Schema.String })),
  ),
  signedIn: Schema.Boolean,
  /** This page load's start (`performance.timeOrigin`): a new load is the site's answer. */
  document: Schema.optional(Schema.Number),
});
export type SignInDetection = typeof SignInDetection.Type;

/**
 * The name of a button that sends a code as the person would: Verify, Submit, Continue and the
 * like, in the languages detection reads. Positive evidence, as for the field: no other name is
 * pressed. Matched lowercase, after NFKC and space folding.
 */
export const VERIFY_NAME =
  /^(please |veuillez |por favor |bitte |per favore )?(verify|submit|continue|next|confirm|sign in|log in|login|ok|done|authenticate|vérifier|valider|continuer|suivant|confirmer|se connecter|connexion|verificar|continuar|siguiente|confirmar|iniciar sesión|acceder|bestätigen|weiter|anmelden|überprüfen|prüfen|fortfahren|verifica|continua|avanti|conferma|accedi|אמת|אישור|המשך|כניסה|התחבר)(?=$|[\s.!:,…])/u;

/**
 * The channels a code is delivered by, one vocabulary for the code field's delivery veto, the
 * submitter's delivery veto (names and action) and Chromium's name check on the server.
 */
export const DELIVERY_CHANNELS = [
  "sms",
  "mms",
  "text",
  "texts",
  "texted",
  "texting",
  "email",
  "emails",
  "mail",
  "call",
  "phone",
  "voice",
  "whatsapp",
  "telegram",
  "signal",
  "viber",
  "push",
];

/** A page-script function naming an element by its place in the document, as a CSS selector. */
const elementPathSource = String.raw`(element) => {
    if (!element) return null;
    const parts = [];
    let current = element;
    while (current && current !== document.documentElement) {
      const index = Array.from(current.parentElement.children).filter(child => child.tagName === current.tagName).indexOf(current) + 1;
      parts.unshift(current.tagName.toLowerCase() + ":nth-of-type(" + index + ")");
      current = current.parentElement;
    }
    return "html > " + parts.join(" > ");
  }`;

export const signInDetectionScript = String.raw`(() => {
  const login = ${loginFieldsKitSource};
  const visible = login.visible;
  // Text as it is matched: compatibility forms folded (NFKC), every kind of space a plain one.
  const norm = (value) => String(value ?? "").normalize("NFKC").replace(/[\s\u200b]+/g, " ").trim();
  const referenced = (ids) => norm((ids ?? "").split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "").join(" "));
  const path = ${elementPathSource};
  // Sign-up and change-password pages ask for a password too; a saved one must not go there.
  const fields = login.collect(Array.from(document.querySelectorAll("input")), { refuseNewPasswordPage: true });
  const password = fields.inputs[fields.password];
  const otp = fields.inputs[fields.otp];
  const username = fields.inputs[fields.username];
  const form = (password ?? otp ?? username)?.form;
  // Every control that can submit the code's own form: the plain box needs a real form and exactly
  // one, which is then the one Scient presses, so it can't press, or excuse, the wrong one.
  // Owned as the DOM owns them: a native control's .form, which honours form="…" (an image submit
  // outside the form counts; a button inside it owned by another form doesn't), and role=button
  // elements inside the form, which have no form of their own.
  const submitters = (field) => {
    const owner = field.form;
    if (!owner) return [];
    const native = Array.from(document.querySelectorAll("button, input[type=submit], input[type=image], input[type=button], input[type=reset]")).filter((element) => element.form === owner);
    const roles = Array.from(owner.querySelectorAll("[role=button]")).filter((element) => !(element instanceof HTMLButtonElement || element instanceof HTMLInputElement));
    return [...native, ...roles].filter(visible);
  };
  const codeSubmits = otp ? submitters(otp) : [];
  // Usable as the platform says: not :disabled (a disabled fieldset included), rendered and seen
  // (checkVisibility, opacity and visibility too), not inert, with a box of some size.
  const usable = (element) => {
    const box = element.getBoundingClientRect();
    // Both inherit, so the element's own computed style tells an ancestor's too.
    const style = getComputedStyle(element);
    return !element.matches(":disabled") && !element.closest("[inert]") && box.width > 0 && box.height > 0 &&
      style.pointerEvents !== "none" && style.getPropertyValue("interactivity") !== "inert" &&
      (typeof element.checkVisibility !== "function" || element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const nativeSubmitter = (element) => element instanceof HTMLInputElement ? /^(submit|image)$/i.test(element.type) : element instanceof HTMLButtonElement && element.type === "submit";
  // A submitter for delivery (a text, a mail, a call, a resend) or a request for a code ("Get a new
  // code"), by its names, the text its aria-labelledby names, or where it sends: its own formaction,
  // or the form's action when it has none (formAction alone gives the page's address). Each is read
  // word by word, decoded and split at compounds: "/mfa/resend_otp", "sendSMSCode", "%73ms".
  const tokensOf = (value) => {
    let text = String(value ?? "");
    try { text = decodeURIComponent(text); } catch {}
    return norm(text).replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  };
  // Word by word and, so a split brand ("WhatsApp") or a run-together compound ("requestnewcode")
  // still counts, in the words joined without separators.
  // Words whole, so "callback" and "context" are no call or text; a split brand ("WhatsApp") or a
  // run-together request ("requestnewcode", "resendCode") counts across adjacent words.
  const channels = new Set(${JSON.stringify(DELIVERY_CHANNELS)});
  const compound = /^(whatsapp|resend|(request|get|send|resend)(me)?(a|an|the|my)?(new|another)?(verification|security|login|signin|onetime)?(code|codes|otp|pin|passcode)|(new|another)(verification|security|login|signin|onetime)?(code|codes|otp|pin|passcode)|(code|codes|otp|pin|passcode)(again|request|resend))$/;
  const sendsOrRequests = (tokens) => {
    const spans = tokens.flatMap((_, start) => [1, 2, 3, 4].map((size) => tokens.slice(start, start + size).join("")));
    return tokens.some((token) => channels.has(token) || /^(resend|send)$/.test(token)) ||
      (tokens.some((token) => /^(code|codes|otp|pin|passcode|verification|2fa)$/.test(token)) && tokens.some((token) => /^(send|resend|request|get|new|another|again)$/.test(token))) ||
      spans.some((span) => compound.test(span));
  };
  const forDelivery = (element) => {
    const names = [element.innerText, element.value, element.title, element.alt, element.getAttribute("aria-label"), referenced(element.getAttribute("aria-labelledby"))];
    const action = element.hasAttribute("formaction") ? element.formAction : element.form?.action;
    return sendsOrRequests(names.flatMap(tokensOf)) || sendsOrRequests(tokensOf(action));
  };
  // Its name as a person reads it, the way the platform computes it, which must be a verify word.
  const verifies = (element) => new RegExp(${JSON.stringify(VERIFY_NAME.source)}, "u").test(norm(referenced(element.getAttribute("aria-labelledby")) || element.getAttribute("aria-label") || element.innerText || element.value || element.alt || "").toLowerCase());
  // A code is sent only as the person would send it: by pressing the one usable native submitter
  // its field's own form owns, never the first of several, named to verify, never for delivery.
  const sendable = (field) => {
    const natives = submitters(field).filter((element) => nativeSubmitter(element) && usable(element));
    return natives.length === 1 && verifies(natives[0]) && !forDelivery(natives[0]) ? natives[0] : undefined;
  };
  const submit = otp
    ? sendable(otp)
    : Array.from((form ?? document).querySelectorAll("button, input[type=submit]")).find(element => visible(element) && !element.hasAttribute("disabled") && (element instanceof HTMLInputElement || element.type === "submit"));
  const text = document.body?.innerText ?? "";
  const rememberLabel = new RegExp(${JSON.stringify(REMEMBER_SIGN_IN_LABEL)}, "i");
  const forgetLabel = new RegExp(${JSON.stringify(FORGET_SIGN_IN_LABEL)}, "i");
  const remember = login.rememberBox(Array.from((form ?? document).querySelectorAll("input[type=checkbox]")), rememberLabel, forgetLabel, true);
  // Visible text only, of root, a line per block; skip(element) leaves out an element and its text.
  const blockOf = "p, li, label, legend, h1, h2, h3, h4, h5, h6, td, th, dt, dd, div, section, form, fieldset, dialog, [role=heading]";
  const visibleLines = (root, skip) => {
    const lines = [];
    let block;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !visible(parent) || parent.closest("script, style, [aria-hidden=true]")) continue;
      if (skip && skip(parent)) continue;
      const here = parent.closest(blockOf);
      if (here !== block || lines.length === 0) lines.push("");
      block = here;
      lines[lines.length - 1] += " " + (node.textContent ?? "");
    }
    return lines.map(norm).filter(Boolean);
  };
  const visibleText = (root, skip) => visibleLines(root, skip).join(" ");
  // Not this challenge's words: other ways to get a code (links, buttons, menus, an option not
  // chosen), and, outside its container, the page's frame (navigation, footer, asides). Help and
  // instruction text near the field, whatever its class, is the field's.
  const alternatives = "a, button, select, [role=button], [role=link], [role=menuitem]";
  const frameOf = "nav, footer, aside, [role=navigation], [role=contentinfo], [role=complementary], [class*=footer i], [id*=footer i]";
  const unchosen = (element) => {
    const choice = element.closest("label, [role=radio], [role=option], [role=tab]");
    if (!choice) return false;
    if (choice.matches("[role=radio], [role=option], [role=tab]"))
      return choice.getAttribute("aria-checked") !== "true" && choice.getAttribute("aria-selected") !== "true";
    const input = choice.control ?? choice.querySelector("input");
    return !!input && (input.type === "radio" || input.type === "checkbox") && !input.checked;
  };
  const another = (element) => !!element.closest(alternatives) || unchosen(element);
  // A sent-code notice is the page saying a code was or is being sent: "We texted you a code", "A
  // code is on its way". A phone, a text or a mail, a recovery address: delivery.
  const sentEvent = /\b(we('ve| have| just)?|has been|have been|was|were|is being|just) (just )?(sent|texted|emailed|mailed|delivered)\b|\bsent (you |to )|\bsent (a|an|the|your) (new )?(\d-digit )?(verification |security |sign-in |login |one-time )?(code|text|sms|message|e-?mail)\b|\bcode sent\b|\bon (its|the) way\b|\bwe('re| are) sending\b|\bcheck your (inbox|e-?mail|phone|messages|texts)\b|envoy[ée]|enviado|gesendet|inviato|נשלח/i;
  const channelWord = new RegExp("\\b(" + [...channels].join("|") + ")\\b", "i");
  const deliveryElse = /\b(e-?mail|e-?mailed|inbox|mobile|cell|recovery|delivered)\b|backup (address|e-?mail|phone|number)|(alternate|secondary) (address|e-?mail|phone|number)|sent to|we sent|texto|t[ée]l[ée]phone|portable|courriel|envoy[ée]|tel[ée]fono|m[óo]vil|celular|correo|mensaje|enviado|telefon|handy|gesendet|nachricht|telefone|inviato|cellulare|messaggio|טלפון|נייד|מייל|דוא"ל|נשלח|הודעה|ס"מס/i;
  const delivery = { test: (text) => channelWord.test(text) || deliveryElse.test(text) };
  const codeWord = /\b(code|codes|passcode|verification|verify|one-time|2-step|two-step|two-factor|2fa|mfa|otp)\b|c[óo]digo|codice|קוד/i;
  // A submit that itself asks for a code ("Get code", "Send code") would send the key as a request.
  const asksForCode = (element) => [element.innerText, element.value, element.title, element.alt, element.getAttribute("aria-label"), referenced(element.getAttribute("aria-labelledby"))]
    .some((name) => /\b(code|codes|otp|pin|passcode|verification|2fa)\b/i.test(norm(name)) && /\b(send|resend|request|get|new|another|again)\b/i.test(norm(name)));
  // How a code field reads, from its own words and its challenge's; the fill asks again after focus.
  const classify = (otp) => {
    // Never the field's own surroundings, whatever their class says.
    const aside = (element) => {
      const frame = element.closest(frameOf);
      return (!!frame && !frame.contains(otp)) || another(element);
    };
    const lines = (values) => values.map(norm).filter(Boolean);
    // Attributed to the field: its visible labels, its accessible name and its placeholder. Its
    // description, title, name and id are never positive evidence.
    const labelLines = lines([
      ...Array.from(otp.labels ?? []).map((label) => visibleText(label)),
      otp.getAttribute("aria-label"), referenced(otp.getAttribute("aria-labelledby")), otp.getAttribute("placeholder"),
    ]);
    // Every label (shown or not), the description and the title can veto.
    const vetoField = norm([
      ...labelLines, ...Array.from(otp.labels ?? []).map((label) => label.textContent ?? ""),
      referenced(otp.getAttribute("aria-describedby")), otp.getAttribute("title") ?? "",
    ].join(" "));
    const container = otp.closest("form, dialog, [role=dialog], fieldset") ?? otp.parentElement?.parentElement?.parentElement ?? document.body;
    const challengeLines = visibleLines(container, another);
    // The nearest instructions around the challenge: a heading or a paragraph above the form, a
    // help line just after it.
    const instructionLines = [];
    let length = 0;
    for (let node = container, level = 0; node && node !== document.body && level < 3 && length < 600; node = node.parentElement, level++) {
      for (const next of ["previousElementSibling", "nextElementSibling"]) {
        let sibling = node[next];
        for (let count = 0; sibling && count < 3 && length < 600; sibling = sibling[next], count++) {
          if (aside(sibling)) continue;
          const said = visibleLines(sibling, aside);
          if (said.length === 0) continue;
          instructionLines.push(...said);
          length += said.join(" ").length;
        }
      }
    }
    const sentencesOf = (values) => values.flatMap((line) => line.split(/(?<=[.!?])\s+/)).map((sentence) => sentence.trim()).filter(Boolean);
    // A sent-code notice is the page saying a code was or is being sent, anywhere outside its frame,
    // links, buttons and unchosen options: "We texted you a code", "A code is on its way". A channel
    // named in it (a text, a mail) is otpSent; a bare "SMS" is no notice.
    const notices = sentencesOf(visibleLines(document.body, aside)).filter((sentence) => sentEvent.test(sentence));
    const otpSent = notices.some((sentence) => /\b(sms|text|texted|phone|mobile|number)\b|ending in \d{2,4}|[•*]{2,}\s?\d{2,4}\b|t[ée]l[ée]phone|portable|tel[ée]fono|m[óo]vil|celular|handy|telefon|לטלפון|לנייד|ב-?sms/i.test(sentence)) ? "text"
      : notices.some((sentence) => /e-?mail|@|inbox|courriel|correo|למייל|לדוא"ל|לאימייל/i.test(sentence)) ? "email"
      : undefined;
    // A veto, not a reading: a phone, a text, a mail or a recovery address in the field's words,
    // its challenge or the instructions around it, or a sent-code notice anywhere (delivery).
    const otpDelivery = notices.length > 0 || delivery.test([vetoField, ...challengeLines, ...instructionLines].join(" "));
    // An affirmative label or instruction ("Authenticator code", "Enter the code from your
    // authenticator app"); a sentence with a hedge or a question counts for nothing.
    const app = "(authenticator( app(lication)?)?|(authentication|verification) app(lication)?|totp( app(lication)?)?)";
    const imperative = new RegExp([
      "^(please )?(enter|type|input|provide|use|get|copy|find)\\b.{0,60}\\b(code|passcode|one-time password|otp|token)\\b.{0,40}\\b(from|in|on|shown (in|on|by)|generated (by|in)|displayed (in|on))\\b.{0,30}\\b" + app,
      "^(please )?open (your|the|an) " + app + "\\b.{0,40}\\b(enter|type|copy|get|find)\\b.{0,30}\\b(code|passcode)",
      "^(veuillez )?(saisissez|entrez|saisir|entrer)\\b.{0,60}code.{0,60}application d.authentification",
      "^(por favor,? )?(introduce|introduzca|ingresa|ingrese|escribe|escriba)\\b.{0,60}c[óo]digo.{0,60}(app|aplicaci[óo]n) de autenticaci[óo]n",
      "^(bitte )?(gib|geben sie)\\b.{0,60}code.{0,60}(authenticator-app|authentifizierungs-app)",
      "^(הזן|הזינו|הקלד|הקלידו).{0,40}קוד.{0,40}אפליקציית (אימות|המאמת)",
    ].join("|"), "i");
    const labelled = new RegExp("^(\\d-digit )?" + app + " (code|passcode)[.:]?$|^(code|passcode) from (your |the |an )?" + app + "[.:]?$", "i");
    const excluded = /\b(or|backup|recovery|trouble|problems?|issues?|lost|lose|can.?t|cannot|can not|don.?t|do not|doesn.?t|no access|without|instead|help|reset|set ?up|recover|switch|change|changes|other|another|alternative(ly)?|not working|if)\b|\?$/i;
    // Wording that offers another way, anywhere in the challenge, leaves the box to the person.
    const alternative = /\b(or|either|backup codes?|recovery codes?|another way|other way|alternatively|instead)\b|\b(oder|entweder|sicherungscode|backup-code|ou|soit|code de secours|o|bien|c[óo]digo de respaldo|oppure|ovvero|codice di backup)\b|(^|\s)או(\s|$)|קוד גיבוי/i;
    const offersAnother = alternative.test([vetoField, ...challengeLines, ...instructionLines].join(" "));
    // Only one visible code-like field on the page, in the page's only form or dialog, can be this
    // challenge's for sure.
    const codeLike = (input) => visible(input) && !/^(hidden|password|email|checkbox|radio|submit|button|file)$/i.test(input.type) &&
      (/one-time-code/i.test(input.autocomplete) || /otp|mfa|2fa|two.?factor|totp|verification|one.?time|passcode|\bcode\b|token|קוד/i.test([input.name, input.id, input.getAttribute("aria-label"), input.placeholder, referenced(input.getAttribute("aria-labelledby")), ...Array.from(input.labels ?? []).map((label) => label.textContent ?? "")].join(" ")) ||
        (input.inputMode === "numeric" && input.maxLength >= 1 && input.maxLength <= 8));
    const codeFields = Array.from(document.querySelectorAll("input")).filter(codeLike);
    const challenges = Array.from(document.querySelectorAll("form, dialog, [role=dialog]")).filter((element) => visible(element) && !element.parentElement?.closest("form, dialog, [role=dialog]"));
    const only = codeFields.length === 1 && codeFields[0] === otp && challenges.length === 1 && challenges[0].contains(otp);
    // Positive evidence comes only from text tied to this field: its labels (for, or wrapping it),
    // aria-labelledby, aria-label and placeholder. Nearby text, and another field's, never counts.
    // Every visible label must say it itself: an accessible name or placeholder can't speak over a
    // visible label that says otherwise, as a stale one would.
    const says = (text) => sentencesOf([text]).some((sentence) => !excluded.test(sentence) && (labelled.test(sentence) || imperative.test(sentence)));
    // As rendered, aria-hidden or not: hiding a label from assistive tech doesn't unsay it.
    const shownLabels = lines(Array.from(otp.labels ?? []).filter((label) => visible(label)).map((label) => label.innerText ?? ""));
    // The field's own words, compounds split ("customerPin", "zip_code"), lowercase.
    // "#" and "no." are "number": "Account #", "Account no." and "Account number" are one purpose.
    const own = (values) => norm(values.join(" ")).replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/#/g, " number ").replace(/\bno\./gi, " number ").replace(/[_\-.:/]+/g, " ").toLowerCase().replace(/\s+/g, " ");
    const named = own([otp.name, otp.id, ...labelLines, ...Array.from(otp.labels ?? []).map((label) => label.textContent ?? "")]);
    // A field for other data, whatever else it looks like: its autocomplete or its words say so.
    const purposes = (otp.getAttribute("autocomplete") ?? "").toLowerCase().split(/\s+/).filter((token) => token && !/^(section-.*|shipping|billing)$/.test(token));
    const tokens = own([named, vetoField]).split(/[^a-z\d]+/).filter(Boolean);
    const otherData = purposes.some((token) => !/^(one-time-code|off|on)$/.test(token)) ||
      tokens.some((token) => /^(pin|date|dob|ssn|mm|dd|yyyy|cvv|cvc|zip)$|^pin|date$|birth|postal|postcode|zip|phone|card|cvv|cvc|ssn/.test(token)) ||
      /\b(account|acct|member|membership|customer|client|policy|card|phone|mobile|reference|routing|tax) number\b|\bsocial security\b/.test(own([named, vetoField]));
    // The field itself says it takes a code: its autocomplete, or its name, id, labels, accessible
    // name or placeholder.
    const saysCode = purposes.includes("one-time-code") || /\b(code|codes|otp|totp|2fa|mfa|passcode|one time)\b/.test(named);
    const single = !otpDelivery && only && !offersAnother && !otherData;
    const submits = submitters(otp);
    const otpOnly = single && saysCode && submits.length === 1 && !asksForCode(submits[0]);
    const otpApp = single && labelLines.some(says) && shownLabels.every(says);
    const otpContext = codeWord.test([...labelLines, ...challengeLines, ...instructionLines].join(" "));
    return { container, otpSent, otpDelivery, otpApp, otpOnly, otpContext };
  };
  const classified = otp ? classify(otp) : undefined;
  const container = classified?.container ?? null;
  const otpSent = classified?.otpSent;
  const otpDelivery = classified?.otpDelivery === true;
  const otpApp = classified?.otpApp === true;
  const otpOnly = classified?.otpOnly === true;
  const otpContext = classified?.otpContext === true;
  // A delivered code's cue anywhere outside the page's frame, links, buttons and options included
  // (a choice of a text or a mail is one): kept by the run, so a later page's plain box hands off.
  // Controls say what they do in their value or accessible name too (aria-label, aria-labelledby),
  // as an icon-only link or button does, not only in text nodes.
  const receipt = /\b(didn.?t|did not|haven.?t|have not|never) (receive|get|got)\b.{0,30}\b(code|text|sms|e-?mail|message)\b|\bresend\b|\bsend (it |the code |a new code )?again\b|\b(get|request|send) (me )?a new code\b|\bno code\b/i;
  // A code asked for, whatever the phrase: a code word with a request to send it ("Send a new
  // verification code", "Request a PIN"), or a get of another one ("Get another code").
  const sentWord = /\b(code|codes|otp|pin|passcode|verification|2fa)\b/i;
  const asked = (line) => sentWord.test(line) && (/\b(send|resend|request)\b/i.test(line) || (/\bget\b/i.test(line) && /\b(new|another|again)\b/i.test(line)));
  // Any control but the code's own submit (the one Scient presses) that names a code in any of its
  // names asks for one or offers another way: "Click here to get a code", "Need help with your
  // code?". Only a form's one submit is its own; a page with no code field has none.
  const ownSubmit = codeSubmits.length === 1 ? codeSubmits[0] : undefined;
  const fallback = /\b(can.?t|cannot|can not|unable to|couldn.?t|could not) (get|receive|access|find|use)\b/i;
  const method = /\b(backup|recovery) codes?\b|\b(another|other|different) (way|method|option)\b|\btry another\b|\b(text|call|e-?mail) me\b|\buse (a |an |your )?(backup|recovery|security key|passkey|phone|text|sms)\b/i;
  const codeCueNow = () => {
    const shown = Array.from(document.querySelectorAll("input[type=submit], input[type=button], button, a, [role=button], [role=link]"))
      .filter((element) => visible(element) && !element.closest(frameOf));
    const named = (element) => [element.value, element.getAttribute("aria-label"), referenced(element.getAttribute("aria-labelledby"))];
    if (shown.some((element) => element !== ownSubmit && [element.innerText, element.title, ...named(element)].some((name) => name && sentWord.test(norm(name))))) return true;
    const controls = shown.map((element) => norm(named(element).filter(Boolean).join(" "))).filter(Boolean);
    const pageLines = [...visibleLines(document.body, (element) => !!element.closest(frameOf)), ...controls];
    return pageLines.some((line) => sentEvent.test(line) || receipt.test(line) || asked(line) || fallback.test(line) || method.test(line)) ||
      (pageLines.some((line) => delivery.test(line)) && pageLines.some((line) => codeWord.test(line)));
  };
  const codeCue = codeCueNow();
  // Element instances, numbered the first time Scient reads them, only in its isolated world, whose
  // table the page can't see; elsewhere there are none.
  const instances = globalThis.__scientInstances;
  const instanceOf = (element) => {
    if (!instances || !element) return undefined;
    let id = instances.ids.get(element);
    if (!id) {
      id = instances.prefix + "-" + instances.next++;
      instances.ids.set(element, id);
      instances.elements.set(id, new WeakRef(element));
    }
    return id;
  };
  const otpField = otp ? instanceOf(otp) : undefined;
  const otpContainer = otpField !== undefined ? instanceOf(container) : undefined;
  const otpBox = otpField !== undefined ? otpField + ":" + otpContainer : undefined;
  const submitInstance = submit ? instanceOf(submit) : undefined;
  // Asked by the server of each control Chromium names with a code: whether it counts as a cue here.
  // The code's own submit counts too when Chromium's own name for it asks for a code ("Get code").
  if (instances) instances.counts = (element, asks) => visible(element) && !element.closest(frameOf) && (element !== ownSubmit || asks === true);
  // The fill asks the same questions again of the live field, right before its value is set.
  if (instances) instances.check = (field) => {
    const live = classify(field);
    return { container: instanceOf(live.container), sent: live.otpSent !== undefined, delivery: live.otpDelivery, app: live.otpApp, only: live.otpOnly, context: live.otpContext, cue: codeCueNow(), usable: usable(field), sendable: sendable(field) };
  };
  const stay = !password && !otp && /stay signed in\?/i.test(text)
    ? Array.from(document.querySelectorAll("button, input[type=submit]")).find(element => visible(element) && /^yes$/i.test((element.value || element.textContent || "").trim()))
    : undefined;
  // A CAPTCHA is what it renders, not its container: a visible frame of size that serves one
  // (often from another origin, so only the frame itself can be seen), or a box with content.
  const sized = (element) => {
    if (!visible(element)) return false;
    const box = element.getBoundingClientRect();
    return box.width >= 20 && box.height >= 20;
  };
  const captchaBoxes = Array.from(document.querySelectorAll('[class*=captcha i], [id*=captcha i]'));
  const frames = Array.from(document.querySelectorAll("iframe")).filter(sized);
  const captchaFrame = frames.some(frame =>
    /captcha|turnstile|challenge/i.test([frame.getAttribute("src"), frame.title, frame.name].join(" ")) ||
    captchaBoxes.some(box => box.contains(frame)));
  const captchaContent = captchaBoxes.some(box => visible(box) && (
    (box.innerText ?? "").trim() !== "" ||
    Array.from(box.querySelectorAll("iframe, img, canvas, svg, input, button")).some(sized)));
  const captcha = captchaFrame || captchaContent;
  // A page that never painted shows no text, no control and no frame, whatever boxes it holds.
  const blank = !captcha && frames.length === 0 && !(document.body?.innerText ?? "").trim() && !Array.from(document.querySelectorAll("input, button, select, textarea, img, svg, canvas, video")).some(visible);
  const push = /approve.*(phone|device)|check your (phone|device)|enter the number|number shown|tap the number|matching number|verification code shown|verify with (a )?number/i.test(text);
  const numbers = new Set();
  if (push) for (const element of document.querySelectorAll("p, div, span, section")) {
    if (!visible(element) || !/enter the number|number shown|tap the number|matching number|verification code shown|verify with (a )?number/i.test(element.innerText ?? "")) continue;
    // Only a small local prompt with a separate, visible numeric element is trusted.
    if ((element.innerText ?? "").length > 240) continue;
    for (const candidate of element.querySelectorAll("span, strong, b, p, div")) {
      const value = candidate.innerText?.trim() ?? "";
      if (visible(candidate) && /^\d{1,3}$/.test(value)) numbers.add(value);
    }
  }
  const links = Array.from(document.querySelectorAll('a, button, [role="button"], [role="link"]')).filter(visible);
  const linkNamed = (name) => links.find(element => name.test(element.textContent?.trim() ?? ""));
  const useAnother = linkNamed(/^use another account$/i);
  // "Choose an account" lists remembered accounts before any field appears; later steps show the
  // chosen account as a chip that goes back to the start. A row is the innermost element, since a
  // click on the list item around it may do nothing.
  const markedRows = Array.from(document.querySelectorAll("[data-identifier], [data-email]"));
  const possibleRows = markedRows.length > 0 ? markedRows : useAnother ? links.concat(Array.from(document.querySelectorAll("li"))) : [];
  const accountChoices = !password && !otp && !username
    ? possibleRows.filter(row => row !== useAnother && !possibleRows.some(other => other !== row && row.contains(other))).flatMap(element => {
        const text = element.innerText ?? "";
        const email = element.dataset?.identifier ?? element.dataset?.email ?? (text.length < 120 ? text.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] : undefined);
        return email && visible(element) ? [{ email, selector: path(element) }] : [];
      })
    : [];
  const signInLink = !password && !otp && !username
    ? linkNamed(/^enter your password$/i) ?? linkNamed(/^(sign in|log in|login)$/i) ?? useAnother
    : undefined;
  const anotherWay = !password && !otp && !username ? linkNamed(/^try another way$/i) : undefined;
  // Some sign-in pages answer 401, so a status only counts on a page with no form; 429 always does.
  const status = performance.getEntriesByType("navigation")[0]?.responseStatus ?? 0;
  // A limit stops everything, even on a page that still shows its fields, and so does a 429 to
  // a request the page made itself, such as its own check of a code.
  const limited = status === 429 ||
    performance.getEntriesByType("resource").some((entry) => entry.responseStatus === 429) ||
    new RegExp(${JSON.stringify(SITE_LIMITED_TEXT)}, "i").test(text);
  const broken = !password && !otp && !username && !limited && !captcha && (location.protocol === "chrome-error:" || status >= 400);
  const refused = password && new RegExp(${JSON.stringify(PASSWORD_REFUSED_TEXT)}, "i").test(text);
  // Microsoft Conditional Access: a managed, compliant or registered device, or token protection.
  const managedDevice = !password && !otp && /\bAADSTS(?:53000|53001|53003|50097|530003|530033)\b|you can.?t get there from here/i.test(text);
  // Which second factor, in the person's words: a hardware key rather than a passkey, a texted code.
  const securityKey = !captcha && /security key|insert your key|tap your key|usb key/i.test(text) && !/passkey/i.test(text);
  const texted = otp && /text message|\bsms\b|texted|sent (a code )?to (your )?(phone|mobile)|number ending in/i.test(text);
  return {
    ...(securityKey ? { via: "security-key" } : texted ? { via: "text" } : {}),
    ...(limited ? { limited: true } : {}),
    ...(broken ? { broken: true } : {}),
    ...(blank && !broken ? { blank: true } : {}),
    ...(refused ? { refused: true } : {}),
    ...(managedDevice ? { managedDevice: true } : {}),
    ...(accountChoices.length > 0 ? { accountChoices } : {}),
    ...(signInLink ? { signInLink: path(signInLink) } : {}),
    ...(anotherWay ? { anotherWay: path(anotherWay) } : {}),
    ...(push && numbers.size === 1 ? { number: [...numbers][0] } : {}),
    ...(remember ? { remember: path(remember) } : {}),
    ...(stay ? { stay: path(stay) } : {}),
    ...(otpSent ? { otpSent } : {}),
    ...(otpApp ? { otpApp: true } : {}),
    ...(otpOnly ? { otpOnly: true } : {}),
    ...(otp && !otp.form ? { otpNoForm: true } : {}),
    ...(otp && otp.form && !submit ? { otpNoSubmit: true } : {}),
    ...(otp && !usable(otp) ? { otpUnusable: true } : {}),
    ...(otpContext ? { otpContext: true } : {}),
    ...(codeCue ? { codeCue: true } : {}),
    ...(otpDelivery ? { otpDelivery: true } : {}),
    ...(otpBox ? { otpBox, otpField, otpContainer } : {}),
    ...(submitInstance ? { submitInstance } : {}),
    origin: location.origin,
    url: location.href,
    username: path(username), password: path(password), otp: path(otp), submit: path(submit),
    challenge: captcha ? "captcha" : /use (a |your )?passkey|touch id|security key/i.test(text) ? "passkey" : push ? "push" : null,
    document: performance.timeOrigin,
    signedIn: !username && !password && !otp && Array.from(document.querySelectorAll("a, button")).some(element => visible(element) && /^(sign out|log out|logout)$/i.test(element.textContent?.trim() ?? "")),
  };
})()`;

/** Ticks a detected checkbox with the page's own click, so its form sees the change. */
export const tickRememberScript = (selector: string) =>
  `document.querySelector(${JSON.stringify(selector)})?.click()`;

/** Right before a submit: whether the page now limits sign-ins or asks for a CAPTCHA. */
export const signInStopScript = `(() => {
  const seen = ${signInDetectionScript};
  return { limited: seen.limited === true, captcha: seen.challenge === "captcha" };
})()`;

export const SignInStop = Schema.Struct({
  limited: Schema.optional(Schema.Boolean),
  captcha: Schema.optional(Schema.Boolean),
});
