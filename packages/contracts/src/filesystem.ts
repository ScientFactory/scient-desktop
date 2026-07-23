import { Schema } from "effect";

const FILESYSTEM_PATH_MAX_LENGTH = 512;
const FilesystemBrowsePath = Schema.String.check(Schema.isNonEmpty()).check(
  Schema.isMaxLength(FILESYSTEM_PATH_MAX_LENGTH),
);
const FilesystemEntryValue = Schema.String.check(Schema.isNonEmpty());

export const FilesystemBrowseInput = Schema.Struct({
  partialPath: FilesystemBrowsePath,
  cwd: Schema.optional(FilesystemBrowsePath),
});
export type FilesystemBrowseInput = typeof FilesystemBrowseInput.Type;

export const FilesystemBrowseEntry = Schema.Struct({
  name: FilesystemEntryValue,
  fullPath: FilesystemEntryValue,
});
export type FilesystemBrowseEntry = typeof FilesystemBrowseEntry.Type;

export const FilesystemBrowseResult = Schema.Struct({
  parentPath: FilesystemEntryValue,
  entries: Schema.Array(FilesystemBrowseEntry),
});
export type FilesystemBrowseResult = typeof FilesystemBrowseResult.Type;
