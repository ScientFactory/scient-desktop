import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { WorkspaceBindingRef, WorkspaceScope } from "./workspace.ts";

const decodeBinding = Schema.decodeUnknownSync(WorkspaceBindingRef);
const decodeScope = Schema.decodeUnknownSync(WorkspaceScope);

describe("workspace scope contracts", () => {
  it("keeps durable ownership distinct from a host admission receipt", () => {
    expect(decodeBinding({ bindingId: "binding-a", authorityGeneration: 2 })).toEqual({
      bindingId: "binding-a",
      authorityGeneration: 2,
    });
    expect(() =>
      decodeScope({
        bindingId: "binding-a",
        authorityGeneration: 2,
      }),
    ).toThrow();
  });

  it("requires positive authority generation and host projection revision", () => {
    const scope = {
      bindingId: "binding-a",
      authorityGeneration: 1,
      workspaceRoot: "/workspace/a",
      scopeRevision: 1,
    };
    expect(decodeScope(scope)).toEqual(scope);
    for (const invalid of [
      { ...scope, bindingId: "" },
      { ...scope, authorityGeneration: 0 },
      { ...scope, scopeRevision: 0 },
      { ...scope, workspaceRoot: "" },
    ])
      expect(() => decodeScope(invalid)).toThrow();
  });
});
