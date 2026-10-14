import { Migration } from '@medusajs/framework/mikro-orm/migrations'

export class Migration20261008120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`create table tally_register_approval (
      id text primary key, token_hash text null, session_id text not null, variance jsonb not null,
      approved_by text null, approved_by_name text null, requested_by text not null, target_email text not null,
      expires_at timestamptz null, used_at timestamptz null, used_by_command_id text null, closure_id text null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz null);
      create unique index "IDX_tally_register_approval_token" on tally_register_approval (token_hash) where token_hash is not null;
      create index "IDX_tally_register_approval_actor" on tally_register_approval (requested_by, created_at);
      create index "IDX_tally_register_approval_email" on tally_register_approval (target_email, created_at);
      create index "IDX_tally_register_approval_deleted_at" on tally_register_approval (deleted_at) where deleted_at is null;
      alter table tally_register_closure add column approval_id text null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table tally_register_closure drop column approval_id;
      drop table tally_register_approval;`);
  }
}
