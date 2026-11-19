import { describe, expect, it } from "@effect/vitest";

import {
  type CheckedBody,
  checkBody,
  knownMasker,
  type MaskContext,
  maskHeaders,
  maskUrl,
} from "./NetworkMasking.ts";
import { adversarialMaskingInputs, longKnownValue } from "./NetworkMasking.test-fixtures.ts";

/** The redacted text of a body `checkBody` shows; a body it leaves out fails the test. */
const shown = (checked: CheckedBody): string => {
  if (!("text" in checked)) throw new Error(`The body was left out: ${checked.leftOut}`);
  return checked.text;
};

describe("network study masking", () => {
  it("hides cookies, authorization and token-looking values, and keeps the rest readable", () => {
    expect(
      maskHeaders({
        cookie: "MoodleSession=abc123",
        authorization: "Bearer xyz",
        "x-csrf-token": "short",
        accept: "application/json",
        "x-request-id": "a".repeat(40),
        ":authority": "clinicaltrials.gov",
        ":method": "GET",
        ":scheme": "https",
        ":path": "/api/int/studies?access_token=abcd&cond=glioma",
      }),
    ).toEqual({
      cookie: "<hidden 20 chars>",
      authorization: "<hidden 10 chars>",
      "x-csrf-token": "<hidden 5 chars>",
      accept: "application/json",
      "x-request-id": "<hidden 40 chars>",
      // regression: `:authority` (the host) was hidden for the "auth" in its name.
      ":authority": "clinicaltrials.gov",
      ":method": "GET",
      ":scheme": "https",
      ":path": "/api/int/studies?access_token=%3Chidden+4+chars%3E&cond=glioma",
    });
    expect(maskUrl("https://moodle.test/webservice/rest/server.php?wstoken=abcd&courseid=7")).toBe(
      "https://moodle.test/webservice/rest/server.php?wstoken=%3Chidden+4+chars%3E&courseid=7",
    );
    expect(
      JSON.parse(
        shown(
          checkBody('{"user":{"name":"Ada","sesskey":"k1"},"courses":[1,2]}', "application/json"),
        ),
      ),
    ).toEqual({ user: { name: "Ada", sesskey: "<hidden 2 chars>" }, courses: [1, 2] });
    expect(
      checkBody("username=ada&password=hunter22", "application/x-www-form-urlencoded"),
    ).toEqual({
      text: "username=ada&password=%3Chidden+8+chars%3E",
    });
    // Repeated fields stay repeated, each hidden.
    expect(checkBody("token=one-a&token=two-b&x=1", "application/x-www-form-urlencoded")).toEqual({
      text: "token=%3Chidden+5+chars%3E&token=%3Chidden+5+chars%3E&x=1",
    });
  });

  it("hides secrets in multipart, HTML and script bodies and in URL headers, keeping their shape", () => {
    const multipart = [
      "--XyZ",
      'Content-Disposition: form-data; name="username"',
      "",
      "ada",
      "--XyZ",
      'Content-Disposition: form-data; name="password"',
      "",
      "hunter2-secret",
      "--XyZ",
      'Content-Disposition: form-data; name="upload"; filename="notes.txt"',
      "Content-Type: text/plain",
      "",
      "private notes",
      "--XyZ--",
      "",
    ].join("\r\n");
    const maskedForm = shown(checkBody(multipart, "multipart/form-data; boundary=XyZ"));
    expect(maskedForm).toContain("\r\nada\r\n");
    expect(maskedForm).not.toContain("hunter2-secret");
    expect(maskedForm).not.toContain("private notes");
    expect(maskedForm).toContain('name="password"\r\n\r\n<hidden 14 chars>');
    expect(checkBody(multipart, "multipart/form-data")).toEqual({ leftOut: "unparsed" });

    const page = [
      '<meta name="csrf-token" content="meta-csrf-value">',
      '<form><input type="hidden" name="sesskey" value="hidden-sesskey-value">',
      '<input type="hidden" name="courseid" value="7">',
      '<input type="password" name="pw" value="typed-password">',
      '<div data-auth-token="attr-token-value" class="course">Course</div></form>',
      '<script>M.cfg = {"wwwroot":"https://moodle.test","sesskey":"script-sesskey-value"};',
      "var api_token = 'script-token-value';</script>",
      '<a href="https://moodle.test/login?access_token=link-token-value&next=home">x</a>',
    ].join("\n");
    const maskedPage = shown(checkBody(page, "text/html; charset=utf-8"));
    for (const secret of [
      "meta-csrf-value",
      "hidden-sesskey-value",
      "typed-password",
      "attr-token-value",
      "script-sesskey-value",
      "script-token-value",
      "link-token-value",
    ])
      expect(maskedPage).not.toContain(secret);
    expect(maskedPage).toContain('name="courseid" value="7"');
    expect(maskedPage).toContain('"wwwroot":"https://moodle.test"');
    expect(maskedPage).toContain('class="course">Course</div>');
    expect(maskedPage).toContain("next=home");

    expect(
      maskHeaders({ location: "https://app.test/cb?access_token=header-token-value&state=x" }),
    ).toEqual({ location: "https://app.test/cb?access_token=%3Chidden+18+chars%3E&state=x" });
  });

  it("hides Codex's short secrets in every format, keeping names and plain values", () => {
    const secret = "short-secret";
    const html = shown(
      checkBody(
        [
          "<form><input type=hidden name=sesskey value=short-secret>",
          "<input type=hidden name=courseid value=7>",
          '<textarea name="csrf">short-secret</textarea></form>',
        ].join("\n"),
        "text/html",
      ),
    );
    expect(html).not.toContain(secret);
    expect(html).toContain("name=courseid value=7");
    expect(html).toContain('<textarea name="csrf">');

    const location = maskHeaders(
      { location: "/cb?access_token=short-secret&state=x" },
      { secrets: [], base: "https://app.test/login" },
    ).location!;
    expect(location).not.toContain(secret);
    expect(location.startsWith("/cb?")).toBe(true);
    expect(location).toContain("state=x");

    const multipart = shown(
      checkBody(
        "--b\r\nContent-Disposition: form-data; name=password\r\n\r\nshort-secret\r\n--b--\r\n",
        "multipart/form-data; boundary=b",
      ),
    );
    expect(multipart).not.toContain(secret);
    expect(multipart).toContain("name=password");

    const xml = shown(
      checkBody("<auth><user>ada</user><token>short-secret</token></auth>", "application/xml"),
    );
    expect(xml).not.toContain(secret);
    expect(xml).toContain("<user>ada</user>");

    const text = shown(checkBody("user=ada\npassword=short-secret\n", "text/plain"));
    expect(text).not.toContain(secret);
    expect(text).toContain("user=ada");
  });

  it("hides every value Scient knows is secret for the request, wherever it appears", () => {
    const context = { secrets: ["c00kieval", "ya29.TOKEN-abc"], base: "https://app.test/" };
    const page = shown(checkBody("<p>Welcome back c00kieval</p>", "text/html", context));
    expect(page).not.toContain("c00kieval");
    expect(page).toContain("<p>Welcome back ");
    const json = shown(checkBody('{"echo":"ya29.TOKEN-abc","n":1}', "application/json", context));
    expect(json).not.toContain("ya29.TOKEN-abc");
    expect(JSON.parse(json)).toMatchObject({ n: 1 });
    expect(maskHeaders({ "x-debug": "sent c00kieval" }, context)["x-debug"]).not.toContain(
      "c00kieval",
    );
    // A format Scient cannot parse is left out rather than shown raw.
    expect(checkBody("\u0000\u0001raw", "application/octet-stream", context)).toEqual({
      leftOut: "unparsed",
    });
  });

  it("hides a known secret in every listed encoding, in URLs, headers and bodies", () => {
    const secrets = [
      "short-secret",
      `p@ss w+rd/é&"'<>~`,
      "pw🔑key-42",
      "abcd",
      "café-secret",
      "Ω-secret",
    ];
    const context = { secrets, base: "https://app.test/" };
    // NetworkStudy shows a URL as maskUrl, then the request's known values hidden.
    const known = knownMasker(secrets);
    const knownUrl = (url: string): CheckedBody => {
      const masked = known(maskUrl(url));
      return masked === undefined ? { leftOut: "too-costly" } : { text: masked };
    };
    for (const secret of secrets) {
      const forms = writtenForms(secret);
      for (const [label, form] of forms) {
        const carriers: Array<[string, CheckedBody]> = [
          ["text", checkBody(`before ${form} after`, "text/plain", context)],
          [
            "html",
            checkBody(
              `<p>${form}</p><a title="${form}" href="/x?v=${form}">x</a>`,
              "text/html",
              context,
            ),
          ],
          ["json", jsonCarrier(form, context)],
          ["form", checkBody(`a=1&v=${form}`, "application/x-www-form-urlencoded", context)],
          [
            "multipart",
            checkBody(
              `--b\r\nContent-Disposition: form-data; name=note\r\n\r\n${form}\r\n--b--\r\n`,
              "multipart/form-data; boundary=b",
              context,
            ),
          ],
          ["header", { text: maskHeaders({ "x-echo": `sent ${form}` }, context)["x-echo"]! }],
          ["url", knownUrl(`https://app.test/p/${form}?q=${form}#${form}`)],
        ];
        for (const [carrier, checked] of carriers) {
          const output = shown(checked);
          for (const [otherLabel, other] of forms)
            expect(output.includes(other), `${label} in ${carrier} shows ${otherLabel}`).toBe(
              false,
            );
          expect(base64Shows(output, secret), `${label} in ${carrier} shows base64`).toBe(false);
        }
      }
    }
    // A text cut at its limit hides a value cut off at its end.
    expect(known("ends with short-sec", true)).toBe("ends with <hidden 9 chars>");
    expect(known("ends with short-sec")).toBe("ends with short-sec");
    // Every copy is hidden, however written; past its work budget the body is left out, not
    // shown with copies unchecked.
    const echoed = "short-secret, again short-secret, and short%2Dsecret";
    expect(checkBody(echoed, "text/plain")).toEqual({ text: echoed });
    expect(checkBody(echoed, "text/plain", context)).toEqual({
      text: "<hidden 12 chars>, again <hidden 12 chars>, and <hidden 12 chars>",
    });
    expect(checkBody(echoed, "text/plain", context, { workBudget: 10 })).toEqual({
      leftOut: "too-costly",
    });
  });

  it("leaves out markup and JSON nested past the limits, without running out of stack", () => {
    const deepXml = `${"<token>".repeat(5000)}x${"</token>".repeat(5000)}`;
    expect(checkBody(deepXml, "application/xml")).toEqual({ leftOut: "too-deep" });
    const deepJson = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    expect(checkBody(deepJson, "application/json")).toEqual({ leftOut: "too-deep" });
    // Ordinary elements nest as deep as they like; nothing is kept for them.
    const deepHtml = `${"<div>".repeat(5000)}<input type=password value=deep-pass>${"</div>".repeat(5000)}`;
    const masked = shown(checkBody(deepHtml, "text/html"));
    expect(masked).not.toContain("deep-pass");
    expect(masked.startsWith("<div><div>")).toBe(true);
  });

  it("hides known values from 4 characters, base64 too, and leaves shorter ones alone", () => {
    const known = knownMasker(["abcd", "en", "1"]);
    for (const written of ["YWJjZA==", "YWJjZA", "x=YWJjZA==&y", "LmFiY2Q=", "Li5hYmNk"])
      expect(known(written), written).not.toMatch(/YWJjZ|YWJj|FiY2|hYmNk/u);
    expect(known("abcd")).toBe("<hidden 4 chars>");
    expect(known("en, 1 and 12 stay")).toBe("en, 1 and 12 stay");
  });

  it("hides known values written with any named HTML reference", () => {
    const context = { secrets: ["café-secret", "Ω-secret"] };
    expect(checkBody("<p>caf&eacute;-secret and &Omega;-secret</p>", "text/html", context)).toEqual(
      { text: "<p><hidden 11 chars> and <hidden 8 chars></p>" },
    );
    expect(checkBody("caf&eacute-secret", "text/plain", context)).toEqual({
      text: "<hidden 11 chars>",
    });
  });

  it("matches long known values in linear work, and leaves out a body past its budget", () => {
    const text = "a".repeat(64 * 1024);
    const context = { secrets: [`${"a".repeat(4095)}b`, longKnownValue] };
    // Five readings of the text, each at most two steps a character.
    const linear = checkBody(text, "text/plain", context, { workBudget: 10 * text.length });
    expect(linear).toEqual({ text });
    const repeated = longKnownValue.repeat(64);
    expect(
      checkBody(repeated, "text/plain", context, { workBudget: 10 * repeated.length }),
    ).toEqual({ text: "<hidden 1024 chars>".repeat(64) });
    expect(checkBody(text, "text/plain", context, { workBudget: 1000 })).toEqual({
      leftOut: "too-costly",
    });
    expect(knownMasker(context.secrets, { workBudget: 10 })(text)).toBeUndefined();
  });

  it("masks every worst-case 64 KB input without failing", () => {
    // Speed is measured in NetworkMasking.bench.ts (the performance lane), not here.
    for (const [label, run] of adversarialMaskingInputs()) expect(run, label).not.toThrow();
  });
});

/** Every encoding of `secret` the masking guarantees to find, by name. */
const writtenForms = (secret: string): ReadonlyArray<readonly [string, string]> => {
  const points = Array.from(secret, (char) => char.codePointAt(0)!);
  const isAlnum = (point: number) => /^[A-Za-z0-9]$/u.test(String.fromCodePoint(point));
  const each = (write: (point: number) => string, all = false) =>
    points
      .map((point) => (all || !isAlnum(point) ? write(point) : String.fromCodePoint(point)))
      .join("");
  const bytes = (point: number) => [...Buffer.from(String.fromCodePoint(point), "utf8")];
  const named: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
    "/": "&sol;",
    "@": "&commat;",
    "+": "&plus;",
    é: "&eacute;",
    Ω: "&Omega;",
  };
  const units = (point: number) => {
    const text = String.fromCodePoint(point);
    return Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
  };
  const uri = encodeURIComponent(secret);
  return [
    ["raw", secret],
    ["percent", uri],
    ["percent lower", uri.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase())],
    ["form", uri.replaceAll("%20", "+")],
    // encodeURI keeps a literal `+`, which only the plain percent reading leaves as written.
    ["percent uri", encodeURI(secret)],
    [
      "percent all",
      each(
        (point) =>
          bytes(point)
            .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, "0")}`)
            .join(""),
        true,
      ),
    ],
    ["json", JSON.stringify(secret).slice(1, -1)],
    [
      "json unicode",
      each((point) =>
        units(point)
          .map((unit) => `\\u${unit.toString(16).padStart(4, "0")}`)
          .join(""),
      ),
    ],
    [
      "json unicode upper",
      each(
        (point) =>
          units(point)
            .map((unit) => `\\u${unit.toString(16).toUpperCase().padStart(4, "0")}`)
            .join(""),
        true,
      ),
    ],
    ["html named", Array.from(secret, (char) => named[char] ?? char).join("")],
    ["html decimal", each((point) => `&#${point};`)],
    ["html decimal zeros", each((point) => `&#000${point};`)],
    ["html decimal all", each((point) => `&#${point};`, true)],
    ["html hex", each((point) => `&#x${point.toString(16)};`)],
    ["html hex upper", each((point) => `&#X${point.toString(16).toUpperCase()};`, true)],
    ...[0, 1, 2].flatMap((shift) => {
      const encoded = Buffer.concat([Buffer.alloc(shift, 0x2e), Buffer.from(secret)]);
      const core = (text: string) =>
        text.slice(
          Math.ceil((8 * shift) / 6),
          Math.floor((8 * (shift + Buffer.byteLength(secret))) / 6),
        );
      return [
        [`base64 at ${shift}`, core(encoded.toString("base64"))],
        [`base64url at ${shift}`, core(encoded.toString("base64url"))],
      ] as const;
    }),
  ];
};

/** Whether any base64 or base64url run in `text`, decoded at any alignment, holds `secret`. */
const base64Shows = (text: string, secret: string) => {
  const needle = Buffer.from(secret).toString("latin1");
  for (const run of text.match(/[A-Za-z0-9+/_-]{6,}/gu) ?? []) {
    const normalized = run.replaceAll("-", "+").replaceAll("_", "/");
    for (let shift = 0; shift < 4; shift += 1)
      if (Buffer.from(normalized.slice(shift), "base64").toString("latin1").includes(needle))
        return true;
  }
  return false;
};

/** `form` written inside a JSON string, when it is valid JSON there. */
const jsonCarrier = (form: string, context: MaskContext) => {
  const body = `{"v":"${form}","n":1}`;
  try {
    JSON.parse(body);
  } catch {
    return checkBody(JSON.stringify({ v: form, n: 1 }), "application/json", context);
  }
  return checkBody(body, "application/json", context);
};
