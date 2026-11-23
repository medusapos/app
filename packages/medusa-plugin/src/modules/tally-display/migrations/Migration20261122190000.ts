import { Migration } from '@medusajs/framework/mikro-orm/migrations'

const STAMPS = 'created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz null'

export class Migration20261122190000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table tally_display_device (id text primary key, key_hash text null,
      adopted boolean not null default false, last_call_at timestamptz not null, ${STAMPS});
    create table tally_display_code (id text primary key, device_id text not null, expires_at timestamptz not null,
      spent boolean not null default false, ${STAMPS});
    create index "IDX_tally_display_code_device" on tally_display_code (device_id);
    create table tally_display_pending (id text primary key, device_id text not null, secret_hash text not null,
      display_name text not null, check_code text not null, expires_at timestamptz not null, moving_display_id text null, ${STAMPS});
    create index "IDX_tally_display_pending_device" on tally_display_pending (device_id);
    create unique index "IDX_tally_display_pending_secret" on tally_display_pending (secret_hash);
    create table tally_display (id text primary key, device_id text not null, name text not null, cashier_id text not null,
      confirmed_at timestamptz not null, last_seen_at timestamptz null, token_hash text null, secret_hash text null, ${STAMPS});
    create index "IDX_tally_display_device" on tally_display (device_id);
    create unique index "IDX_tally_display_token" on tally_display (token_hash) where token_hash is not null;
    create unique index "IDX_tally_display_secret" on tally_display (secret_hash) where secret_hash is not null;
    create table tally_display_signal (seq bigserial primary key, display_id text not null, device_id text not null,
      direction text not null check (direction in ('to_display', 'to_till')), type text not null, payload text not null, ${STAMPS});
    create index "IDX_tally_display_signal_inbox" on tally_display_signal (direction, display_id, device_id);
    create table tally_display_snapshot (id text primary key, body text not null, posted_at timestamptz not null, ${STAMPS});
    create table tally_display_claim_failure (id text primary key, opened_at timestamptz not null, failures integer not null, ${STAMPS});
    create table tally_display_adoption (id text primary key, device_id text not null, cashier_id text not null,
      adopted_at timestamptz not null, ${STAMPS});`)
  }

  override async down(): Promise<void> {
    this.addSql(`drop table tally_display_adoption; drop table tally_display_claim_failure; drop table tally_display_snapshot;
      drop table tally_display_signal; drop table tally_display; drop table tally_display_pending;
      drop table tally_display_code; drop table tally_display_device;`)
  }
}
