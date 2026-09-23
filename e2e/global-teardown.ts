import { execFileSync } from 'node:child_process';

export default function globalTeardown() {
  try {
    execFileSync('dropdb', ['--if-exists', '--force', 'medusapos_e2e'], {
      env: {
        ...process.env,
        PATH: `/opt/homebrew/opt/postgresql@17/bin:${process.env.PATH}`,
        PGUSER: process.env.DB_USERNAME || 'claude',
        PGPASSWORD: process.env.DB_PASSWORD || '',
        PGHOST: process.env.DB_HOST || 'localhost',
        PGPORT: '5432',
      },
      stdio: 'pipe',
    });
  } catch (error) {
    console.warn('Warning: could not drop medusapos_e2e during teardown:', error);
  }
}
