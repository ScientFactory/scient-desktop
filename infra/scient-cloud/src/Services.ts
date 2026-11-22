import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CloudError } from "./CloudError.ts";
import type { ShareApi } from "./ShareStore.ts";
import type { BaseLimits, UserApi } from "./UserStore.ts";

/** The calling user's Durable Object. */
export class Users extends Context.Service<Users, { readonly get: (userId: string) => UserApi }>()(
  "@scientfactory/scient-cloud-worker/Services/Users",
) {}

export class Shares extends Context.Service<
  Shares,
  { readonly get: (shareId: string) => ShareApi }
>()("@scientfactory/scient-cloud-worker/Services/Shares") {}

/** Verifies people's Clerk session tokens. */
export class PeopleAuth extends Context.Service<
  PeopleAuth,
  {
    readonly verify: (token: string) => Effect.Effect<{ readonly userId: string }, CloudError>;
    /** Lowercased verified addresses, for `people` links. */
    readonly verifiedEmails: (userId: string) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("@scientfactory/scient-cloud-worker/Services/PeopleAuth") {}

/** The share page app build (`share/dist`); paths are relative to `/s/_app/`. */
export class PageAssets extends Context.Service<
  PageAssets,
  { readonly fetch: (path: string) => Effect.Effect<Response | undefined> }
>()("@scientfactory/scient-cloud-worker/Services/PageAssets") {}

export interface CloudSettings {
  /** `https://cloud.scientfactory.com`: the computer token audience and API host. */
  readonly apiOrigin: string;
  /** `https://scientfactory.com`: serves `/s/*`. */
  readonly pageOrigin: string;
  /** `https://share.scientusercontent.com`: serves `/frame`. */
  readonly contentOrigin: string;
  /** Browser origins allowed to call the API besides the page origin. */
  readonly appOrigins: ReadonlyArray<string>;
  /** Also allow `http://localhost:*` origins. Development only. */
  readonly allowLocalhostOrigins: boolean;
  readonly limits: BaseLimits;
  readonly kek: CryptoKey;
  /** Enables `/v1/admin/*` when set. */
  readonly adminToken: string | null;
}

export class CloudConfig extends Context.Service<CloudConfig, CloudSettings>()(
  "@scientfactory/scient-cloud-worker/Services/CloudConfig",
) {}
