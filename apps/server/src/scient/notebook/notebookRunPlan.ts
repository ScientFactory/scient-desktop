import type {
  ComputeResultParameter,
  NotebookRevisionSource,
  NotebookView,
} from "@t3tools/contracts";
import {
  notebookOverrideAllowed,
  notebookParameterJson,
  notebookParameterLanguage,
  parseNotebookOverride,
  readNotebookParameters,
} from "@t3tools/shared/notebookParameters";

type Literal = Exclude<ReturnType<typeof parseNotebookOverride>, undefined>;
type Language = NonNullable<ReturnType<typeof notebookParameterLanguage>>;

function literalCode(value: Literal, language: Language, vector = false): string {
  if (Array.isArray(value)) {
    const body = value.map((item) => literalCode(item, language)).join(", ");
    return language === "r" ? `${vector ? "c" : "list"}(${body})` : `[${body}]`;
  }
  if (typeof value === "boolean") {
    if (language === "python") return value ? "True" : "False";
    if (language === "r") return value ? "TRUE" : "FALSE";
  }
  const json = JSON.stringify(value);
  return language === "julia" && typeof value === "string" ? json.replaceAll("$", "\\$") : json;
}

export function planNotebookRun(
  notebook: NotebookView,
  overrides: Readonly<Record<string, string>>,
  injectionId: string,
) {
  const cells = notebook.cells.filter((cell) => !cell.injectedParameters);
  const parameterCell = cells.find((cell) => cell.cellType === "code" && cell.parameterCell);
  const language = notebookParameterLanguage(notebook.language);
  const defaults =
    parameterCell === undefined
      ? []
      : readNotebookParameters(parameterCell.source, notebook.language);
  const values = new Map<string, { readonly value: Literal; readonly json: string }>();
  const lines = [];
  for (const [name, raw] of Object.entries(overrides)) {
    const parameter = defaults.find((entry) => entry.name === name);
    const value = parseNotebookOverride(raw);
    if (
      language === undefined ||
      parameter === undefined ||
      value === undefined ||
      !notebookOverrideAllowed(parameter, value)
    ) {
      throw new Error(`The parameter "${name}" cannot use that value.`);
    }
    const json = notebookParameterJson(parameter, value);
    const code =
      typeof value === "number"
        ? json
        : literalCode(value, language, parameter.collection === "vector");
    if (language === "r" && code.includes("\\u0000"))
      throw new Error(`The parameter "${name}" contains a NUL character.`);
    values.set(name, { value, json });
    lines.push(`${name} ${language === "r" ? "<-" : "="} ${code}`);
  }
  const parameters: ComputeResultParameter[] = [];
  for (const parameter of defaults) {
    const override = values.get(parameter.name);
    const json = override?.json ?? parameter.defaultJson;
    if (json !== undefined) {
      parameters.push({
        name: parameter.name,
        value: json,
        source: override === undefined ? "default" : "override",
      });
    }
  }
  if (parameters.length > 200 || parameters.some(({ name }) => name.length > 128))
    throw new Error("This notebook has too many parameters or a parameter name is too long.");
  const injection =
    lines.length === 0
      ? undefined
      : { id: injectionId, source: ["# Parameters", ...lines].join("\n") };
  const notebookSource: NotebookRevisionSource = {
    language: notebook.language,
    cells: cells.flatMap(({ id, cellType, source, parameterCell: parameters }) => [
      { id, cellType, source, ...(parameters ? { parameterCell: true } : {}) },
      ...(injection !== undefined && id === parameterCell?.id
        ? [{ ...injection, cellType: "code" as const, injectedParameters: true }]
        : []),
    ]),
  };
  const overrideValues = Object.fromEntries([...values].map(([name, { value }]) => [name, value]));
  const parameterEnvironment = `{${[...values].map(([name, { json }]) => `${JSON.stringify(name)}:${json}`).join(",")}}`;
  return {
    cells: notebookSource.cells
      .filter(({ cellType }) => cellType === "code")
      .map(({ id, source }) => ({ id, source })),
    notebookSource,
    injection,
    parameterCellId: parameterCell?.id,
    parameters,
    overrides: overrideValues,
    parameterEnvironment,
  };
}
