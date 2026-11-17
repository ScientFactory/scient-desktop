import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "../baseSchemas.ts";

/**
 * A signed `/api/assets/<token>/<file>` path on the issuing environment. Clients
 * resolve it against that environment's base URL and fetch or render it, so an
 * absolute, protocol-relative or dot-segment value must not decode.
 */
export const isSignedAssetPath = () =>
  Schema.isPattern(/^\/api\/assets\/(?!\.{1,2}\/)[\w.-]+\/(?!(?:\.|%2[eE]){1,2}$)[^/\\?#\s]+$/u);

export const SignedAssetRelativeUrl = (maxLength: number) =>
  TrimmedNonEmptyString.check(Schema.isMaxLength(maxLength), isSignedAssetPath());
