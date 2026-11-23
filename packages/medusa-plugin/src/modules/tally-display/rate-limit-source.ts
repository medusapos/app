// Ported from @tallyui/core 4.1.0 customer-display/rate-limit-source.ts: the plugin imports core as types only.
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/
const HEXTET = /^[0-9a-f]{1,4}$/

/** The eight hextets of an IPv6 address, each 4 lower-case digits, or `undefined` when it is not one. */
function expandIpv6(address: string): string[] | undefined {
  let text = address.toLowerCase()
  const last = text.slice(text.lastIndexOf(':') + 1)
  if (IPV4.test(last)) {
    const [a, b, c, d] = last.split('.').map(Number)
    text = `${text.slice(0, text.length - last.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) return undefined
  const head = halves[0] ? halves[0].split(':') : []
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  const missing = 8 - head.length - tail.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail]
  if (!groups.every(group => HEXTET.test(group))) return undefined
  return groups.map(group => group.padStart(4, '0'))
}

/**
 * The key that rate-limits failed claims per source (ADR-085 d4): an IPv4 address (also IPv4-mapped `::ffff:a.b.c.d`)
 * is itself; an IPv6 address counts by its /64, as its first four hextets expanded plus `::/64`, with a zone id
 * dropped. Anything else is the input, trimmed.
 */
export function rateLimitSource(address: string): string {
  const input = address.trim()
  if (IPV4.test(input)) return input
  const zone = input.indexOf('%')
  const hextets = expandIpv6(zone >= 0 ? input.slice(0, zone) : input)
  if (!hextets) return input
  if (hextets.slice(0, 5).every(group => group === '0000') && hextets[5] === 'ffff') {
    const high = parseInt(hextets[6], 16)
    const low = parseInt(hextets[7], 16)
    return [high >> 8, high & 255, low >> 8, low & 255].join('.')
  }
  return `${hextets.slice(0, 4).join(':')}::/64`
}
