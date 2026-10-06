import { Migration } from '@medusajs/framework/mikro-orm/migrations'

export class Migration20261006120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table tally_register_session add column device_id text null, add column device_name text null,
      add column superseded_at text null, add column superseded_by text null,
      add column superseded_by_device text null, add column superseded_by_session text null;
      alter table tally_register_session drop constraint tally_register_session_status_check,
      add constraint tally_register_session_status_check check (status in ('open', 'counting', 'closed', 'superseded'));
      drop index "IDX_tally_register_session_active";
      create unique index "IDX_tally_register_session_active" on tally_register_session (register_id) where status in ('open','counting') and deleted_at is null;
      create table tally_register_session_alias (id text primary key, session_id text not null,
      created_at timestamptz not null default now(), updated_at timestamptz not null default now(), deleted_at timestamptz null);
      create index "IDX_tally_register_session_alias_deleted_at" on tally_register_session_alias (deleted_at) where deleted_at is null;
      create index "IDX_tally_register_session_alias_session" on tally_register_session_alias (session_id);`);
  }

  override async down(): Promise<void> {
    this.addSql(`drop table tally_register_session_alias;
      drop index "IDX_tally_register_session_active";
      create unique index "IDX_tally_register_session_active" on tally_register_session (register_id) where status <> 'closed' and deleted_at is null;
      alter table tally_register_session drop constraint tally_register_session_status_check,
      add constraint tally_register_session_status_check check (status in ('open', 'counting', 'closed')),
      drop column device_id, drop column device_name, drop column superseded_at,
      drop column superseded_by, drop column superseded_by_device, drop column superseded_by_session;`);
  }
}
