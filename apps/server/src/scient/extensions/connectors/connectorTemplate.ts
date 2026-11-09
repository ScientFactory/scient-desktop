/**
 * The starting folder `scient_connector_copy` writes for a new connector: the `connector-authoring`
 * skill's templates, with `{{NAME}}` and `{{DISPLAY_NAME}}` filled in.
 */
import { BUILT_IN_SKILL_SOURCES } from "../../skills/BuiltInSkillSources.ts";

const TEMPLATE_PREFIX = "templates/";

/** Used only until the skill's own templates are embedded. */
const PLACEHOLDER: Readonly<Record<string, string>> = {
  "manifest.json": `{
  "manifest_version": "0.3",
  "name": "{{NAME}}",
  "display_name": "{{DISPLAY_NAME}}",
  "version": "0.1.0",
  "description": "Replace with what this connector does.",
  "server": {
    "type": "node",
    "entry_point": "server.mjs",
    "mcp_config": { "command": "node", "args": ["\${__dirname}/server.mjs"] }
  },
  "tools": [{ "name": "ping", "description": "Answers pong." }]
}
`,
  "server.mjs": `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === "initialize")
    send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion,
      capabilities: { tools: {} }, serverInfo: { name: "{{NAME}}", version: "0.1.0" } } });
  else if (message.method === "tools/list")
    send({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "ping", description: "Answers pong.",
      inputSchema: { type: "object", properties: {} } }] } });
  else if (message.method === "tools/call")
    send({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "pong" }] } });
  else send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
});
`,
};

/** Template files by path, with the connector's names filled in. */
export const connectorTemplate = (input: {
  readonly name: string;
  readonly displayName: string;
}): Readonly<Record<string, string>> => {
  const skill = BUILT_IN_SKILL_SOURCES.find(
    (source) => source.directoryName === "connector-authoring",
  );
  const embedded = Object.entries(skill?.files ?? {}).flatMap(([path, text]) =>
    path.startsWith(TEMPLATE_PREFIX) ? [[path.slice(TEMPLATE_PREFIX.length), text] as const] : [],
  );
  const files = embedded.length > 0 ? embedded : Object.entries(PLACEHOLDER);
  // JSON-escaped in the manifest; the names are already plain words and dashes.
  const displayName = input.displayName.replaceAll(/["\\\n\r]/gu, " ");
  return Object.fromEntries(
    files.map(([path, text]) => [
      path,
      text.replaceAll("{{NAME}}", input.name).replaceAll("{{DISPLAY_NAME}}", displayName),
    ]),
  );
};
