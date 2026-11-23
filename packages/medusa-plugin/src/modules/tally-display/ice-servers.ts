/** One ICE server, in the shape `RTCPeerConnection` takes (TallyUI ADR-085 d7). */
export interface IceServer { urls: string | string[]; username?: string; credential?: string }

/** TallyUI's default ICE list (core 4.1.0 DEFAULT_ICE_SERVERS): two operators' public STUN servers. */
export const DEFAULT_ICE_SERVERS: readonly IceServer[] = Object.freeze([
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
])

const SCHEMES = ['stun:', 'stuns:', 'turn:', 'turns:']
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.length > 0

/** One entry with only `urls`, `username` and `credential`, or `undefined` when it is refused. */
function parseIceServer(entry: unknown): IceServer | undefined {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return undefined
  const { urls, username, credential } = entry as Record<string, unknown>
  const list = typeof urls === 'string' ? [urls] : urls
  if (!Array.isArray(list) || list.length === 0 || !list.every(nonEmpty)) return undefined
  if (!list.every(url => SCHEMES.some(scheme => url.startsWith(scheme)))) return undefined
  const turn = list.some(url => url.startsWith('turn:') || url.startsWith('turns:'))
  if (turn && !(nonEmpty(username) && nonEmpty(credential))) return undefined
  return {
    urls: typeof urls === 'string' ? urls : [...list],
    ...(typeof username === 'string' ? { username } : {}),
    ...(typeof credential === 'string' ? { credential } : {}),
  }
}

/** The list when every entry is valid (`[]` is LAN-only and valid), or `undefined` when any entry is refused. */
export function validIceServers(value: unknown): IceServer[] | undefined {
  if (!Array.isArray(value)) return undefined
  const parsed = value.map(parseIceServer)
  return parsed.some(server => server === undefined) ? undefined : parsed as IceServer[]
}

/** The plugin option `customerDisplay.iceServers` when valid, else the default with one warning; absent is the default. */
export function resolveIceServers(option: unknown, warn: (message: string) => void): IceServer[] {
  if (option === undefined) return DEFAULT_ICE_SERVERS.map(server => ({ ...server }))
  const valid = validIceServers(option)
  if (valid) return valid
  warn('tally_display: customerDisplay.iceServers is not a valid ICE server list, so the default STUN servers apply')
  return DEFAULT_ICE_SERVERS.map(server => ({ ...server }))
}

/** `/info`'s `customerDisplay`, core's exact wire shape (core 4.1.0 parseDisplayAdvertisement reads `v === 1`, `snapshot === 1`). */
export interface DisplayAdvertisementWire { v: 1; iceServers: IceServer[]; snapshot: 1 }

export function displayAdvertisement(options: { customerDisplay?: { iceServers?: unknown } } | undefined,
  warn: (message: string) => void): DisplayAdvertisementWire {
  return { v: 1, iceServers: resolveIceServers(options?.customerDisplay?.iceServers, warn), snapshot: 1 }
}
