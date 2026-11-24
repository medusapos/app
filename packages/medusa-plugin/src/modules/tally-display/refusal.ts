/** The seam's refusal codes this plugin answers with (TallyUI `DisplaySignallingErrorCode`, ADR-085). */
export type DisplayRefusalCode =
  | 'forbidden' | 'device_refused' | 'token_refused' | 'not_found' | 'limit' | 'claim_refused' | 'collect_refused' | 'too_large'

/** Every refusal of the display signalling service; the route answers it as `{ code, message }`. */
export class DisplayRefusal extends Error {
  constructor(readonly code: DisplayRefusalCode) {
    super(code)
    this.name = 'DisplayRefusal'
  }
}
