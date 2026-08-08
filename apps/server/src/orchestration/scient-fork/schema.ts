/**
 * Scient-owned database schema for durable conversation forks.
 *
 * Re-exports the versioned migration runner. The runner uses its own
 * `scient_schema_migrations` ledger instead of T3's numbered migration
 * sequence. T3 can therefore add migration 039, 040, and beyond without
 * colliding with Scient-owned state.
 *
 * SCIENT-OWNED.
 */
export { runScientMigrations, SCIENT_MIGRATIONS, ScientMigrationError } from "./scientMigrator.ts";
