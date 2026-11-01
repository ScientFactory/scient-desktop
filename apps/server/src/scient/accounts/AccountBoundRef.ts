import { AccountId, VaultSecretRef } from "@t3tools/contracts";
import { Option, Schema } from "effect";

const BoundRef = Schema.String.check(Schema.isPattern(/^account:acc_[A-Za-z0-9_-]{8,64}:token$/));
const decodeRef = Schema.decodeUnknownOption(BoundRef);

export const accountTokenRef = (accountId: AccountId): VaultSecretRef =>
  VaultSecretRef.make(`account:${accountId}:token`);

export const boundAccountId = (ref: VaultSecretRef): Option.Option<AccountId> =>
  Option.map(decodeRef(ref), (value) => AccountId.make(value.slice(8, -6)));
