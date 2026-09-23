import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260923165050 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "tally_command" add column if not exists "claim_token" text not null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table if exists "tally_command" drop column if exists "claim_token";`);
  }

}
