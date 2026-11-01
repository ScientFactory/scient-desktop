import { describe, expect, it } from "@effect/vitest";
import { parseCsv, parsePasswordImport } from "./PasswordImport.ts";
import { syntheticValue } from "./Accounts.testkit.ts";

const formats = [
  [
    "chrome",
    "name,url,username,password,note",
    ["Synthetic", "https://login.example.co.uk/path", "user", "$VALUE", "note"],
  ],
  [
    "safari",
    "Title,URL,Username,Password,Notes,OTPAuth",
    ["Synthetic", "https://login.example.co.uk", "user", "$VALUE", "note", ""],
  ],
  [
    "firefox",
    "url,username,password,httpRealm,formActionOrigin",
    ["https://login.example.co.uk", "user", "$VALUE", "", ""],
  ],
  [
    "1password",
    "Title,Website,Username,Password,Notes,Type",
    ["Synthetic", "https://login.example.co.uk", "user", "$VALUE", "note", "Login"],
  ],
  [
    "bitwarden",
    "name,login_uri,login_username,login_password,login_totp",
    ["Synthetic", "https://login.example.co.uk", "user", "$VALUE", ""],
  ],
  [
    "keepass",
    "Group,Title,Username,Password,URL,Notes,TOTP",
    ["Group", "Synthetic", "user", "$VALUE", "https://login.example.co.uk", "note", ""],
  ],
] as const;

describe("password import", () => {
  it.each(formats)(
    "parses and auto-detects %s exports without losing fields",
    (format, header, cells) => {
      const value = syntheticValue();
      const csv = `${header}\r\n${cells.map((cell) => (cell === "$VALUE" ? value : cell)).join(",")}\r\n`;
      const explicit = parsePasswordImport(csv, format);
      const auto = parsePasswordImport(csv, "auto");
      expect(explicit.entries.length).toBe(1);
      expect(auto.entries[0]?.password === value).toBe(true);
      expect(explicit.entries[0]?.password === value).toBe(true);
      expect(explicit.entries[0]).toMatchObject({ site: "login.example.co.uk", username: "user" });
    },
  );
  it("handles BOM, escaped quotes, embedded commas and multiline fields", () => {
    const value = `${syntheticValue()},\n"quoted"`;
    const escaped = value.replaceAll('"', '""');
    const parsed = parsePasswordImport(
      `\uFEFFname,url,username,password,note\r\n"An ""example""",https://example.com,user,"${escaped}","a\r\nb"`,
      "auto",
    );
    expect(parsed.entries[0]?.password === value).toBe(true);
    expect(parsed.entries[0]?.name).toBe('An "example"');
    expect(parseCsv('a,b\rc,d\n"e",f')).toEqual([
      ["a", "b"],
      ["c", "d"],
      ["e", "f"],
    ]);
  });
  it("refuses malformed quoting and unknown headers with safe errors", () => {
    for (const content of [
      'name,url,username,password,note\nExample,https://example.com,user,"unterminated,note',
      'name,url,username,password,note\nExample,https://example.com,user,abc"def,note',
      'name,url,username,password,note\nExample,https://example.com,user,"abc"x,note',
      "unrecognized,columns\na,b",
    ]) {
      expect(() => parsePasswordImport(content, "auto")).toThrow(
        "The password export is not a supported CSV file.",
      );
    }
  });
  it("skips non-website and incomplete rows while retaining TOTP and private domains", () => {
    const value = syntheticValue();
    const content = `name,login_uri,login_username,login_password,login_totp\nvalid,https://name.github.io,user,${value},JBSWY3DPEHPK3PXP\ninvalid,not-url,user,${value},\nmissing,https://example.com,user,,\nlocal,https://localhost,user,${value},\nbad,ftp://example.com,user,${value},`;
    const parsed = parsePasswordImport(content, "auto");
    expect(parsed.skipped).toBe(4);
    expect(parsed.entries[0]).toMatchObject({ site: "name.github.io", totp: "JBSWY3DPEHPK3PXP" });
  });
});
