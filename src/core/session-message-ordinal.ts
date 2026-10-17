export function nextSessionMessageOrdinalSql(sessionParam: string): string {
  return `SELECT COALESCE(MAX(value), 0) + 1 FROM (
    SELECT MAX(ordinal) AS value FROM session_messages WHERE session_id = ${sessionParam}
    UNION ALL
    SELECT MAX(rowid) FROM session_messages WHERE session_id = ${sessionParam} AND ordinal IS NULL
  )`;
}
