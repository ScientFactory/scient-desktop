/** Worst-case inputs for `NetworkMasking`, shared by its test and its benchmark. */
import { maskBody, maskHeaders, maskUrl } from "./NetworkMasking.ts";

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
  return [
    ["letters", () => maskBody(fill("a"), "text/plain", context)],
    ["open quote", () => maskBody(`"${fill("a")}`, "text/plain", context)],
    ["quoted keys", () => maskBody(fill(`"a":`), "text/plain", context)],
    ["jwt starts", () => maskBody(fill("eyJ"), "text/plain", context)],
    ["pairs", () => maskBody(fill("a=b;"), "text/plain", context)],
    ["urls", () => maskBody(fill("https://a.test/?token="), "text/plain", context)],
    ["secret prefixes", () => maskBody(fill("abcdefghij-12345"), "text/plain", context)],
    ["references", () => maskBody(fill("&#38;"), "text/plain", context)],
    ["percents", () => maskBody(fill("%"), "text/plain", context)],
    ["escapes", () => maskBody(fill("\\u00"), "text/plain", context)],
    ["base64", () => maskBody(fill("Y29va2llLXZhbHVl"), "text/plain", context)],
    ["tag spaces", () => maskBody(`<a${fill(" ")}>`, "text/html", context)],
    ["attributes", () => maskBody(`<a${fill(" b=c")}>`, "text/html", context)],
    ["open tags", () => maskBody(fill("<"), "text/html", context)],
    ["refresh", () => maskBody(`<meta content="${fill("url=")}">`, "text/html", context)],
    ["srcset", () => maskBody(`<img srcset="${fill("a.png 1x,")}">`, "text/html", context)],
    ["secret elements", () => maskBody(fill("<token>a</token>"), "application/xml", context)],
    ["data json", () => maskBody(`<b data-x="${fill("[")}">`, "text/html", context)],
    ["deep json", () => maskBody(fill("["), "application/json", context)],
    [
      "json strings",
      () => maskBody(`[${fill('"[1]",').slice(0, -1)}]`, "application/json", context),
    ],
    ["multipart", () => maskBody(fill("--b\r\n\r\n"), "multipart/form-data; boundary=b", context)],
    ["form", () => maskBody(fill("a=&"), "application/x-www-form-urlencoded", context)],
    [
      "secret fields",
      () => maskBody(fill("token=a&"), "application/x-www-form-urlencoded", context),
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
