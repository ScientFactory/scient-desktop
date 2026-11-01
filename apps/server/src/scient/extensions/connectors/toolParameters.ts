import type { ConnectorToolSummary } from "@t3tools/contracts";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function extractToolParameters(
  schema: unknown,
  clean: (text: string) => string,
): ConnectorToolSummary["parameters"] {
  const input = record(schema);
  const properties = record(input?.properties);
  if (!properties) return undefined;
  const required = new Set(Array.isArray(input?.required) ? input.required : []);
  const trim = (value: string, limit: number) => clean(value).trim().slice(0, limit).trim();
  return Object.entries(properties)
    .slice(0, 50)
    .flatMap(([key, value]) => {
      const name = trim(key, 200);
      if (!name) return [];
      const property = record(value);
      const types =
        typeof property?.type === "string"
          ? [property.type]
          : Array.isArray(property?.type)
            ? property.type
            : [];
      const type = trim(
        types
          .filter((item): item is string => typeof item === "string")
          .slice(0, 8)
          .join(" | "),
        100,
      );
      const description =
        typeof property?.description === "string" ? trim(property.description, 2000) : "";
      return [
        {
          name,
          required: required.has(key),
          ...(type ? { type } : {}),
          ...(description ? { description } : {}),
        },
      ];
    });
}
