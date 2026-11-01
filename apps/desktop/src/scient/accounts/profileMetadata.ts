import * as Schema from "effect/Schema";

const LocalState = Schema.Struct({
  profile: Schema.optional(
    Schema.Struct({ info_cache: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)) }),
  ),
});
const Info = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
  user_name: Schema.optional(Schema.Unknown),
  gaia_picture_file_name: Schema.optional(Schema.Unknown),
  profile_highlight_color: Schema.optional(Schema.Unknown),
  default_avatar_fill_color: Schema.optional(Schema.Unknown),
});

const decodeState = Schema.decodeSync(Schema.fromJsonString(LocalState));
const decodeInfo = Schema.decodeUnknownOption(Info);

const safeFileName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value !== "." &&
  value !== ".." &&
  !/[\\/:]/.test(value) &&
  !value.includes("\u0000");

const text = (value: unknown) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 256 &&
  !/[\p{Cc}]/u.test(value)
    ? value.trim()
    : undefined;

const color = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= -2147483648 &&
  value <= 4294967295
    ? `#${((value >>> 0) & 0xffffff).toString(16).padStart(6, "0")}`
    : undefined;

export function parseChromiumProfileMetadata(json: string) {
  try {
    const state = decodeState(json);
    return Object.entries(state.profile?.info_cache ?? {}).flatMap(([directory, raw]) => {
      if (!safeFileName(directory)) return [];
      const decoded = decodeInfo(raw);
      if (decoded._tag === "None") return [];
      const info = decoded.value;
      return [
        {
          directory,
          name: text(info.name) ?? directory,
          email: text(info.user_name),
          pictureFile: safeFileName(info.gaia_picture_file_name)
            ? info.gaia_picture_file_name
            : undefined,
          color: color(info.profile_highlight_color) ?? color(info.default_avatar_fill_color),
        },
      ];
    });
  } catch {
    return [];
  }
}
