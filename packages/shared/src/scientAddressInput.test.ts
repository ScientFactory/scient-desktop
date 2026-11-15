import { describe, expect, it } from "vite-plus/test";

import { resolveAddressBarInput } from "./preview.ts";
import { cleanTypedHost } from "./scientAddressInput.ts";

const c = (...codes: number[]) => String.fromCodePoint(...codes);
const RAFE = c(0x5bf);
const HEBREW_POINTS = c(0x5b8, 0x5bc);
const RLM = c(0x200f);
const LRM = c(0x200e);
const ZWSP = c(0x200b);
const ZWJ = c(0x200d);
const ACUTE = c(0x301);
const FATHA = c(0x64e);
const SHALOM = `${c(0x5e9)}${c(0x5c1, 0x5b8)}${c(0x5dc)}${c(0x5d5, 0x5b9)}${c(0x5dd)}`;

describe("cleanTypedHost", () => {
  it.each([
    [`portal.tags.digitalowl.app${RAFE}${RAFE}`, "portal.tags.digitalowl.app"],
    [
      `https://portal.tags.digitalowl.app${RAFE}${RAFE}/portal/case-list`,
      "https://portal.tags.digitalowl.app/portal/case-list",
    ],
    [`example${FATHA}.com`, "example.com"],
    [`${RLM}example.com${LRM}/a`, "example.com/a"],
    [`exa${ZWSP}mple.com:8080/x?q=1`, "example.com:8080/x?q=1"],
    [`https://user@exa${HEBREW_POINTS}mple.com/`, "https://user@example.com/"],
  ])("cleans the host of %j", (typed, cleaned) => {
    expect(cleanTypedHost(typed)).toBe(cleaned);
  });

  it.each([
    ["a real Hebrew domain", `${SHALOM}.co.il`],
    ["a Latin accent", `cafe${ACUTE}.fr`],
    ["a joiner some scripts' domains need", `a${ZWJ}b.com`],
    ["marks in the path and query", `example.com/${SHALOM}?q=app${RAFE}`],
    ["a word, not an address", `app${RAFE}`],
    ["a search with spaces", `hello app${RAFE}.com now`],
    ["an ordinary address", "https://example.com:8443/a.b?c=d#e"],
  ])("leaves %s as typed", (_name, typed) => {
    expect(cleanTypedHost(typed)).toBe(typed);
  });
});

describe("resolveAddressBarInput with stray characters", () => {
  it("opens the site the person meant instead of a name no site has", () => {
    expect(resolveAddressBarInput(`portal.tags.digitalowl.app${RAFE}${RAFE}/x`)).toBe(
      "https://portal.tags.digitalowl.app/x",
    );
    expect(resolveAddressBarInput(`https://portal.tags.digitalowl.app${RAFE}${RAFE}`)).toBe(
      "https://portal.tags.digitalowl.app/",
    );
    expect(resolveAddressBarInput(`example.com${RLM}`)).toBe("https://example.com/");
  });

  it("still searches for words", () => {
    expect(resolveAddressBarInput(`app${RAFE}`, "https://search.example/?q=%s")).toBe(
      `https://search.example/?q=${encodeURIComponent(`app${RAFE}`)}`,
    );
  });
});
