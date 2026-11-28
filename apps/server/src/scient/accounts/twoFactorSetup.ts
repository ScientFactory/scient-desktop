/**
 * A 2FA setup or a list of backup codes in the person's own tab, as the desktop read and sealed
 * it there: held privately as a pending secret, on no login until the person saves it to one. A
 * setup's current code goes back to the person's client to type.
 */
import {
  AccountPageOffer,
  AccountSetupPage,
  BrowserProfileId,
  type AccountPageKeepInput,
  type AccountPageKeepResult,
} from "@t3tools/contracts";
import { openPageSecrets } from "@t3tools/shared/scientPageSeal";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import jsQR from "jsqr";

import { AccountsService } from "./AccountsService.ts";
import { backupCodesValue } from "./backupCodes.ts";
import { parseTotp } from "./signIn/totp.ts";

/** A seal's header, bound to it: which seal, when, and the page as the desktop saw it. */
const SealHeader = Schema.Struct({
  sealId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  at: Schema.Number,
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  profileId: Schema.optional(BrowserProfileId),
  documentId: Schema.String.check(Schema.isMaxLength(64)),
  offer: AccountPageOffer,
});
const decodeSealHeader = Schema.decodeUnknownOption(Schema.fromJsonString(SealHeader));
/** What the page showed. */
const SealedPage = Schema.Struct({
  setup: Schema.optional(AccountSetupPage),
  codes: Schema.optional(
    Schema.Array(Schema.String.check(Schema.isMaxLength(32))).check(Schema.isMaxLength(20)),
  ),
});
const decodeSealedPage = Schema.decodeUnknownOption(Schema.fromJsonString(SealedPage));

/** Reads a QR from the page's dark-or-light pixels, one bit each, as the setup script sends them. */
function readQr(image: AccountSetupPage["images"][number]): string | undefined {
  const packed = Buffer.from(image.bits, "base64");
  const count = image.width * image.height;
  if (image.width <= 0 || image.height <= 0 || packed.length !== Math.ceil(count / 8))
    return undefined;
  const rgba = new Uint8ClampedArray(count * 4).fill(255);
  for (let i = 0; i < count; i++)
    if (packed[i >> 3]! & (128 >> (i & 7))) rgba[4 * i] = rgba[4 * i + 1] = rgba[4 * i + 2] = 0;
  // jsQR is CommonJS: under NodeNext its default export is the module, `default` the function.
  return jsQR.default(rgba, image.width, image.height)?.data;
}

/** The page's TOTP key, from a link or a QR, as its `otpauth://` address. */
export function setupKey(page: AccountSetupPage) {
  const candidates = [...page.uris, ...page.images.flatMap((image) => readQr(image) ?? [])];
  for (const uri of candidates) {
    if (!/^otpauth:\/\/totp\//i.test(uri)) continue;
    try {
      return { uri, totp: parseTotp(uri) };
    } catch {
      continue;
    }
  }
  return undefined;
}

/** Seals already opened, until they would be too old anyway: each opens once. */
const opened = new Map<string, number>();
const SEAL_FOR_MS = 2 * 60_000;

/**
 * Opens what the desktop sealed with the key it shares with this backend (none: no desktop runs
 * it) and holds it as a pending secret of the page's origin and profile; a setup answers with its
 * code and period. Another offer or document, too old, opened before, or changed: nothing.
 */
export const keepFromPage = Effect.fn("AccountsPage.keepFromPage")(function* (
  input: AccountPageKeepInput,
  sealKey: Buffer | undefined,
) {
  const accounts = yield* AccountsService;
  const now = yield* Clock.currentTimeMillis;
  const nothing = { found: false } satisfies AccountPageKeepResult;
  const seal = sealKey === undefined ? undefined : openPageSecrets(sealKey, input.sealed);
  if (seal === undefined) return nothing;
  const header = decodeSealHeader(seal.header);
  const page = decodeSealedPage(seal.text);
  if (Option.isNone(header) || Option.isNone(page)) return nothing;
  const { sealId, at, offer, documentId, profileId } = header.value;
  for (const [id, until] of opened) if (until <= now) opened.delete(id);
  if (
    offer !== input.offer ||
    documentId !== input.documentId ||
    at < now - SEAL_FOR_MS ||
    at > now + SEAL_FOR_MS ||
    opened.has(sealId)
  )
    return nothing;
  opened.set(sealId, at + 2 * SEAL_FOR_MS);
  const origin = URL.parse(header.value.origin)?.origin;
  if (!origin?.startsWith("https://")) return nothing;
  const where = { origin, ...(profileId === undefined ? {} : { profileId }) };
  if (input.offer === "recovery-codes") {
    const codes = page.value.codes ?? [];
    if (codes.length === 0) return nothing;
    const pendingId = yield* accounts.holdPending({
      ...where,
      kind: "recovery",
      value: Redacted.make(backupCodesValue(codes)),
    });
    return { found: true, pendingId } satisfies AccountPageKeepResult;
  }
  const key = page.value.setup ? setupKey(page.value.setup) : undefined;
  if (!key) return nothing;
  const pendingId = yield* accounts.holdPending({
    ...where,
    kind: "totp",
    value: Redacted.make(key.uri),
    label: key.totp.label.trim(),
  });
  return {
    found: true,
    pendingId,
    code: key.totp.generate({ timestamp: now }),
    period: key.totp.period,
  } satisfies AccountPageKeepResult;
});
