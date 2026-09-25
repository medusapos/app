import { execFileSync } from 'node:child_process';
import { E2E_RUN } from './ports';

export default function globalTeardown() {
  try {
    execFileSync('dropdb', ['--if-exists', '--force', E2E_RUN.database], {
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
    console.warn(`Warning: could not drop ${E2E_RUN.database} during teardown:`, error);
  }
}
