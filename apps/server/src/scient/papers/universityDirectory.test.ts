import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { searchUniversities, universitiesFrom } from "./universityDirectory.ts";

const entry = (fields: Record<string, unknown>) => ({
  title: "Hebrew University of Jerusalem",
  entityID: "https://idp.huji.ac.il/openathens",
  scope: "huji.ac.il",
  domain: "huji.ac.il",
  hidden: "false",
  registrationAuthority: ["https://openathens.net"],
  ...fields,
});

it("turns directory entries into universities, the exact domain first", () => {
  const found = universitiesFrom(
    [
      entry({ title: "HighWire", entityID: "https://h.org/x", scope: "x.huji.ac.il", domain: "x" }),
      entry({}),
    ],
    "huji.ac.il",
  );
  expect(found[0]).toEqual({
    name: "Hebrew University of Jerusalem",
    entityId: "https://idp.huji.ac.il/openathens",
    domain: "huji.ac.il",
  });
});

it("hides test entries and national services that cover many universities", () => {
  expect(
    universitiesFrom(
      [
        entry({ hidden: "true" }),
        entry({
          title: "National",
          entityID: "https://n.org/i",
          scope: "a.il,b.il,c.il,d.il,e.il",
        }),
      ],
      "huji",
    ),
  ).toEqual([]);
});

it("reads an answer that isn't the directory's as no match", () => {
  expect(universitiesFrom({ error: "no" }, "huji")).toEqual([]);
});

it.effect("finds a mail host's university under its own domain, first", () =>
  Effect.gen(function* () {
    const asked: Array<string | null> = [];
    const found = yield* searchUniversities("mail.huji.ac.il").pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          const query = new URL(request.url).searchParams.get("q");
          asked.push(query);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                query === "huji.ac.il"
                  ? [
                      entry({ title: "Another", entityID: "https://o.org/i", scope: "o.ac.il" }),
                      entry({}),
                    ]
                  : [],
              ),
            ),
          );
        }),
      ),
    );
    expect(asked).toEqual(["mail.huji.ac.il", "huji.ac.il"]);
    expect(found[0]?.domain).toBe("huji.ac.il");
  }),
);
