import { Migration } from '@medusajs/framework/mikro-orm/migrations'

export class Migration20261007120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`alter table tally_register_session add column open_contract integer null;`);
  }

  override async down(): Promise<void> {
    this.addSql(`alter table tally_register_session drop column open_contract;`);
  }
}
