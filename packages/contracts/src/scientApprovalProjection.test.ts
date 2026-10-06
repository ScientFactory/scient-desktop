import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import {
  ProjectionPendingApprovalStatus as publicStatus,
  ProjectionPendingApprovalDecision as publicDecision,
} from "./index.ts";
import {
  ProjectionPendingApprovalStatus as legacyStatus,
  ProjectionPendingApprovalDecision as legacyDecision,
} from "./orchestration.ts";
import { ProviderApprovalDecision } from "./providerPolicy.ts";
import {
  ProjectionPendingApprovalStatus,
  ProjectionPendingApprovalDecision,
} from "./scientApprovalProjection.ts";

it("keeps single SQL approval-history schemas across leaf, public and legacy owners", () => {
  expect(publicStatus).toBe(ProjectionPendingApprovalStatus);
  expect(legacyStatus).toBe(ProjectionPendingApprovalStatus);
  expect(publicDecision).toBe(ProjectionPendingApprovalDecision);
  expect(legacyDecision).toBe(ProjectionPendingApprovalDecision);
  expect(ProjectionPendingApprovalStatus.literals).toEqual(["pending", "resolved"]);
  expect(ProjectionPendingApprovalDecision.members[0]).toBe(ProviderApprovalDecision);
  expect(ProjectionPendingApprovalDecision.members[1]).toBe(Schema.Null);
});

it("retains exact literal and null SQL scalars and rejects invalid decode/encode inputs", () => {
  const decodeStatus = Schema.decodeUnknownSync(ProjectionPendingApprovalStatus);
  const encodeStatus = Schema.encodeUnknownSync(ProjectionPendingApprovalStatus);
  const decodeDecision = Schema.decodeUnknownSync(ProjectionPendingApprovalDecision);
  const encodeDecision = Schema.encodeUnknownSync(ProjectionPendingApprovalDecision);
  for (const value of ["pending", "resolved"] as const) {
    expect(decodeStatus(value)).toBe(value);
    expect(encodeStatus(value)).toBe(value);
  }
  for (const value of [
    null,
    "accept",
    "acceptForSession",
    "acceptAlways",
    "decline",
    "cancel",
  ] as const) {
    expect(decodeDecision(value)).toBe(value);
    expect(encodeDecision(value)).toBe(value);
  }
  for (const invalid of [null, undefined, "", "running", "accepted", 0, false, {}]) {
    expect(() => decodeStatus(invalid)).toThrow(Schema.SchemaError);
    expect(() => encodeStatus(invalid)).toThrow(Schema.SchemaError);
  }
  for (const invalid of [undefined, "", "pending", "accept_once", 0, false, {}]) {
    expect(() => decodeDecision(invalid)).toThrow(Schema.SchemaError);
    expect(() => encodeDecision(invalid)).toThrow(Schema.SchemaError);
  }
});
