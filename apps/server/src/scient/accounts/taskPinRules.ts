/** What a task pin allows, read wherever an account is used: the scheduler and Accounts alike. */
import {
  DEFAULT_BROWSER_PROFILE_ID,
  type AccountSummary,
  type AccountTarget,
  type ProjectId,
} from "@t3tools/contracts";
import { loginUserKey } from "@t3tools/shared/scientLoginIdentity";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TaskPin } from "./AccountPersistence.ts";

export const profileOf = (account: AccountSummary) =>
  ("profileId" in account.details ? account.details.profileId : undefined) ??
  DEFAULT_BROWSER_PROFILE_ID;

export const usernameOf = (account: AccountSummary) =>
  account.details.kind === "website" ? account.details.username : undefined;

/** A pin only binds the tasks of the project that made it. */
export const pinBinds = (pin: TaskPin, projectId: ProjectId | undefined) =>
  pin.projectId === undefined || pin.projectId === projectId;

/**
 * Why a pinned run may not use `target`: a website sign-in or browser profile other than its pin,
 * or the pinned row once it is no longer the same sign-in. API keys and other rows aren't bound.
 */
export function pinRefusal(
  pin: TaskPin,
  target: AccountTarget,
  row: AccountSummary | undefined,
): string | undefined {
  if (target.type === "profile")
    return target.profileId === pin.profileId
      ? undefined
      : "This scheduled task runs only in its pinned browser profile.";
  if (row !== undefined && row.details.kind !== "website") return undefined;
  if (target.accountId !== pin.accountId)
    return "This scheduled task runs only as its pinned sign-in.";
  if (
    row === undefined ||
    profileOf(row) !== pin.profileId ||
    loginUserKey(pin.username) !== loginUserKey(usernameOf(row))
  )
    return "This scheduled task's pinned sign-in changed. Pin it again.";
  return undefined;
}

const decodePin = Schema.decodeUnknownOption(TaskPin);

/** A stored pin that can't be read: its task stays blocked until it is pinned again. */
export interface UnreadablePin {
  readonly scheduledTaskId: string;
  readonly accountId: string | undefined;
}

/**
 * The stored pins, each read on its own: an older or broken one never stops Accounts loading.
 * `nameless`: an entry that names no task, so it may be any task's pin.
 */
export function readTaskPins(stored: ReadonlyArray<unknown> | undefined) {
  const pins: TaskPin[] = [];
  const unreadable: UnreadablePin[] = [];
  let nameless = false;
  for (const entry of stored ?? []) {
    const pin = decodePin(entry);
    if (Option.isSome(pin)) {
      pins.push(pin.value);
      continue;
    }
    const raw =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : {};
    if (typeof raw.scheduledTaskId === "string" && raw.scheduledTaskId !== "")
      unreadable.push({
        scheduledTaskId: raw.scheduledTaskId,
        accountId: typeof raw.accountId === "string" ? raw.accountId : undefined,
      });
    else nameless = true;
  }
  return { pins, unreadable, nameless };
}

/**
 * One task's pin as stored: its own, `unreadable` (its entry doesn't read, or an entry that names
 * no task may be its pin) until it is pinned again, or none. The scheduler's admission, its
 * trigger changes and each use of an account all read this one answer.
 */
export function taskPinIn(
  stored: ReadonlyArray<unknown> | undefined,
  scheduledTaskId: string,
): TaskPin | "unreadable" | undefined {
  const read = readTaskPins(stored);
  if (read.unreadable.some((pin) => pin.scheduledTaskId === scheduledTaskId)) return "unreadable";
  const pin = read.pins.find((kept) => kept.scheduledTaskId === scheduledTaskId);
  return pin ?? (read.nameless ? "unreadable" : undefined);
}

export const UNREADABLE_PIN = "This scheduled task's pin couldn't be read. Pin it again.";

/**
 * The scheduled task of a run whose records couldn't be read: any pin may bind it, so it uses no
 * website sign-in or browser profile at all.
 */
export const UNKNOWN_RUN = "scient:run-unknown";
export const UNKNOWN_RUN_REFUSAL =
  "Scient couldn't tell whether this run belongs to a pinned scheduled task, so it used no sign-in.";
