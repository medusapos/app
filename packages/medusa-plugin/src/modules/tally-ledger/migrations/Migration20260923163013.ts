import { Migration } from "@medusajs/framework/mikro-orm/migrations";

export class Migration20260923163013 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "tally_command" ("id" text not null, "type" text not null, "fingerprint" text not null, "status" text check ("status" in ('in_progress', 'applied', 'rejected')) not null default 'in_progress', "result" jsonb null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "tally_command_pkey" primary key ("id"));`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_tally_command_deleted_at" ON "tally_command" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "tally_command" cascade;`);
  }

}
