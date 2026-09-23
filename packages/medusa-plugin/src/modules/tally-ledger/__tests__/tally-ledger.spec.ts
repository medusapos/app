import { MedusaError } from '@medusajs/framework/utils'
import { moduleIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_LEDGER_MODULE } from '..'
import TallyLedgerModuleService from '../service'

moduleIntegrationTestRunner<TallyLedgerModuleService>({
  moduleName: TALLY_LEDGER_MODULE,
  resolve: './src/modules/tally-ledger',
  pathToMigrations: './src/modules/tally-ledger/migrations',
  testSuite: ({ service }) => {
    const input = {
      id: '01956c64-37c0-7000-8000-000000000001',
      type: 'order.create',
      fingerprint: 'a'.repeat(64),
    }
    const result = { order_id: 'order_123', totals: { total: 1200 } }

    it('claims a new id with its initial values and timestamp', async () => {
      const claimed = await service.claim(input)

      expect(claimed.claimed).toBe(true)
      expect(claimed.command).toMatchObject({
        ...input,
        status: 'in_progress',
        result: null,
        created_at: expect.any(Date),
      })
    })

    it('returns the same row unchanged for a duplicate id', async () => {
      const first = await service.claim(input)
      const duplicate = await service.claim(input)

      expect(duplicate).toEqual({ claimed: false, command: first.command })
      const [, count] = await service.listAndCountTallyCommands()
      expect(count).toBe(1)
    })

    it('preserves the original fingerprint for a conflicting duplicate', async () => {
      const first = await service.claim(input)
      const duplicate = await service.claim({ ...input, fingerprint: 'b'.repeat(64) })

      expect(duplicate).toEqual({ claimed: false, command: first.command })
      expect(duplicate.command.fingerprint).toBe(input.fingerprint)
    })

    it('allows exactly one of ten concurrent claims to insert the id', async () => {
      const claims = await Promise.all(
        Array.from({ length: 10 }, () => service.claim(input))
      )

      expect(claims.filter(({ claimed }) => claimed)).toHaveLength(1)
      expect(claims.every(({ command }) => command.id === input.id)).toBe(true)
      const [, count] = await service.listAndCountTallyCommands()
      expect(count).toBe(1)
    })

    it('completes an applied command and replays its result on another claim', async () => {
      await service.claim(input)
      const command = await service.complete(input.id, 'applied', result)

      expect(command.status).toBe('applied')
      expect(command.result).toEqual(result)
      expect(await service.claim(input)).toEqual({ claimed: false, command })
    })

    it('rejects completion of finished and unknown ids without changing the outcome', async () => {
      await service.claim(input)
      const command = await service.complete(input.id, 'rejected', result)

      await expect(service.complete(input.id, 'applied', { changed: true }))
        .rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED })
      await expect(service.complete('unknown', 'applied', result))
        .rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND })
      expect(await service.retrieveTallyCommand(input.id)).toEqual(command)
    })

    it('hard-deletes an in-progress command so it can be claimed again', async () => {
      await service.claim(input)
      await service.release(input.id)

      const [, count] = await service.listAndCountTallyCommands(
        {}, { withDeleted: true }
      )
      expect(count).toBe(0)
      expect((await service.claim(input)).claimed).toBe(true)
    })

    it('leaves applied and unknown ids alone when released', async () => {
      await service.claim(input)
      const command = await service.complete(input.id, 'applied', result)
      await service.release(input.id)
      await service.release('unknown')

      expect(await service.retrieveTallyCommand(input.id)).toEqual(command)
      const [, count] = await service.listAndCountTallyCommands()
      expect(count).toBe(1)
    })
  },
})
