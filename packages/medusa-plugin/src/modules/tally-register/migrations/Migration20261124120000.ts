import { Migration } from '@medusajs/framework/mikro-orm/migrations'

// #544: the till's period refunds, kept only when the server's figure replaced it. Additive, no backfill.
export class Migration20261124120000 extends Migration {
  override async up(): Promise<void> { this.addSql('alter table tally_register_closure add column till_period_refunds_total_minor bigint null;') }
  override async down(): Promise<void> { this.addSql('alter table tally_register_closure drop column till_period_refunds_total_minor;') }
}
