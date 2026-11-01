/**
 * Use a separate scient_schema_migrations ledger so upstream migration IDs cannot collide with
 * Scient-owned state.
 */
export { runScientMigrations } from "./scientMigrator.ts";
