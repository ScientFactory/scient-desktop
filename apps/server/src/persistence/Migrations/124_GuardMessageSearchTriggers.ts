import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { recreateMessageSearchTriggers } from "../../orchestration-v2/messageSearchIndex.ts";

// Earlier profiles have the pre-guard trigger definitions stored in SQLite.
export default Effect.flatMap(SqlClient.SqlClient, recreateMessageSearchTriggers);
