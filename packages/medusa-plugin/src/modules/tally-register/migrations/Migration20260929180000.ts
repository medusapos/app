import { Migration } from '@medusajs/framework/mikro-orm/migrations'

export class Migration20260929180000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table "tally_register" (
      "id" text primary key, "last_closure_number" integer not null default 0,
      "perpetual_sales_total_minor" bigint not null default 0, "perpetual_refunds_total_minor" bigint not null default 0,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null);`);
    this.addSql(`create table "tally_register_session" (
      "id" text primary key, "register_id" text not null, "store_key" text null,
      "status" text not null check ("status" in ('open', 'counting', 'closed')),
      "business_day" text null, "opened_at" text not null, "opened_by" text null,
      "expected_float_minor" integer null, "counted_float_minor" integer not null, "opening_variance_minor" integer null,
      "status_at" text null, "closed_at" text null, "closed_by" text null, "approved_by" text null, "counted" jsonb null,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null);`);
    this.addSql(`create unique index "IDX_tally_register_session_active" on "tally_register_session" ("register_id") where status <> 'closed' and deleted_at is null;`);
    this.addSql(`create table "tally_register_movement" (
      "id" text primary key, "session_id" text not null, "type" text not null check ("type" in ('paid_in', 'paid_out', 'no_sale', 'void')),
      "amount_minor" integer not null, "reason" text null, "created_at_client" text not null,
      "created_by" text null, "voids" text null, "voided_by" text null,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null);`);
    this.addSql(`create index "IDX_tally_register_movement_session" on "tally_register_movement" ("session_id");`);
    this.addSql(`create table "tally_register_closure" (
      "id" text primary key, "session_id" text not null unique, "register_id" text not null, "number" integer not null,
      "business_day" text null, "opened_at" text not null, "closed_at" text not null, "closed_by" text null, "approved_by" text null,
      "till_expected" jsonb not null, "counted" jsonb not null, "expected" jsonb null, "variance" jsonb null,
      "period_sales_total_minor" bigint not null, "period_refunds_total_minor" bigint not null,
      "perpetual_sales_total_minor" bigint not null, "perpetual_refunds_total_minor" bigint not null,
      "unsynced_count" integer not null, "unsynced_total_minor" bigint not null,
      "software_version" text not null, "order_ids" jsonb not null, "movement_ids" jsonb not null,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null);`);
    this.addSql(`create unique index "IDX_tally_register_closure_number" on "tally_register_closure" ("register_id", "number");`);
    for (const table of ['tally_register', 'tally_register_session', 'tally_register_movement', 'tally_register_closure']) {
      this.addSql(`create index "IDX_${table}_deleted_at" on "${table}" ("deleted_at") where deleted_at is null;`);
    }
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "tally_register_closure", "tally_register_movement", "tally_register_session", "tally_register" cascade;');
  }
}
