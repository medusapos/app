import { Migration } from '@medusajs/framework/mikro-orm/migrations'

export class Migration20260930090000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table "tally_change" (
      "seq" bigserial primary key, "collection" text not null, "object_id" text not null,
      "op" text not null check ("op" in ('upsert', 'delete')),
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null)`)
    this.addSql('create index "IDX_tally_change_object" on "tally_change" ("collection", "object_id")')
    this.addSql(`create table "tally_sync_state" (
      "id" text primary key check ("id" = 'sync'), "epoch" text not null,
      "price_list_watermark" timestamptz null, "price_window_run_at" timestamptz null,
      "created_at" timestamptz not null default now(), "updated_at" timestamptz not null default now(), "deleted_at" timestamptz null)`)
  }

  override async down(): Promise<void> {
    this.addSql('drop table if exists "tally_change", "tally_sync_state"')
  }
}
