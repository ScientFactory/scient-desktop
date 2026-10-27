import { describe, expect, it } from "vite-plus/test";
import { parseChromiumProfileMetadata } from "./profileMetadata.ts";

const state = (info_cache: unknown) => JSON.stringify({ profile: { info_cache } });

describe("Chromium profile metadata", () => {
  it("reads names, email, signed ARGB and safe picture names", () => {
    expect(
      parseChromiumProfileMetadata(
        state({
          Default: {
            name: " Work ",
            user_name: "person@example.test",
            gaia_picture_file_name: "Google Profile Picture.png",
            profile_highlight_color: -16711936,
          },
        }),
      ),
    ).toEqual([
      {
        directory: "Default",
        name: "Work",
        email: "person@example.test",
        pictureFile: "Google Profile Picture.png",
        color: "#00ff00",
      },
    ]);
  });
  it("uses fallbacks for missing and wrongly typed fields without dropping valid siblings", () => {
    const profiles = parseChromiumProfileMetadata(
      state({
        Default: {
          name: 42,
          user_name: {},
          profile_highlight_color: "red",
          default_avatar_fill_color: 0xff123456,
        },
        "Profile 1": {},
        broken: null,
      }),
    );
    expect(profiles.map(({ name, email, color }) => ({ name, email, color }))).toEqual([
      { name: "Default", email: undefined, color: "#123456" },
      { name: "Profile 1", email: undefined, color: undefined },
    ]);
    expect(parseChromiumProfileMetadata("{}")).toEqual([]);
    expect(parseChromiumProfileMetadata("invalid JSON")).toEqual([]);
  });
  it("refuses directory traversal and picture paths in either platform syntax", () => {
    const profiles = parseChromiumProfileMetadata(
      state({
        "../outside": {},
        "a\\b": {},
        ".": {},
        Default: { gaia_picture_file_name: "../outside.png" },
        "Profile 1": { gaia_picture_file_name: "a\\outside.png" },
        "Profile 2": { gaia_picture_file_name: "C:outside.png" },
      }),
    );
    expect(profiles.map((profile) => profile.directory)).toEqual([
      "Default",
      "Profile 1",
      "Profile 2",
    ]);
    expect(profiles.every((profile) => profile.pictureFile === undefined)).toBe(true);
  });
});
