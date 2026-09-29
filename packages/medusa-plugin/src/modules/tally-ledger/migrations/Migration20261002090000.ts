import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20261002090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table if exists "tally_command" drop constraint if exists "tally_command_status_check";`);
    this.addSql(`alter table if exists "tally_command" add constraint "tally_command_status_check" check ("status" in ('in_progress', 'applied', 'rejected', 'needs_admin', 'superseded'));`);
    this.addSql(`alter table if exists "tally_command" add column if not exists "superseded_by" text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`update "tally_command" set "status" = 'in_progress', "updated_at" = to_timestamp(0) where "status" = 'superseded';`);
    this.addSql(`alter table if exists "tally_command" drop column if exists "superseded_by";`);
    this.addSql(`alter table if exists "tally_command" drop constraint if exists "tally_command_status_check";`);
    this.addSql(`alter table if exists "tally_command" add constraint "tally_command_status_check" check ("status" in ('in_progress', 'applied', 'rejected', 'needs_admin'));`);
  }
}
