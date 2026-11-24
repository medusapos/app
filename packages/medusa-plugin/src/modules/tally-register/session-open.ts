/** Whether a session already locked by the caller still takes money. */
export async function sessionTakesMoney(session: { id?: unknown; status?: unknown } | null | undefined,
  query: (sql: string, params: string[]) => Promise<unknown[]>): Promise<boolean> {
  return !!session && (session.status === 'open' || session.status === 'counting')
    && (await query('select id from tally_register_closure where session_id = ?', [String(session.id)])).length === 0
}
