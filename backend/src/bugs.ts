/**
 * Bug-report support helpers. The /bugs route handler in index.ts uses
 * these to (a) snapshot the last N log ids around the report so agents
 * can fetch context in one query, and (b) build the joined view that
 * GET /bugs/:id returns.
 */

const RELATED_LOGS_LIMIT = 10;

export async function snapshotRelatedLogIds(
  db: D1Database,
  userId: string,
  sessionId: string | null,
): Promise<number[]> {
  const sql = sessionId
    ? `SELECT id FROM logs WHERE user_id = ? AND session_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`
    : `SELECT id FROM logs WHERE user_id = ?
       ORDER BY created_at DESC, id DESC LIMIT ?`;
  const stmt = sessionId
    ? db.prepare(sql).bind(userId, sessionId, RELATED_LOGS_LIMIT)
    : db.prepare(sql).bind(userId, RELATED_LOGS_LIMIT);
  const { results } = await stmt.all<{ id: number }>();
  return (results ?? []).map((r) => r.id);
}

export async function fetchLogsByIds(
  db: D1Database,
  ids: number[],
): Promise<Record<string, unknown>[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT * FROM logs WHERE id IN (${placeholders}) ORDER BY created_at ASC`
  ).bind(...ids).all();
  return results ?? [];
}
