import { describe, expect, it } from "@effect/vitest";

import { maskBody, maskHeaders, maskUrl } from "./NetworkMasking.ts";

describe("network study masking", () => {
  it("hides cookies, authorization and token-looking values, and keeps the rest readable", () => {
    expect(
      maskHeaders({
        cookie: "MoodleSession=abc123",
        authorization: "Bearer xyz",
        "x-csrf-token": "short",
        accept: "application/json",
        "x-request-id": "a".repeat(40),
      }),
    ).toEqual({
      cookie: "<hidden 20 chars>",
      authorization: "<hidden 10 chars>",
      "x-csrf-token": "<hidden 5 chars>",
      accept: "application/json",
      "x-request-id": "<hidden 40 chars>",
    });
    expect(maskUrl("https://moodle.test/webservice/rest/server.php?wstoken=abcd&courseid=7")).toBe(
      "https://moodle.test/webservice/rest/server.php?wstoken=%3Chidden+4+chars%3E&courseid=7",
    );
    expect(
      JSON.parse(
        maskBody('{"user":{"name":"Ada","sesskey":"k1"},"courses":[1,2]}', "application/json")!,
      ),
    ).toEqual({ user: { name: "Ada", sesskey: "<hidden 2 chars>" }, courses: [1, 2] });
    expect(maskBody("username=ada&password=hunter22", "application/x-www-form-urlencoded")).toBe(
      "username=ada&password=%3Chidden+8+chars%3E",
    );
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
    const maskedForm = maskBody(multipart, "multipart/form-data; boundary=XyZ");
    expect(maskedForm).toContain("\r\nada\r\n");
    expect(maskedForm).not.toContain("hunter2-secret");
    expect(maskedForm).not.toContain("private notes");
    expect(maskedForm).toContain('name="password"\r\n\r\n<hidden 14 chars>');
    expect(maskBody(multipart, "multipart/form-data")).toBeUndefined();

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
    const maskedPage = maskBody(page, "text/html; charset=utf-8");
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
    const html = maskBody(
      [
        "<form><input type=hidden name=sesskey value=short-secret>",
        "<input type=hidden name=courseid value=7>",
        '<textarea name="csrf">short-secret</textarea></form>',
      ].join("\n"),
      "text/html",
    )!;
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

    const multipart = maskBody(
      "--b\r\nContent-Disposition: form-data; name=password\r\n\r\nshort-secret\r\n--b--\r\n",
      "multipart/form-data; boundary=b",
    )!;
    expect(multipart).not.toContain(secret);
    expect(multipart).toContain("name=password");

    const xml = maskBody(
      "<auth><user>ada</user><token>short-secret</token></auth>",
      "application/xml",
    )!;
    expect(xml).not.toContain(secret);
    expect(xml).toContain("<user>ada</user>");

    const text = maskBody("user=ada\npassword=short-secret\n", "text/plain")!;
    expect(text).not.toContain(secret);
    expect(text).toContain("user=ada");
  });

  it("hides every value Scient knows is secret for the request, wherever it appears", () => {
    const context = { secrets: ["c00kieval", "ya29.TOKEN-abc"], base: "https://app.test/" };
    const page = maskBody("<p>Welcome back c00kieval</p>", "text/html", context)!;
    expect(page).not.toContain("c00kieval");
    expect(page).toContain("<p>Welcome back ");
    const json = maskBody('{"echo":"ya29.TOKEN-abc","n":1}', "application/json", context)!;
    expect(json).not.toContain("ya29.TOKEN-abc");
    expect(JSON.parse(json)).toMatchObject({ n: 1 });
    expect(maskHeaders({ "x-debug": "sent c00kieval" }, context)["x-debug"]).not.toContain(
      "c00kieval",
    );
    // A format Scient cannot parse is left out rather than shown raw.
    expect(maskBody("\u0000\u0001raw", "application/octet-stream", context)).toBeUndefined();
  });
});
