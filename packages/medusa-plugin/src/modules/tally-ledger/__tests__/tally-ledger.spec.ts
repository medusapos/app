import type { CommandResult } from '@tallyui/core'
import { MedusaError } from '@medusajs/framework/utils'
import { moduleIntegrationTestRunner } from '@medusajs/test-utils'
import { TALLY_LEDGER_MODULE } from '..'
import TallyLedgerModuleService, { CLAIM_LEASE_SECONDS } from '../service'

moduleIntegrationTestRunner<TallyLedgerModuleService>({
  moduleName: TALLY_LEDGER_MODULE,
  resolve: './src/modules/tally-ledger',
  pathToMigrations: './src/modules/tally-ledger/migrations',
  testSuite: ({ service, MikroOrmWrapper, medusaApp }) => {
    const input = {
      id: '01956c64-37c0-7000-8000-000000000001',
      type: 'order.create',
      fingerprint: 'a'.repeat(64),
    }
    const result: CommandResult = {
      id: input.id, status: 'applied',
      serverRefs: { orderId: 'order_123', totalMinor: 1200 },
    }
    afterEach(() => jest.restoreAllMocks())

    it('records top-ups with claim fencing and stores empty lists as null', async () => {
      const { command: claim } = await service.claim(input)
      const applied = [{ inventory_item_id: 'i', location_id: 'berlin', shortfall: 1 }]
      const pending = [{ inventory_item_id: 'j', location_id: 'berlin', shortfall: 2 }]
      expect(await service.recordStockTopUps(input.id, claim.claim_token, applied, pending)).toBe(true)
      expect(await service.recordStockTopUps(input.id, 'wrong-token', [], null)).toBe(false)
      expect(await service.retrieveTallyCommand(input.id)).toMatchObject({ stock_topups_applied: applied, stock_topups_pending: pending })
      expect(await service.recordStockTopUps(input.id, claim.claim_token, [], [])).toBe(true)
      expect(await service.retrieveTallyCommand(input.id)).toMatchObject({ stock_topups_applied: null, stock_topups_pending: null })
      expect(await service.recordStockTopUps(input.id, claim.claim_token, applied, null)).toBe(true)
      expect(await service.retrieveTallyCommand(input.id)).toMatchObject({ stock_topups_applied: applied, stock_topups_pending: null })
    })

    it('restores top-ups after a token change only while the command is in progress', async () => {
      const { command: first } = await service.claim(input)
      const applied = [{ inventory_item_id: 'i', location_id: 'berlin', shortfall: 1 }]
      const pending = [{ inventory_item_id: 'j', location_id: 'berlin', shortfall: 2 }]
      await service.recordStockTopUps(input.id, first.claim_token, applied, null)
      await service.release(input.id, first.claim_token)
      const { command: next } = await service.claim(input)
      expect(next.claim_token).not.toBe(first.claim_token)
      await service.restoreStockTopUps(input.id, [], pending)
      expect(await service.retrieveTallyCommand(input.id)).toMatchObject({
        status: 'in_progress', claim_token: next.claim_token, stock_topups_applied: null, stock_topups_pending: pending,
      })
      await service.restoreStockTopUps(input.id, applied, null)
      const completed = await service.complete(input.id, next.claim_token, result)
      expect(completed).toMatchObject({ stock_topups_applied: applied, stock_topups_pending: null })
      await service.restoreStockTopUps(input.id, [], pending)
      expect(await service.retrieveTallyCommand(input.id)).toEqual(completed)
    })

    it('keeps applied top-ups on release and permits an immediate re-claim', async () => {
      const { command: claim } = await service.claim(input)
      const applied = [{ inventory_item_id: 'i', location_id: 'berlin', shortfall: 1 }]
      await service.recordStockTopUps(input.id, claim.claim_token, applied, null)
      await service.release(input.id, claim.claim_token)
      const next = await service.claim(input)
      expect(next.claimed).toBe(true)
      expect(next.command.claim_token).not.toBe(claim.claim_token)
      expect(next.command.stock_topups_applied).toEqual(applied)
    })

    it('deletes a released row without applied top-ups', async () => {
      const { command: claim } = await service.claim(input)
      await service.recordStockTopUps(input.id, claim.claim_token, [], [{ inventory_item_id: 'i', location_id: 'berlin', shortfall: 1 }])
      await service.release(input.id, claim.claim_token)
      expect(await service.listTallyCommands({ id: input.id })).toEqual([])
    })

    it('asserts the current in-progress claim', async () => {
      const { command: claim } = await service.claim(input)
      await expect(service.assertClaim(input.id, claim.claim_token)).resolves.toBeUndefined()
    })

    it('rejects an old token after a lease re-claim', async () => {
      const { command: first } = await service.claim(input)
      await MikroOrmWrapper.forkManager().execute(
        `update tally_command set updated_at = now() - make_interval(secs => ?) where id = ?`,
        [CLAIM_LEASE_SECONDS + 1, input.id]
      )
      const { command: next } = await service.claim(input)
      await expect(service.assertClaim(input.id, first.claim_token))
        .rejects.toMatchObject({ type: MedusaError.Types.CONFLICT, message: 'claim lost' })
      await expect(service.assertClaim(input.id, next.claim_token)).resolves.toBeUndefined()
    })

    it('rejects a claim assertion for a completed command', async () => {
      const { command: claim } = await service.claim(input)
      await service.complete(input.id, claim.claim_token, result)
      await expect(service.assertClaim(input.id, claim.claim_token))
        .rejects.toMatchObject({ type: MedusaError.Types.CONFLICT, message: 'claim lost' })
    })

    it('rejects a claim assertion for an unknown id', async () => {
      await expect(service.assertClaim('unknown', 'unknown-token'))
        .rejects.toMatchObject({ type: MedusaError.Types.CONFLICT, message: 'claim lost' })
    })

    it('claims a new id with its initial values and timestamp', async () => {
      const claimed = await service.claim(input)

      expect(claimed.claimed).toBe(true)
      if (!claimed.claimed) throw new Error('Expected claim')
      expect(claimed.claimToken).toBe(claimed.command.claim_token)
      expect(claimed.command).toMatchObject({
        ...input,
        claim_token: expect.any(String),
        status: 'in_progress',
        result: null,
        created_at: expect.any(Date),
      })
    })

    it('does not re-claim a fresh in-progress row', async () => {
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
      const { command: claim } = await service.claim(input)
      const command = await service.complete(input.id, claim.claim_token, result)

      expect(command.status).toBe('applied')
      expect(command.result).toEqual(result)
      expect(await service.claim(input)).toEqual({ claimed: false, command })
    })

    it('rejects completion of finished and unknown ids without changing the outcome', async () => {
      const { command: claim } = await service.claim(input)
      const command = await service.complete(input.id, claim.claim_token, {
        id: input.id, status: 'rejected', error: { code: 'invalid_order', message: 'Invalid order' },
      })
      expect(command.status).toBe('rejected')
      expect(command.result).toMatchObject({ status: 'rejected', error: { code: 'invalid_order' } })

      await expect(service.complete(input.id, claim.claim_token, result))
        .rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED })
      await expect(service.complete('unknown', claim.claim_token, { ...result, id: 'unknown' }))
        .rejects.toMatchObject({ type: MedusaError.Types.NOT_FOUND })
      expect(await service.retrieveTallyCommand(input.id)).toEqual(command)
    })

    it('hard-deletes an in-progress command so it can be claimed again', async () => {
      const { command: claim } = await service.claim(input)
      await service.release(input.id, claim.claim_token)

      const [, count] = await service.listAndCountTallyCommands(
        {}, { withDeleted: true }
      )
      expect(count).toBe(0)
      expect((await service.claim(input)).claimed).toBe(true)
    })

    it('leaves applied and unknown ids alone when released', async () => {
      const { command: claim } = await service.claim(input)
      const command = await service.complete(input.id, claim.claim_token, result)
      await service.release(input.id, claim.claim_token)
      await service.release('unknown', claim.claim_token)

      expect(await service.retrieveTallyCommand(input.id)).toEqual(command)
      const [, count] = await service.listAndCountTallyCommands()
      expect(count).toBe(1)
    })

    it('re-claims an expired lease and fences out the old worker', async () => {
      const first = await service.claim(input)
      await MikroOrmWrapper.forkManager().execute(
        `update tally_command set updated_at = now() - make_interval(secs => ?) where id = ?`,
        [CLAIM_LEASE_SECONDS + 1, input.id]
      )
      const next = await service.claim(input)
      expect(next.claimed).toBe(true)
      if (!next.claimed) throw new Error('Expected re-claim')
      expect(next.claimToken).not.toBe(first.command.claim_token)
      expect(next.command.claim_token).toBe(next.claimToken)
      expect(next.command.updated_at.getTime()).toBeGreaterThanOrEqual(first.command.updated_at.getTime())
      await expect(service.complete(input.id, first.command.claim_token, result))
        .rejects.toMatchObject({ type: MedusaError.Types.NOT_ALLOWED })
      await service.release(input.id, first.command.claim_token)
      expect(await service.retrieveTallyCommand(input.id)).toEqual(next.command)
      expect((await service.complete(input.id, next.claimToken, result)).result).toEqual(result)
    })

    it('preserves the fingerprint and token of an aged conflicting command', async () => {
      const first = await service.claim(input)
      await MikroOrmWrapper.forkManager().execute(
        `update tally_command set updated_at = now() - make_interval(secs => ?) where id = ?`,
        [CLAIM_LEASE_SECONDS + 1, input.id]
      )
      const aged = await service.retrieveTallyCommand(input.id)
      expect(await service.claim({ ...input, fingerprint: 'b'.repeat(64) }))
        .toEqual({ claimed: false, command: aged })
      expect(aged.fingerprint).toBe(input.fingerprint)
      expect(aged.claim_token).toBe(first.command.claim_token)
    })

    it('does not re-claim an aged applied command or change its result', async () => {
      const { command: claim } = await service.claim(input)
      await service.complete(input.id, claim.claim_token, result)
      await MikroOrmWrapper.forkManager().execute(
        `update tally_command set updated_at = now() - make_interval(secs => ?) where id = ?`,
        [CLAIM_LEASE_SECONDS + 1, input.id]
      )
      const aged = await service.retrieveTallyCommand(input.id)
      expect(await service.claim(input)).toEqual({ claimed: false, command: aged })
      expect(aged.result).toEqual(result)
    })

    it('reports a retryable conflict if a concurrent release wins before the read', async () => {
      await service.claim(input)
      jest.spyOn(medusaApp.modules[TALLY_LEDGER_MODULE], 'retrieveTallyCommand').mockRejectedValueOnce(
        new MedusaError(MedusaError.Types.NOT_FOUND, 'Released')
      )
      await expect(service.claim(input)).rejects.toMatchObject({ type: MedusaError.Types.CONFLICT })
    })

    it.each([
      ['invalid shape', { id: input.id, status: 'applied' }],
      ['mismatched id', { ...result, id: 'different' }],
      ['duplicate status', { ...result, status: 'duplicate' }],
    ])('rejects completion with %s without writing', async (_, invalid) => {
      const { command: claim } = await service.claim(input)
      await expect(service.complete(input.id, claim.claim_token, invalid as CommandResult))
        .rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA })
      expect(await service.retrieveTallyCommand(input.id)).toEqual(claim)
    })

    it('strips unknown fields before storing a result', async () => {
      const { command: claim } = await service.claim(input)
      await service.complete(input.id, claim.claim_token, { ...result, extra: true } as CommandResult)
      expect((await service.retrieveTallyCommand(input.id)).result).toEqual(result)
    })

    it('validates stored results when replaying a claim', async () => {
      const { command: claim } = await service.claim(input)
      await service.complete(input.id, claim.claim_token, result)
      await MikroOrmWrapper.forkManager().execute(
        `update tally_command set result = ?::jsonb where id = ?`,
        [JSON.stringify({ ...result, serverRefs: {} }), input.id]
      )
      await expect(service.claim(input)).rejects.toMatchObject({ type: MedusaError.Types.INVALID_DATA })
    })
  },
})
