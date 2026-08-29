/**
 * Mirrors the server's temporary cross-client compatibility gate so the web
 * composer never presents a control the active Scient product cannot support
 * end to end. The server remains authoritative if a stale client bypasses it.
 */
export const SCIENT_GENERIC_FILE_ATTACHMENTS_ENABLED = false;
