import { assert, describe, it } from "@effect/vitest";
import { Tool } from "effect/ai";

import { ScheduleTaskTool, ThreadUpdateTool } from "./tools.ts";

describe("orchestrator MCP tool schemas", () => {
  it("publishes an actionable schedule schema and compatibility string branch", () => {
    const schema = Tool.getJsonSchema(ScheduleTaskTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<
        Record<string, { readonly description?: unknown; readonly anyOf?: ReadonlyArray<unknown> }>
      >;
    };

    assert.equal(schema.type, "object");
    assert.isString(schema.properties?.schedule?.description);
    assert.isAtLeast(schema.properties?.schedule?.anyOf?.length ?? 0, 2);
  });

  it("publishes thread metadata actions from an object-root schema", () => {
    const schema = Tool.getJsonSchema(ThreadUpdateTool) as {
      readonly type?: unknown;
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    assert.equal(schema.type, "object");
    assert.hasAllKeys(schema.properties ?? {}, [
      "threadId",
      "action",
      "title",
      "pullRequest",
      "clientRequestId",
    ]);
  });
});
