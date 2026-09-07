// single shared pg Pool for the whole process
require('dotenv').config();
const { Pool } = require('pg');

const requiredEnv = ['DATABASE_URL'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    throw new Error(`[db/pool] Missing required env var: ${key}`);
  }
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PGPOOL_MAX || 10),
  idleTimeoutMillis: Number(process.env.PGPOOL_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PGPOOL_CONN_TIMEOUT_MS || 5000),
});

// surface pool-level letting them crash silently
pool.on('error', (err) => {
  console.error('[db/pool] Unexpected error on idle client', err);
});

/**
 * run a single query against the pool. Prefer this for one-off statements —
 * it automatically acquires and releases a client.
 * @param {string} text
 * @param {Array<any>} [params]
 */

async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  if (process.env.DEBUG_SQL) {
    console.log('[db/pool] query', { text, ms: Date.now() - start, rows: result.rowCount });
  }
  return result;
}

//  acquire a dedicated client for a multi-statement transaction
async function getClient() {
  const client = await pool.connect();
  const release = client.release.bind(client);

  // guard against a caller forgetting to release: warn after 5s held
  const timeout = setTimeout(() => {
    console.warn('[db/pool] A client has been checked out for >5s — possible leak.');
  }, 5000);

  client.release = () => {
    clearTimeout(timeout);
    client.release = release;
    return release();
  };

  return client;
}

/**
 * Safely run a callback inside a BEGIN/COMMIT transaction. Rolls back and
 * re-throws on any error, and always releases the client.
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 */

async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// graceful shutdown — call from process signal handlers
async function closePool() {
  await pool.end();
}

module.exports = { pool, query, getClient, withTransaction, closePool };