import { Migration } from "@medusajs/framework/mikro-orm/migrations";

// tally_refund: one row per till refund (ADR 0026 decision 3). One-way storage: down() drops the refund records.
export class Migration20261122090000 extends Migration {

  override async up(): Promise<void> {
    this.addSql(`create table if not exists "tally_refund" ("id" text not null, "client_refund_id" text not null, "command_id" text not null, "order_id" text not null, "session_id" text not null, "status" text check ("status" in ('in_progress', 'applied', 'needs_admin')) not null default 'in_progress', "lines" jsonb not null, "shipping_minor" bigint not null, "adjustment_minor" bigint not null, "total_minor" bigint not null, "reason" text not null, "by_method" jsonb not null, "refunds" jsonb not null, "return_id" text null, "received_at" timestamptz null, "medusa_refund_id" text null, "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null, constraint "tally_refund_pkey" primary key ("id"));`);
    this.addSql(`CREATE UNIQUE INDEX IF NOT EXISTS "IDX_tally_refund_client_refund_id" ON "tally_refund" ("client_refund_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_tally_refund_session_status" ON "tally_refund" ("session_id", "status");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_tally_refund_order" ON "tally_refund" ("order_id");`);
    this.addSql(`CREATE INDEX IF NOT EXISTS "IDX_tally_refund_deleted_at" ON "tally_refund" ("deleted_at") WHERE deleted_at IS NULL;`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "tally_refund" cascade;`);
  }

}
