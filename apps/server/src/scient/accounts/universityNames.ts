import type { AccountSummary } from "@t3tools/contracts";
import { libraryLink, universityDetails } from "@t3tools/shared/scientPaperLinks";
import { parseUrl } from "@t3tools/shared/url";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/http";
import { searchUniversities } from "../papers/universityDirectory.ts";
import { AccountsService } from "./AccountsService.ts";

/**
 * A row saved from an OpenAthens link was named after the link's host. It takes its university's
 * name from the directory, by the domain the link names; nothing else on the row changes.
 */
export const nameAfterInstitution = Effect.fn("Accounts.nameAfterInstitution")(
  function* (account: AccountSummary) {
    const details = universityDetails(account.details);
    const proxyUrl = details?.proxyUrl;
    const link = proxyUrl ? libraryLink(proxyUrl) : undefined;
    if (!details || !proxyUrl || link?.kind !== "openathens") return;
    if (account.name !== parseUrl(proxyUrl.replace("{url}", ""))?.hostname) return;
    const found = (yield* searchUniversities(link.domain)).find(
      ({ domain }) => domain === link.domain,
    );
    if (!found) return;
    // Only the name, and only if nobody changed the row while the directory answered.
    yield* (yield* AccountsService).renameIfUnchanged(
      account.accountId,
      { name: account.name, proxyUrl },
      found.name,
    );
  },
  (effect) => effect.pipe(Effect.provide(FetchHttpClient.layer), Effect.ignore),
);
