import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
// SCIENT-FORK:START
import * as SchemaGetter from "effect/SchemaGetter";
// SCIENT-FORK:END

import {
  ForwardCompatibleArray,
  ForwardCompatibleUnion,
  ForwardCompatibleUnionArray,
  isUnknownUnionMember,
  TrimmedNonEmptyString,
  UnknownUnionMember,
} from "./baseSchemas.ts";

const at = "2026-10-05T00:00:00.000Z";
const Shape = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("circle"), radius: Schema.Number, at: Schema.DateTimeUtc }),
  Schema.Struct({ kind: Schema.Literal("square"), side: Schema.Number }),
]);
const members = Shape.members;
const fromWire = <S extends Schema.Top>(schema: S) =>
  Schema.decodeUnknownSync(Schema.toCodecJson(schema) as never) as (value: unknown) => S["Type"];

describe("ForwardCompatibleArray", () => {
  it("decodes elements through their own codec and drops ones it cannot read", () => {
    const decoded = fromWire(ForwardCompatibleArray(Shape))([
      { kind: "circle", radius: 1, at },
      { kind: "triangle" },
      { kind: "square", side: "wide" },
    ]);
    expect(decoded).toHaveLength(1);
    expect(DateTime.isDateTime((decoded[0] as { at: unknown }).at)).toBe(true);
  });

  const Named = ForwardCompatibleArray(Schema.Struct({ name: TrimmedNonEmptyString }));

  it("drops an element it cannot encode instead of failing the array", () => {
    const wire = JSON.parse(
      JSON.stringify(
        Schema.encodeUnknownSync(Schema.toCodecJson(Named))([
          { name: "a" },
          { name: " " },
          { name: "b" },
        ]),
      ),
    );
    expect(wire).toEqual([{ name: "a" }, { name: "b" }]);
    expect(fromWire(Named)(wire)).toEqual([{ name: "a" }, { name: "b" }]);
  });

  it("still drops the null holes a server on an earlier build sends", () => {
    expect(fromWire(Named)([{ name: "a" }, null, { name: "b" }])).toEqual([
      { name: "a" },
      { name: "b" },
    ]);
  });
});

describe("ForwardCompatibleUnion", () => {
  const decode = fromWire(ForwardCompatibleUnion(members, "kind"));

  it("decodes a member from a newer server as unknown", () => {
    const decoded = decode({ kind: "triangle", corners: 3 });
    expect(isUnknownUnionMember(decoded)).toBe(true);
    expect(decoded).toEqual(new UnknownUnionMember("kind", "triangle"));
  });

  it("decodes known members in full, transformations included", () => {
    const decoded = decode({ kind: "circle", radius: 1, at });
    expect(isUnknownUnionMember(decoded)).toBe(false);
    expect(DateTime.isDateTime((decoded as { at: unknown }).at)).toBe(true);
  });

  it("still fails a known member whose payload is broken", () => {
    expect(() => decode({ kind: "square", side: "wide" })).toThrow();
  });
});

describe("ForwardCompatibleUnionArray", () => {
  // SCIENT-FORK:START
  it("keeps a portable historical notice that decodes to a canonical boundary", () => {
    const Notice = Schema.Struct({ kind: Schema.Literal("notice"), boundary: Schema.String });
    const Boundary = Schema.Struct({ kind: Schema.Literal("boundary"), source: Schema.String });
    const PortableBoundary = Notice.pipe(
      Schema.decodeTo(Boundary, {
        decode: SchemaGetter.transform((notice) => ({
          kind: "boundary" as const,
          source: notice.boundary,
        })),
        encode: SchemaGetter.transform((boundary) => ({
          kind: "notice" as const,
          boundary: boundary.source,
        })),
      }),
    );
    const codec = ForwardCompatibleUnionArray([PortableBoundary], "kind");
    const decode = fromWire(codec);
    expect(decode([{ kind: "notice", boundary: "message-1" }, { kind: "future" }])).toEqual([
      { kind: "boundary", source: "message-1" },
    ]);
    expect(() => decode([{ kind: "notice", boundary: 1 }])).toThrow();
    expect(Schema.encodeSync(codec)([{ kind: "boundary", source: "message-1" }])).toEqual([
      { kind: "notice", boundary: "message-1" },
    ]);
  });
  // SCIENT-FORK:END

  it("keeps a known member however its fields are named", () => {
    const Flagged = Schema.Struct({
      kind: Schema.Literal("flag"),
      _unknown: Schema.Literal(true),
      tag: Schema.String,
      value: Schema.String,
    });
    const flag = { kind: "flag", _unknown: true, tag: "kind", value: "x" };
    expect(fromWire(ForwardCompatibleUnionArray([Flagged], "kind"))([flag])).toEqual([flag]);
  });

  const decode = fromWire(ForwardCompatibleUnionArray(members, "kind"));

  it("drops members a newer server added and keeps the rest", () => {
    const decoded = decode([
      { kind: "triangle" },
      { kind: "circle", radius: 1, at },
      { kind: "square", side: 2 },
    ]);
    expect(decoded.map((shape) => shape.kind)).toEqual(["circle", "square"]);
  });

  it("fails when a known member is broken, so real bugs stay visible", () => {
    expect(() => decode([{ kind: "square", side: "wide" }])).toThrow();
  });
});
