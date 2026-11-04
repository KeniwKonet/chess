/**
 * Tests run on the embedded database by default. With TEST_DATABASE_URL set
 * they run on that real Postgres instead (wiped before each server start):
 *   TEST_DATABASE_URL=postgres://postgres@localhost:5544/chessfront npx vitest run apps/server
 */
import pg from 'pg';

export const TEST_PG = process.env.TEST_DATABASE_URL;

/** Options for startServer: a fresh database each time, unless `keep`. */
export async function testDb(dataDir: string, keep = false): Promise<{ dbUrl?: string; dataDir: string }> {
  if (!TEST_PG) return { dataDir };
  if (!keep) {
    const c = new pg.Client({ connectionString: TEST_PG });
    await c.connect();
    await c.query('drop schema public cascade; create schema public;');
    await c.end();
  }
  return { dbUrl: TEST_PG, dataDir };
}
