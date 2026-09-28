import { MedusaError } from '@medusajs/framework/utils'
import { isStoreConfigurationError, StoreConfigurationError } from '../store-configuration-error'

it('recognizes a StoreConfigurationError and preserves INVALID_DATA and its message', () => {
  const error = new StoreConfigurationError('Missing shipping option')
  expect(isStoreConfigurationError(error)).toBe(true)
  expect(error).toBeInstanceOf(MedusaError)
  expect(error).toMatchObject({ type: MedusaError.Types.INVALID_DATA, message: 'Missing shipping option' })
})

it.each([
  ['Medusa INVALID_DATA', new MedusaError(MedusaError.Types.INVALID_DATA, 'probe')],
  ['Medusa NOT_ALLOWED', new MedusaError(MedusaError.Types.NOT_ALLOWED, 'probe')],
  ['Error', new Error('probe')],
  ['TypeError', new TypeError('probe')],
  ['undefined', undefined],
])('does not classify %s as a StoreConfigurationError', (_name, error) => {
  expect(isStoreConfigurationError(error)).toBe(false)
})
