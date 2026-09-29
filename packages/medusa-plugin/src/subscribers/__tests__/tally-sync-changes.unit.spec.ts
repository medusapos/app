import type { SubscriberArgs } from '@medusajs/framework'
import { ContainerRegistrationKeys } from '@medusajs/framework/utils'
import { TALLY_LEDGER_MODULE } from '../../modules/tally-ledger'
import { TALLY_SYNC_MODULE } from '../../modules/tally-sync'
import tallySyncChanges from '../tally-sync-changes'

const lockTimeout = () => Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' })

function run(recordEvent: jest.Mock) {
  const logger = { debug: jest.fn(), error: jest.fn() }
  const services: Record<string, unknown> = {
    [ContainerRegistrationKeys.LOGGER]: logger,
    [TALLY_LEDGER_MODULE]: { getPluginOptions: () => ({ experimentalSync: true }) },
    [TALLY_SYNC_MODULE]: { recordEvent },
  }
  const args = { event: { name: 'product.product.updated', data: { id: 'prod_1' } }, container: { resolve: (key: string) => services[key] } }
  return { logger, done: tallySyncChanges(args as unknown as SubscriberArgs<{ id: string }>) }
}

describe('tally-sync-changes subscriber', () => {
  it('requeues a lock-timed-out event once, and the retry journals it', async () => {
    const recordEvent = jest.fn().mockRejectedValueOnce(lockTimeout()).mockResolvedValue(1)
    const { logger, done } = run(recordEvent)
    await expect(done).resolves.toBeUndefined()
    expect(recordEvent).toHaveBeenCalledTimes(2)
    await expect(recordEvent.mock.results[1].value).resolves.toBe(1)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs a twice-timed-out event once as dropped and journals nothing', async () => {
    const recordEvent = jest.fn().mockRejectedValueOnce(lockTimeout()).mockRejectedValueOnce(lockTimeout()).mockResolvedValue(1)
    const { logger, done } = run(recordEvent)
    await expect(done).resolves.toBeUndefined()
    expect(recordEvent).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0][0]).toMatch(
      /^tally_sync: journal lock timeout: .*product\.product\.updated \(prod_1\).*dropped/)
  })

  it('does not retry any other error', async () => {
    const recordEvent = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(1)
    const { logger, done } = run(recordEvent)
    await expect(done).resolves.toBeUndefined()
    expect(recordEvent).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith('tally_sync: failed to record product.product.updated (prod_1): Error: boom')
  })
})
