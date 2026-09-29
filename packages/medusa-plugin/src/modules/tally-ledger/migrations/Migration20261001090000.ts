import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// "tally_command_status_check" is Postgres's auto-name for the status check in Migration20260923163013.
export class Migration20261001090000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`alter table if exists "tally_command" drop constraint if exists "tally_command_status_check";`);
    this.addSql(`alter table if exists "tally_command" add constraint "tally_command_status_check" check ("status" in ('in_progress', 'applied', 'rejected', 'needs_admin'));`);
    this.addSql(`alter table if exists "tally_command" add column if not exists "needs_admin_reason" jsonb null;`);
  }

  override async down(): Promise<void> {
    // Parked rows go back to in_progress past the lease, so after the rollback a reclaim resumes them.
    this.addSql(`update "tally_command" set "status" = 'in_progress', "updated_at" = to_timestamp(0) where "status" = 'needs_admin';`);
    this.addSql(`alter table if exists "tally_command" drop column if exists "needs_admin_reason";`);
    this.addSql(`alter table if exists "tally_command" drop constraint if exists "tally_command_status_check";`);
    this.addSql(`alter table if exists "tally_command" add constraint "tally_command_status_check" check ("status" in ('in_progress', 'applied', 'rejected'));`);
  }

}
