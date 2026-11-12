import { expect, it } from "@effect/vitest";
import { EnvironmentHttpApi, SCIENT_SOURCES_HTTP_COMMANDS } from "@t3tools/contracts";
import { Tool } from "effect/ai";

import { BUILT_IN_SCIENT_PLUGINS } from "../../../scient/extensions/plugins/BuiltInPlugins.ts";
import { operationDefinitionForTool } from "../../ScientOperationTool.ts";
import { ScientAnnotationsToolkit } from "../annotations/tools.ts";
import { ScientReferencesToolkit } from "../references/tools.ts";
import { ScientSystematicReviewsToolkit } from "../systematicReviews/tools.ts";
import {
  LIBRARY_COMMAND_PARITY,
  LIBRARY_ENDPOINT_GROUPS,
  LIBRARY_ORGANIZE_ACTION_PARITY,
  LIBRARY_READ_PARITY,
  NON_LIBRARY_ENDPOINTS,
  type LibraryAgentTool,
  type LibraryParityEntry,
} from "./libraryParity.ts";
import { ScientSourcesLibraryToolkit, ScientSourcesToolkit } from "./tools.ts";

const TABLE = "apps/server/src/mcp/toolkits/sources/libraryParity.ts";

const libraryTools = new Map<string, Tool.Any>(
  [
    ScientSourcesToolkit,
    ScientReferencesToolkit,
    ScientSystematicReviewsToolkit,
    ScientAnnotationsToolkit,
  ].flatMap((toolkit) => Object.values(toolkit.tools).map((tool) => [tool.name, tool] as const)),
);
const pluginToolNames = new Set(
  BUILT_IN_SCIENT_PLUGINS.find((plugin) => plugin.pluginId === "scient.sources")!
    .components.filter((component) => component.type === "mcp-tools")
    .flatMap((component) => component.detail?.split(", ") ?? []),
);

const namedTools = (entry: LibraryParityEntry): ReadonlyArray<LibraryAgentTool> =>
  entry.kind === "tool" ? entry.tools : "tool" in entry ? [{ tool: entry.tool }] : [];

it("gives every Library command and read endpoint an agent tool or a stated reason", () => {
  const commands: ReadonlyArray<string> = Object.values(SCIENT_SOURCES_HTTP_COMMANDS);
  const skipped: ReadonlyArray<string> = NON_LIBRARY_ENDPOINTS;
  const reads = LIBRARY_ENDPOINT_GROUPS.flatMap((group) =>
    Object.keys(EnvironmentHttpApi.groups[group].endpoints).map((name) => `${group}.${name}`),
  ).filter((tag) => !commands.includes(tag) && !skipped.includes(tag));
  const commandTable: Record<string, LibraryParityEntry | undefined> = LIBRARY_COMMAND_PARITY;
  const readTable: Record<string, LibraryParityEntry | undefined> = LIBRARY_READ_PARITY;

  const problems: Array<string> = [];
  const checkEntry = (tag: string, entry: LibraryParityEntry | undefined, change: boolean) => {
    const label = change ? "Library command" : "Library read endpoint";
    if (entry === undefined) {
      problems.push(
        `${label} ${tag} has no agent tool. Add the tool or the action, or an exemption with its reason, in ${TABLE}.`,
      );
      return;
    }
    for (const { tool: name, input } of namedTools(entry)) {
      const tool = libraryTools.get(name);
      if (tool === undefined) {
        problems.push(`${label} ${tag} names ${name}, which no Library toolkit registers.`);
        continue;
      }
      if (!pluginToolNames.has(name))
        problems.push(`${label} ${tag} names ${name}, which BuiltInPlugins.ts does not list.`);
      if (
        change &&
        !operationDefinitionForTool(tool).requiredCapabilities.includes("sources:write")
      )
        problems.push(`${label} ${tag} names ${name}, which does not require sources:write.`);
      if (input !== undefined && !Object.hasOwn(Tool.getJsonSchema(tool).properties ?? {}, input))
        problems.push(
          `${label} ${tag} names ${name} input ${input}, which the tool does not take.`,
        );
    }
  };
  for (const tag of commands) checkEntry(tag, commandTable[tag], true);
  for (const tag of reads) checkEntry(tag, readTable[tag], false);
  for (const tag of Object.keys(readTable).filter((tag) => !reads.includes(tag)))
    problems.push(`${TABLE} lists ${tag}, which is not a Library read endpoint.`);
  expect(problems).toEqual([]);
});

it("gives every Library-only organize action an action of the library organize tool", () => {
  const schema = Tool.getJsonSchema(ScientSourcesLibraryToolkit.tools.scient_sources_organize);
  const agentActions = new Set(
    JSON.stringify(schema)
      .matchAll(/"action":\{"type":"string","enum":(\[[^\]]+\])\}/gu)
      .flatMap((match) => JSON.parse(match[1]!) as ReadonlyArray<string>),
  );
  const missing = Object.entries(LIBRARY_ORGANIZE_ACTION_PARITY).flatMap(([action, tools]) =>
    tools.filter((name) => !agentActions.has(name)).map((name) => `${action} -> ${name}`),
  );
  expect(missing).toEqual([]);
});

// Gaps pass, one named test each, so every run lists them; the orchestrator decides how each closes.
const gaps = Object.entries({ ...LIBRARY_COMMAND_PARITY, ...LIBRARY_READ_PARITY }).flatMap(
  ([tag, entry]) => (entry.kind === "gap" ? [{ tag, reason: entry.reason }] : []),
);
it.each(gaps)("gap: $tag has no agent tool yet ($reason)", ({ reason }) => {
  expect(reason).not.toBe("");
});
