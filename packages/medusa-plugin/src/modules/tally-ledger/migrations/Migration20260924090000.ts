import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260924090000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "tally_command" add column if not exists "stock_topups_applied" jsonb null;`);
    this.addSql(`alter table if exists "tally_command" add column if not exists "stock_topups_pending" jsonb null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "tally_command" drop column if exists "stock_topups_applied";`);
    this.addSql(`alter table if exists "tally_command" drop column if exists "stock_topups_pending";`);
  }

}
