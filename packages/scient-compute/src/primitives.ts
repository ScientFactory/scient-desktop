import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Share bounds between wire and durable schemas so accepted records remain storable/sendable. Keep
 * primitives internal: consumers should depend on field contracts, not incidental width aliases.
 */
export const EntityId = Schema.NonEmptyString.check(Schema.isMaxLength(128));
export const Slug = Schema.NonEmptyString.check(Schema.isMaxLength(64));
export const Label = Schema.String.check(Schema.isMaxLength(256));
export const ShortText = Schema.String.check(Schema.isMaxLength(4096));
export const RuntimeErrorText = Schema.String.check(Schema.isMaxLength(16 * 1024));
const utf8 = new TextEncoder();
export const MAXIMUM_STREAM_TEXT_BYTES = 1024 * 1024;
export const StreamText = Schema.String.check(
  Schema.isMaxLength(MAXIMUM_STREAM_TEXT_BYTES),
  Schema.makeFilter((value: string) =>
    utf8.encode(value).byteLength <= MAXIMUM_STREAM_TEXT_BYTES
      ? true
      : `Expected at most ${MAXIMUM_STREAM_TEXT_BYTES} UTF-8 bytes.`,
  ),
);
export const ContentHash = Schema.NonEmptyString.check(Schema.isMaxLength(256));
export const Sequence = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ByteLength = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const Pixels = Schema.Int.check(Schema.isGreaterThan(0));
export const ProcessId = Schema.Int.check(Schema.isGreaterThan(0));
export const ObservedAt = Schema.String.check(
  Schema.isMaxLength(64),
  Schema.makeFilter((value: string) =>
    Option.isSome(DateTime.make(value)) ? true : "Expected an ISO-8601 instant.",
  ),
);
