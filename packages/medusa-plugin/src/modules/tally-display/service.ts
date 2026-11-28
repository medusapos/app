import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import type { EntityManager } from '@medusajs/framework/mikro-orm/postgresql'
import type { Context, Logger } from '@medusajs/framework/types'
import { InjectManager, MedusaContext, MedusaService } from '@medusajs/framework/utils'
import {
  TallyDisplay, TallyDisplayAdoption, TallyDisplayClaimFailure, TallyDisplayCode, TallyDisplayDevice, TallyDisplayPending,
  TallyDisplaySignal, TallyDisplaySnapshot,
} from './models/tally-display'
import { displayAdvertisement, type DisplayAdvertisementWire } from './ice-servers'
import { rateLimitSource } from './rate-limit-source'
import { DisplayRefusal, type DisplayRefusalCode } from './refusal'

// The limits of TallyUI's reference server (core 4.1.0 memory-server.ts, ADR-085 d4, d6, d8).
const MINUTE = 60_000, DAY = 24 * 60 * MINUTE
export const CODE_TTL_MS = 10 * MINUTE, MAX_UNSPENT_CODES = 5, SNAPSHOT_TTL_MS = MINUTE, SNAPSHOT_MAX_BYTES = 204_800
// Bound the storage used by an inbox that is never drained.
export const SIGNAL_INBOX_MAX = 100
const SOURCE_WINDOW_MS = MINUTE, SOURCE_MAX = 10, STORE_WINDOW_MS = 10 * MINUTE, STORE_MAX = 100
const DISPLAY_REFUSAL_MAX = 20 // Stop repeated refused credentials from consuming database connections.
export const DISPLAY_REFUSAL_SOURCES_MAX = 10_000 // Bound per-process memory even when source addresses churn.
const CONNECTED_MS = 30_000, ROW_TTL_MS = 30 * DAY
const STORE_KEY = 'store'

export interface TillDevice { deviceId: string; deviceKey: string }
export interface SignalMessage { type: 'offer' | 'answer' | 'ice'; payload: string }
type Row = Record<string, any>

/** 128 bits from crypto.randomBytes, base64url without padding: 22 characters. */
const newSecret = (): string => randomBytes(16).toString('base64url')
const newId = (): string => randomBytes(16).toString('hex')
export const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
/** Constant-time comparison of two SHA-256 hex digests, as equal-length buffers; differing lengths are unequal. */
const sameHash = (x: string, y: string): boolean => {
  const [a, b] = [Buffer.from(x, 'utf8'), Buffer.from(y, 'utf8')]
  return a.length === b.length && timingSafeEqual(a, b)
}
const digits = (count: number): string => String(randomInt(0, 10 ** count)).padStart(count, '0')
const refusal = (code: DisplayRefusalCode): DisplayRefusal => new DisplayRefusal(code)
const ago = (now: Date, ms: number): Date => new Date(now.getTime() - ms)

export default class TallyDisplayModuleService extends MedusaService({
  TallyDisplayDevice, TallyDisplayCode, TallyDisplayPending, TallyDisplay, TallyDisplaySignal, TallyDisplaySnapshot,
  TallyDisplayClaimFailure, TallyDisplayAdoption,
}) {
  private frozenAt: number | undefined
  private readonly displayRefusals = new Map<string, { openedAt: number; count: number }>()
  private readonly advertisement: DisplayAdvertisementWire

  constructor(container: Record<string, unknown>, options: { customerDisplay?: { iceServers?: unknown } } = {}) {
    super(...arguments)
    // Read once, so an invalid ICE list logs one warning (ADR-085 d7).
    const warn = (message: string) => {
      try { (container.logger as Logger).warn(message) } catch { console.warn(message) }
    }
    this.advertisement = displayAdvertisement(options, warn)
  }

  /** `/info`'s `customerDisplay`. */
  customerDisplay(): DisplayAdvertisementWire { return this.advertisement }

  /**
   * The module's one clock. A test moves it by resolving this service from the container; no route reaches it. Once
   * moved it stands still, as the reference harness's clock does, so a "30 days later" boundary is exact.
   */
  now(): number { return this.frozenAt ?? Date.now() }
  advanceClock(ms: number): void { this.frozenAt = (this.frozenAt ?? Date.now()) + ms }
  resetClock(): void { this.frozenAt = undefined }
  /** Tests clear the per-process cap through the service; no route reaches this. */
  resetDisplayRefusals(): void { this.displayRefusals.clear() }

  private async displayAttempt<T>(source: string, work: () => Promise<T>): Promise<T> {
    const windows = this.displayRefusals, key = rateLimitSource(source), held = windows.get(key)
    if (held && held.count >= DISPLAY_REFUSAL_MAX && this.now() < held.openedAt + SOURCE_WINDOW_MS) throw refusal('rate_limited')
    try { return await work() } catch (error) {
      if (!(error instanceof DisplayRefusal) || (error.code !== 'token_refused' && error.code !== 'collect_refused')) throw error
      const now = this.now(), current = windows.get(key)
      if (!current || now >= current.openedAt + SOURCE_WINDOW_MS) {
        if (!current && windows.size >= DISPLAY_REFUSAL_SOURCES_MAX) {
          let oldest = key, earliest = Infinity
          for (const [id, { openedAt }] of windows) {
            if (now >= openedAt + SOURCE_WINDOW_MS) windows.delete(id)
            else if (openedAt < earliest) { oldest = id; earliest = openedAt }
          }
          if (windows.size >= DISPLAY_REFUSAL_SOURCES_MAX) windows.delete(oldest)
        }
        windows.set(key, { openedAt: now, count: 1 })
      } else current.count++
      throw error
    }
  }

  /**
   * Display calls whose credential matches no row are refused before the lock. Calls reaching the store-wide
   * advisory lock prune first and then act in one transaction. A refusal is
   * returned by `work` and thrown after the commit, so what it recorded (the prune, a failed claim) stays.
   */
  @InjectManager()
  private async locked<T>(work: (em: EntityManager, now: Date) => Promise<T | DisplayRefusal>,
    @MedusaContext() sharedContext: Context = {}): Promise<T> {
    const result = await (sharedContext.manager as EntityManager).transactional(async em => {
      await em.execute('select pg_advisory_xact_lock(hashtextextended(?, 0))', ['tally_display'])
      const now = new Date(this.now())
      await this.pruneAt(em, now)
      return work(em, now)
    })
    if (result instanceof DisplayRefusal) throw result
    return result as T
  }

  /** Deletes what has expired, as the reference server does on every call. */
  private async pruneAt(em: EntityManager, now: Date): Promise<void> {
    await em.execute('delete from tally_display_code where expires_at <= ?', [now])
    await em.execute('delete from tally_display_pending where expires_at <= ?', [now])
    await em.execute('delete from tally_display_snapshot where posted_at <= ?', [ago(now, SNAPSHOT_TTL_MS)])
    await this.dropDisplays(em, 'coalesce(last_seen_at, confirmed_at) <= ?', [ago(now, ROW_TTL_MS)])
    await em.execute(`delete from tally_display_claim_failure where opened_at <= case when id = ? then ?::timestamptz else ?::timestamptz end`,
      [STORE_KEY, ago(now, STORE_WINDOW_MS), ago(now, SOURCE_WINDOW_MS)])
    await em.execute(`delete from tally_display_device d where d.last_call_at < ?
      and not exists (select 1 from tally_display x where x.device_id = d.id)
      and not exists (select 1 from tally_display_code c where c.device_id = d.id)
      and not exists (select 1 from tally_display_pending p where p.device_id = d.id)`, [ago(now, ROW_TTL_MS)])
  }

  /** Deletes the matching displays with their token hash, snapshot and both inboxes; gives how many went. */
  private async dropDisplays(em: EntityManager, where: string, params: unknown[]): Promise<number> {
    const [{ count }] = await em.execute(`with gone as (delete from tally_display where ${where} returning id),
      snapshots as (delete from tally_display_snapshot where id in (select id from gone)),
      signals as (delete from tally_display_signal where display_id in (select id from gone))
      select count(*)::int as count from gone`, params)
    return count
  }

  /** Every till call's gate after the capability: the device key (`device_refused`), then `work` with the device id. */
  private tillCall<T>(device: TillDevice, work: (em: EntityManager, now: Date, deviceId: string) => Promise<T | DisplayRefusal>): Promise<T> {
    const keyHash = device.deviceKey ? sha256Hex(device.deviceKey) : ''
    return this.locked(async (em, now) => {
      const [known] = await em.execute('select key_hash from tally_display_device where id = ?', [device.deviceId])
      if (!keyHash || !known?.key_hash || !sameHash(keyHash, known.key_hash)) return refusal('device_refused')
      await em.execute('update tally_display_device set last_call_at = ? where id = ?', [now, device.deviceId])
      return work(em, now, device.deviceId)
    })
  }

  private async owned(em: EntityManager, table: 'tally_display' | 'tally_display_pending', id: string, deviceId: string): Promise<Row | undefined> {
    return (await em.execute(`select * from ${table} where id = ? and device_id = ?`, [id, deviceId]))[0]
  }

  @InjectManager()
  private async checkToken(token: string, @MedusaContext() sharedContext: Context = {}): Promise<void> {
    if (!token) throw refusal('token_refused')
    const [found] = await (sharedContext.manager as EntityManager).execute('select 1 from tally_display where token_hash = ?', [sha256Hex(token)])
    if (!found) throw refusal('token_refused')
  }

  @InjectManager()
  private async checkClaimSecret(secretHash: string, @MedusaContext() sharedContext: Context = {}): Promise<void> {
    const [{ known }] = await (sharedContext.manager as EntityManager).execute<{ known: boolean }[]>(
      `select exists(select 1 from tally_display_pending where secret_hash = ?) or
        exists(select 1 from tally_display where secret_hash = ? and token_hash is null) as known`, [secretHash, secretHash])
    if (!known) throw refusal('collect_refused')
  }

  /** The display a token names, marked seen; `token_refused` otherwise. */
  private async byToken(em: EntityManager, token: string, now: Date): Promise<Row | DisplayRefusal> {
    const tokenHash = token ? sha256Hex(token) : ''
    const [row] = tokenHash ? await em.execute('select id, device_id, token_hash from tally_display where token_hash = ?', [tokenHash]) : []
    // Found by its hash; the constant-time check is the spec's rule for every secret comparison.
    if (!row || !sameHash(row.token_hash, tokenHash)) return refusal('token_refused')
    await em.execute('update tally_display set last_seen_at = ? where id = ?', [now, row.id])
    return row
  }

  async registerDevice(cashierId: string, deviceId: string): Promise<{ deviceKey: string }> {
    const deviceKey = newSecret()
    const keyHash = sha256Hex(deviceKey)
    return this.locked(async (em, now) => {
      const [known] = await em.execute('select key_hash, adopted from tally_display_device where id = ?', [deviceId])
      if (known && (known.key_hash !== null || known.adopted)) return refusal('device_refused')
      if (known) {
        // A pre-migration id adopts its rows, once, recorded with the cashier.
        await em.execute('insert into tally_display_adoption (id, device_id, cashier_id, adopted_at) values (?, ?, ?, ?)',
          [newId(), deviceId, cashierId, now])
        await em.execute('update tally_display_device set key_hash = ?, adopted = true, last_call_at = ? where id = ?', [keyHash, now, deviceId])
      } else {
        await em.execute('insert into tally_display_device (id, key_hash, adopted, last_call_at) values (?, ?, false, ?)', [deviceId, keyHash, now])
      }
      return { deviceKey }
    })
  }

  async mint(device: TillDevice): Promise<{ code: string; expiresAt: string }> {
    return this.tillCall(device, async (em, now, deviceId) => {
      const [{ count }] = await em.execute('select count(*)::int as count from tally_display_code where device_id = ? and not spent', [deviceId])
      if (count >= MAX_UNSPENT_CODES) return refusal('limit')
      let code: string
      do code = digits(6); while ((await em.execute('select 1 from tally_display_code where id = ?', [code])).length)
      const expiresAt = new Date(now.getTime() + CODE_TTL_MS)
      await em.execute('insert into tally_display_code (id, device_id, expires_at) values (?, ?, ?)', [code, deviceId, expiresAt])
      return { code, expiresAt: expiresAt.toISOString() }
    })
  }

  async pending(device: TillDevice) {
    return this.tillCall(device, async (em, _now, deviceId) => (await em.execute(
      'select id, display_name, check_code, expires_at from tally_display_pending where device_id = ? order by expires_at, id', [deviceId],
    )).map((row: Row) => ({
      claimId: row.id as string, displayName: row.display_name as string, checkCode: row.check_code as string,
      expiresAt: new Date(row.expires_at).toISOString(),
    })))
  }

  async confirm(device: TillDevice, cashierId: string, claimId: string): Promise<void> {
    return this.tillCall(device, async (em, now, deviceId) => {
      const entry = await this.owned(em, 'tally_display_pending', claimId, deviceId)
      if (!entry) return refusal('not_found')
      await em.execute('delete from tally_display_pending where id = ?', [claimId])
      // A moving display: its old row, token, snapshot and inboxes go in this same step, and its id carries over.
      const moving = entry.moving_display_id === null ? 0 : await this.dropDisplays(em, 'id = ?', [entry.moving_display_id])
      // The token is made at the first collect, so only its hash is ever stored; the claim secret's hash waits here.
      await em.execute(`insert into tally_display (id, device_id, name, cashier_id, confirmed_at, secret_hash)
        values (?, ?, ?, ?, ?, ?)`, [moving ? entry.moving_display_id : newId(), deviceId, entry.display_name, cashierId, now, entry.secret_hash])
    })
  }

  async decline(device: TillDevice, claimId: string): Promise<void> {
    return this.tillCall(device, async (em, _now, deviceId) => {
      if (!(await this.owned(em, 'tally_display_pending', claimId, deviceId))) return refusal('not_found')
      await em.execute('delete from tally_display_pending where id = ?', [claimId])
    })
  }

  async list(device: TillDevice) {
    return this.tillCall(device, async (em, now, deviceId) => (await em.execute(
      'select id, name, cashier_id, last_seen_at from tally_display where device_id = ? order by confirmed_at, id', [deviceId],
    )).map((row: Row) => {
      const seen = row.last_seen_at === null ? null : new Date(row.last_seen_at)
      return {
        displayId: row.id as string, name: row.name as string, cashierId: row.cashier_id as string,
        lastSeenAt: seen && seen.toISOString(), connected: seen !== null && now.getTime() - seen.getTime() <= CONNECTED_MS,
      }
    }))
  }

  async forget(device: TillDevice, displayId: string): Promise<void> {
    return this.tillCall(device, async (em, _now, deviceId) => {
      if (!(await this.owned(em, 'tally_display', displayId, deviceId))) return refusal('not_found')
      await this.dropDisplays(em, 'id = ?', [displayId])
    })
  }

  async sendSignal(device: TillDevice, displayId: string, message: SignalMessage): Promise<void> {
    return this.tillCall(device, async (em, _now, deviceId) => {
      if (!(await this.owned(em, 'tally_display', displayId, deviceId))) return refusal('not_found')
      await em.execute(`insert into tally_display_signal (display_id, device_id, direction, type, payload) values (?, ?, 'to_display', ?, ?)`,
        [displayId, deviceId, message.type, message.payload])
      await this.capSignalInbox(em, 'to_display', displayId)
    })
  }

  private async capSignalInbox(em: EntityManager, direction: 'to_display' | 'to_till', displayId: string): Promise<void> {
    await em.execute(`delete from tally_display_signal where direction = ? and display_id = ?
      and seq not in (select seq from tally_display_signal where direction = ? and display_id = ?
        order by seq desc limit ?)`, [direction, displayId, direction, displayId, SIGNAL_INBOX_MAX])
  }

  /** Drains this device's inbox: each message once, in send order, only from displays it owns now. */
  async receiveSignals(device: TillDevice): Promise<Array<SignalMessage & { displayId: string }>> {
    return this.tillCall(device, async (em, _now, deviceId) => (await em.execute(`with drained as (
        delete from tally_display_signal where direction = 'to_till' and device_id = ? returning seq, display_id, type, payload)
      select d.display_id, d.type, d.payload from drained d join tally_display x on x.id = d.display_id and x.device_id = ?
      order by d.seq`, [deviceId, deviceId])).map((row: Row) => ({ type: row.type, payload: row.payload, displayId: row.display_id })))
  }

  async postSnapshot(device: TillDevice, displayId: string, body: unknown): Promise<void> {
    return this.tillCall(device, async (em, now, deviceId) => {
      if (!(await this.owned(em, 'tally_display', displayId, deviceId))) return refusal('not_found')
      const text = JSON.stringify(body) ?? 'null'
      if (Buffer.byteLength(text, 'utf8') > SNAPSHOT_MAX_BYTES) return refusal('too_large')
      await em.execute(`insert into tally_display_snapshot (id, body, posted_at) values (?, ?, ?)
        on conflict (id) do update set body = excluded.body, posted_at = excluded.posted_at, updated_at = now()`, [displayId, text, now])
    })
  }

  @InjectManager()
  private async checkClaimLimit(key: string, @MedusaContext() sharedContext: Context = {}): Promise<void> {
    const now = new Date(this.now())
    const [blocked] = await (sharedContext.manager as EntityManager).execute(`select 1 from tally_display_claim_failure where
      (id = ? and opened_at > ? and failures >= ?) or (id = ? and opened_at > ? and failures >= ?)`,
      [STORE_KEY, ago(now, STORE_WINDOW_MS), STORE_MAX, key, ago(now, SOURCE_WINDOW_MS), SOURCE_MAX])
    if (blocked) throw refusal('claim_refused')
  }

  async claim(source: string, request: { code: string; displayName: string; token?: string }): Promise<{ claimSecret: string; checkCode: string }> {
    const claimSecret = newSecret()
    const secretHash = sha256Hex(claimSecret)
    const tokenHash = request.token ? sha256Hex(request.token) : null
    const key = `source:${rateLimitSource(source)}`
    await this.checkClaimLimit(key)
    return this.locked(async (em, now) => {
      const windows = await em.execute('select id, failures from tally_display_claim_failure where id in (?, ?)', [STORE_KEY, key])
      const failures = (id: string): number => windows.find((w: Row) => w.id === id)?.failures ?? 0
      // Over either limit every claim is refused, uncounted, and spends nothing. A code is claimable only unspent and unexpired.
      if (failures(STORE_KEY) >= STORE_MAX || failures(key) >= SOURCE_MAX) return refusal('claim_refused')
      const [entry] = await em.execute(`select device_id, expires_at from tally_display_code where id = ? and not spent and expires_at > ?`,
        [request.code, now])
      if (!entry) {
        // Each window is opened by its first failure.
        await em.execute(`insert into tally_display_claim_failure (id, opened_at, failures) values (?, ?, 1), (?, ?, 1)
          on conflict (id) do update set failures = tally_display_claim_failure.failures + 1, updated_at = now()`, [key, now, STORE_KEY, now])
        return refusal('claim_refused')
      }
      await em.execute('update tally_display_code set spent = true where id = ?', [request.code])
      let checkCode: string
      // Unique per till: a till lists only its own pending pairings.
      do checkCode = digits(4)
      while ((await em.execute('select 1 from tally_display_pending where device_id = ? and check_code = ?', [entry.device_id, checkCode])).length)
      const [moving] = tokenHash === null ? [] : await em.execute('select id from tally_display where token_hash = ?', [tokenHash])
      await em.execute(`insert into tally_display_pending (id, device_id, secret_hash, display_name, check_code, expires_at, moving_display_id)
        values (?, ?, ?, ?, ?, ?, ?)`, [newId(), entry.device_id, secretHash, request.displayName, checkCode, entry.expires_at, moving?.id ?? null])
      return { claimSecret, checkCode }
    })
  }

  collect(claimSecret: string, source: string) { return this.displayAttempt(source, () => this.collectPairing(claimSecret)) }
  private async collectPairing(claimSecret: string): Promise<{ status: 'pending'; checkCode: string } | { status: 'paired'; displayId: string; token: string }> {
    const secretHash = sha256Hex(claimSecret)
    await this.checkClaimSecret(secretHash)
    // The token exists in plaintext only here and in this call's answer.
    const token = newSecret()
    const tokenHash = sha256Hex(token)
    return this.locked(async em => {
      const [waiting] = await em.execute('select secret_hash, check_code from tally_display_pending where secret_hash = ?', [secretHash])
      if (waiting && sameHash(waiting.secret_hash, secretHash)) return { status: 'pending' as const, checkCode: waiting.check_code as string }
      const [found] = await em.execute('select id, secret_hash from tally_display where secret_hash = ? and token_hash is null', [secretHash])
      if (!found || !sameHash(found.secret_hash, secretHash)) return refusal('collect_refused')
      await em.execute('update tally_display set secret_hash = null, token_hash = ? where id = ?', [tokenHash, found.id])
      return { status: 'paired' as const, displayId: found.id as string, token }
    })
  }

  displaySendSignal(token: string, message: SignalMessage, source: string) { return this.displayAttempt(source, () => this.sendByToken(token, message)) }
  private async sendByToken(token: string, message: SignalMessage): Promise<void> {
    await this.checkToken(token)
    return this.locked(async (em, now) => {
      const display = await this.byToken(em, token, now)
      if (display instanceof DisplayRefusal) return display
      await em.execute(`insert into tally_display_signal (display_id, device_id, direction, type, payload) values (?, ?, 'to_till', ?, ?)`,
        [display.id, display.device_id, message.type, message.payload])
      await this.capSignalInbox(em, 'to_till', display.id)
    })
  }

  displayReceiveSignals(token: string, source: string) { return this.displayAttempt(source, () => this.receiveByToken(token)) }
  private async receiveByToken(token: string): Promise<SignalMessage[]> {
    await this.checkToken(token)
    return this.locked(async (em, now) => {
      const display = await this.byToken(em, token, now)
      if (display instanceof DisplayRefusal) return display
      return (await em.execute(`with drained as (
          delete from tally_display_signal where direction = 'to_display' and display_id = ? returning seq, type, payload)
        select type, payload from drained order by seq`, [display.id])).map((row: Row) => ({ type: row.type, payload: row.payload }))
    })
  }

  readSnapshot(token: string, source: string) { return this.displayAttempt(source, () => this.snapshotByToken(token)) }
  private async snapshotByToken(token: string): Promise<unknown | null> {
    await this.checkToken(token)
    return this.locked(async (em, now) => {
      const display = await this.byToken(em, token, now)
      if (display instanceof DisplayRefusal) return display
      const [held] = await em.execute('select body from tally_display_snapshot where id = ?', [display.id])
      return held ? JSON.parse(held.body) as unknown : null
    })
  }

  /** Prunes and does nothing else. */
  async prune(): Promise<void> {
    return this.locked(async () => undefined)
  }

  /** The admin reset: deletes the device row with everything it owns, so the id registers as new, never as keyless. */
  async resetDevice(deviceId: string): Promise<{ device: boolean; displays: number; codes: number; pending: number }> {
    return this.locked(async em => {
      const displays = await this.dropDisplays(em, 'device_id = ?', [deviceId])
      const count = async (sql: string) => (await em.execute(`with gone as (${sql} returning 1) select count(*)::int as count from gone`, [deviceId]))[0].count as number
      return {
        displays,
        codes: await count('delete from tally_display_code where device_id = ?'),
        pending: await count('delete from tally_display_pending where device_id = ?'),
        device: (await count('delete from tally_display_device where id = ?')) > 0,
      }
    })
  }
}
