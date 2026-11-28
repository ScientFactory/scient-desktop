/**
 * `wacli --events` lifecycle lines (NDJSON on stderr) and the failure messages wacli reports, read
 * into what Scient shows. See docs/internals/scient-whatsapp.md.
 */
import type { WhatsAppFailureReason } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const WacliEventLine = Schema.fromJsonString(
  Schema.Struct({
    event: Schema.String,
    data: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    ts: Schema.optional(Schema.Finite),
  }),
);
export type WacliEvent = typeof WacliEventLine.Type;

const decodeEventLine = Schema.decodeUnknownOption(WacliEventLine);

/** One stderr line as an event; plain-text lines that wacli also prints are not events. */
export function parseWacliEvent(line: string): WacliEvent | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  return Option.getOrUndefined(decodeEventLine(trimmed));
}

const QrCodeData = Schema.Struct({ code: Schema.String.check(Schema.isNonEmpty()) });
const ProgressData = Schema.Struct({ messages_synced: Schema.Finite });
const MessageData = Schema.Struct({ message: Schema.String });

const decodeQrCode = Schema.decodeUnknownOption(QrCodeData);
const decodeProgress = Schema.decodeUnknownOption(ProgressData);
const decodeMessage = Schema.decodeUnknownOption(MessageData);

export const eventQrCode = (event: WacliEvent): string | undefined =>
  Option.getOrUndefined(Option.map(decodeQrCode(event.data), (data) => data.code));

export const eventMessagesSynced = (event: WacliEvent): number | undefined =>
  Option.getOrUndefined(Option.map(decodeProgress(event.data), (data) => data.messages_synced));

export const eventMessage = (event: WacliEvent): string | undefined =>
  Option.getOrUndefined(Option.map(decodeMessage(event.data), (data) => data.message));

const GO_DURATION_UNITS_MS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
  us: 0.001,
  µs: 0.001,
  ns: 0.000_001,
};
const GO_DURATION_PART = /(\d+(?:\.\d+)?)(ms|us|µs|ns|h|m|s)/gu;
const GO_DURATION = /^(?:\d+(?:\.\d+)?(?:ms|us|µs|ns|h|m|s))+$/u;

/** Go's `time.Duration` text (`23h59m50s`, `1.5s`), in milliseconds. */
function parseGoDuration(text: string): number | undefined {
  if (!GO_DURATION.test(text)) return undefined;
  let total = 0;
  for (const [, amount, unit] of text.matchAll(GO_DURATION_PART)) {
    total += Number(amount) * (GO_DURATION_UNITS_MS[unit ?? ""] ?? 0);
  }
  return Math.round(total);
}

export const isTemporaryBan = (message: string) => /temporarily banned/iu.test(message);

/** When a temporary ban ends, from whatsmeow's `<code> (expires in <duration>)`; undefined when it doesn't say. */
export function temporaryBanUntil(message: string, now: number): number | undefined {
  const match = /expires in ([0-9.a-zµ]+)/iu.exec(message);
  const duration = match?.[1] === undefined ? undefined : parseGoDuration(match[1]);
  return duration === undefined || duration <= 0 ? undefined : now + duration;
}

/** The phone removed the device, or WhatsApp revoked the session, as wacli words it on exit. */
export const isSessionRevoked = (message: string) =>
  /session was revoked|not authenticated|logged out/iu.test(message);

/** A failed link, as the page explains it. Never wacli's own words: they name paths and flags. */
export function classifyLinkFailure(message: string | undefined): {
  readonly reason: WhatsAppFailureReason;
  readonly message: string;
} {
  const text = message ?? "";
  if (/passkey/iu.test(text)) {
    return {
      reason: "passkey-required",
      message:
        "WhatsApp asked to confirm this link with a passkey or fingerprint, which Scient can't do yet.",
    };
  }
  if (/QR code timed out/iu.test(text)) {
    return {
      reason: "scan-timed-out",
      message: "The QR code wasn't scanned in time. Start again to get a new one.",
    };
  }
  if (/outdated/iu.test(text)) {
    return {
      reason: "client-outdated",
      message:
        "WhatsApp says Scient's WhatsApp component is out of date. Update Scient and try again.",
    };
  }
  return { reason: "failed", message: "Linking WhatsApp didn't finish. Try again." };
}
