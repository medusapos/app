import { model } from '@medusajs/framework/utils'

export const TallyRegister = model.define('tally_register', {
  id: model.text().primaryKey(),
  last_closure_number: model.number().default(0),
  // The migration uses bigint for this integer; results use JSON numeric values.
  perpetual_sales_total_minor: model.number().default(0),
  // The migration uses bigint for this integer; results use JSON numeric values.
  perpetual_refunds_total_minor: model.number().default(0),
})
