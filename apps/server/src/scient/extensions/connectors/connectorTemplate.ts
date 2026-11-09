/**
 * The starting folder `scient_connector_copy` writes for a new connector: the `connector-authoring`
 * skill's templates, with `{{NAME}}` and `{{DISPLAY_NAME}}` filled in.
 */
import { BUILT_IN_SKILL_SOURCES } from "../../skills/BuiltInSkillSources.ts";

const TEMPLATE_PREFIX = "templates/";

/** Template files by path, with the connector's names filled in. */
export const connectorTemplate = (input: {
  readonly name: string;
  readonly displayName: string;
}): Readonly<Record<string, string>> => {
  const skill = BUILT_IN_SKILL_SOURCES.find(
    (source) => source.directoryName === "connector-authoring",
  );
  const files = Object.entries(skill?.files ?? {}).flatMap(([path, text]) =>
    path.startsWith(TEMPLATE_PREFIX) ? [[path.slice(TEMPLATE_PREFIX.length), text] as const] : [],
  );
  // JSON-escaped in the manifest; the names are already plain words and dashes.
  const displayName = input.displayName.replaceAll(/["\\\n\r]/gu, " ");
  return Object.fromEntries(
    files.map(([path, text]) => [
      path,
      text.replaceAll("{{NAME}}", input.name).replaceAll("{{DISPLAY_NAME}}", displayName),
    ]),
  );
};
