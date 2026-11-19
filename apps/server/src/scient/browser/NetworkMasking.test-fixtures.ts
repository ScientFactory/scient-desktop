/** Worst-case inputs for `NetworkMasking`, shared by its test and its benchmark. */
import { checkBody, maskHeaders, maskUrl } from "./NetworkMasking.ts";

/** A 1,024-character known value. */
export const longKnownValue = Array.from({ length: 1024 }, (_, index) =>
  String.fromCharCode(97 + (index % 26)),
).join("");

export const adversarialMaskingInputs = (): ReadonlyArray<readonly [string, () => unknown]> => {
  const size = 64 * 1024;
  const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
  const context = {
    secrets: [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab",
      "eyJeyJeyJeyJ-cookie",
      "&#38;&#38;-secret",
      "%%%%-secret",
      "abcdefghij-123456",
      ...Array.from({ length: 30 }, (_, index) => `cookie-value-${index}-xyz`),
    ],
    base: "https://app.test/",
  };
  /** Long known values whose prefixes the text repeats, which a naive matcher retries at every step. */
  const long = {
    secrets: [`${"a".repeat(4095)}b`, longKnownValue],
    base: "https://app.test/",
  };
  return [
    ["long value, repeated prefix", () => checkBody(fill("a"), "text/plain", long)],
    [
      "1 KB value, repeated prefix",
      () => checkBody(fill(longKnownValue.slice(0, 1023)), "text/plain", long),
    ],
    ["long values, references", () => checkBody(fill("&#97;"), "text/html", long)],
    ["letters", () => checkBody(fill("a"), "text/plain", context)],
    ["open quote", () => checkBody(`"${fill("a")}`, "text/plain", context)],
    ["quoted keys", () => checkBody(fill(`"a":`), "text/plain", context)],
    ["jwt starts", () => checkBody(fill("eyJ"), "text/plain", context)],
    ["pairs", () => checkBody(fill("a=b;"), "text/plain", context)],
    ["urls", () => checkBody(fill("https://a.test/?token="), "text/plain", context)],
    ["secret prefixes", () => checkBody(fill("abcdefghij-12345"), "text/plain", context)],
    ["references", () => checkBody(fill("&#38;"), "text/plain", context)],
    ["percents", () => checkBody(fill("%"), "text/plain", context)],
    ["escapes", () => checkBody(fill("\\u00"), "text/plain", context)],
    ["base64", () => checkBody(fill("Y29va2llLXZhbHVl"), "text/plain", context)],
    ["tag spaces", () => checkBody(`<a${fill(" ")}>`, "text/html", context)],
    ["attributes", () => checkBody(`<a${fill(" b=c")}>`, "text/html", context)],
    ["open tags", () => checkBody(fill("<"), "text/html", context)],
    ["refresh", () => checkBody(`<meta content="${fill("url=")}">`, "text/html", context)],
    ["srcset", () => checkBody(`<img srcset="${fill("a.png 1x,")}">`, "text/html", context)],
    ["secret elements", () => checkBody(fill("<token>a</token>"), "application/xml", context)],
    ["data json", () => checkBody(`<b data-x="${fill("[")}">`, "text/html", context)],
    ["deep json", () => checkBody(fill("["), "application/json", context)],
    [
      "json strings",
      () => checkBody(`[${fill('"[1]",').slice(0, -1)}]`, "application/json", context),
    ],
    ["multipart", () => checkBody(fill("--b\r\n\r\n"), "multipart/form-data; boundary=b", context)],
    ["form", () => checkBody(fill("a=&"), "application/x-www-form-urlencoded", context)],
    [
      "secret fields",
      () => checkBody(fill("token=a&"), "application/x-www-form-urlencoded", context),
    ],
    ["secret query", () => maskUrl(`https://a.test/?${fill("token=a&")}`)],
    [
      "headers",
      () =>
        maskHeaders(
          { link: fill("<"), refresh: fill("url="), referer: fill("a"), "x-a": fill("a") },
          context,
        ),
    ],
  ];
};
