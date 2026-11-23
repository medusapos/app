import { DEFAULT_ICE_SERVERS, resolveIceServers, validIceServers } from '../ice-servers'
import { rateLimitSource } from '../rate-limit-source'

describe('U1: rateLimitSource', () => {
  it('gives one source for two addresses in one IPv6 /64', () => {
    expect(rateLimitSource('2001:db8:0:1::5')).toBe(rateLimitSource('2001:db8:0:1:ffff::9'))
    expect(rateLimitSource('2001:db8:0:1::5')).toBe('2001:0db8:0000:0001::/64')
    expect(rateLimitSource('2001:db8:0:2::5')).not.toBe(rateLimitSource('2001:db8:0:1::5'))
  })

  it('keeps two IPv4 addresses apart, and reads an IPv4-mapped address as IPv4', () => {
    expect(rateLimitSource('192.0.2.1')).not.toBe(rateLimitSource('192.0.2.2'))
    expect(rateLimitSource('::ffff:192.0.2.1')).toBe('192.0.2.1')
  })
})

describe('U2: the ICE server list', () => {
  it('accepts [] and a TURN entry with both username and credential', () => {
    expect(validIceServers([])).toEqual([])
    const turn = { urls: ['turn:turn.example.com:3478', 'turns:turn.example.com:5349'], username: 'u', credential: 'c' }
    expect(validIceServers([{ urls: 'stun:stun.example.com:3478' }, turn])).toEqual([{ urls: 'stun:stun.example.com:3478' }, turn])
  })

  it('refuses an http: URL and a TURN entry missing its credential', () => {
    expect(validIceServers([{ urls: 'http://stun.example.com' }])).toBeUndefined()
    expect(validIceServers([{ urls: 'turn:turn.example.com:3478', username: 'u' }])).toBeUndefined()
  })

  it('falls back to the default with one warning for an invalid list, and silently when absent', () => {
    const warn = jest.fn()
    expect(resolveIceServers([{ urls: 'http://x' }], warn)).toEqual(DEFAULT_ICE_SERVERS)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(resolveIceServers(undefined, warn)).toEqual(DEFAULT_ICE_SERVERS)
    expect(resolveIceServers([], warn)).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1)
  })
})
