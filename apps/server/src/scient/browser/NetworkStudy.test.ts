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
});
