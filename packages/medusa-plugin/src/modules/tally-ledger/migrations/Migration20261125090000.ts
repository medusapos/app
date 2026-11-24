import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// tally_refund.money_started_at (#573): written just before a run calls the payment provider. Set with no medusa_refund_id,
// the money may have moved, so no run pays again on its own. down() drops the column.
export class Migration20261125090000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "tally_refund" add column if not exists "money_started_at" timestamptz null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "tally_refund" drop column if exists "money_started_at";`);
  }

}
