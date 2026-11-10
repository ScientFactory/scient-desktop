import { describe, expect, it } from "@effect/vitest";

import { maskBody, maskHeaders, maskUrl } from "./NetworkStudy.ts";

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
        maskBody('{"user":{"name":"Ada","sesskey":"k1"},"courses":[1,2]}', "application/json"),
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
    expect(maskBody(multipart, "multipart/form-data")).not.toContain("hunter2");

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
});
