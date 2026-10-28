import * as Schema from "effect/Schema";

/**
 * `Schema.isTrimmed()` without its JSON Schema regex, which agents reading tool
 * schemas gain nothing from. Decoding still rejects untrimmed values.
 */
export const isTrimmedUnadvertised = () => Schema.isTrimmed({ toJsonSchema: () => [{}, true] });
