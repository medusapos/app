import { APPROVAL_FAILURE_WINDOW_MS } from '../../../../modules/tally-register/service'
import { POS_CASHIER_POLICIES, POS_MANAGER_POLICIES } from '../../../../scripts/tally-pos-roles'
import { createDeviceClearAttempts } from '../device-clear-approvals/attempts'

function setup() {
  let time = 1_000_000
  const attempts = createDeviceClearAttempts(() => time)
  return { attempts, advance: (ms: number) => { time += ms } }
}

it('refuses an actor after five failed attempts and still admits another actor', () => {
  const { attempts } = setup()
  for (let i = 0; i < 5; i++) expect(attempts.admit('user_a', `m${i}@example.com`)).toBeDefined()
  expect(attempts.admit('user_a', 'other@example.com')).toBeUndefined()
  expect(attempts.admit('user_b', 'm0@example.com')).toBeDefined()
})

it('refuses an email after ten failures across two actors, normalising its case and padding', () => {
  const { attempts } = setup()
  for (let i = 0; i < 5; i++) expect(attempts.admit('user_a', 'manager@example.com')).toBeDefined()
  for (let i = 0; i < 5; i++) expect(attempts.admit('user_b', '  Manager@Example.COM ')).toBeDefined()
  expect(attempts.admit('user_c', 'MANAGER@example.com')).toBeUndefined()
  expect(attempts.admit('user_c', 'someone@example.com')).toBeDefined()
})

it('a success frees its slot: 4 failures, 1 success and 1 failure leave the actor admitted once more', () => {
  const { attempts } = setup()
  for (let i = 0; i < 4; i++) expect(attempts.admit('user_a', 'manager@example.com')).toBeDefined()
  const success = attempts.admit('user_a', 'manager@example.com')
  expect(success).toBeDefined()
  success!.succeed()
  success!.succeed()
  expect(attempts.admit('user_a', 'manager@example.com')).toBeDefined()
  expect(attempts.admit('user_a', 'manager@example.com')).toBeUndefined()
})

it('stops counting attempts older than the failure window', () => {
  const { attempts, advance } = setup()
  for (let i = 0; i < 5; i++) expect(attempts.admit('user_a', 'manager@example.com')).toBeDefined()
  advance(APPROVAL_FAILURE_WINDOW_MS - 1)
  expect(attempts.admit('user_a', 'manager@example.com')).toBeUndefined()
  advance(1)
  expect(attempts.admit('user_a', 'manager@example.com')).toBeDefined()
})

it('grants device-clear and variance approval to the POS manager only', () => {
  expect(POS_MANAGER_POLICIES).toEqual(expect.arrayContaining(['tally_pos:clear_device', 'tally_pos:approve_variance']))
  expect(POS_CASHIER_POLICIES).not.toContain('tally_pos:clear_device')
  expect(POS_CASHIER_POLICIES).not.toContain('tally_pos:approve_variance')
})
