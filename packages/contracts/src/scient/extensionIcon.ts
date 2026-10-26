import * as Schema from "effect/Schema";

export const ExtensionIconDataUri = Schema.String.check(
  Schema.isMaxLength(350_000),
  Schema.isPattern(/^data:image\/(?:png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/u),
);
export type ExtensionIconDataUri = typeof ExtensionIconDataUri.Type;
export const isExtensionIconDataUri = Schema.is(ExtensionIconDataUri);
