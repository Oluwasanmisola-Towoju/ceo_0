require('dotenv').config();

const { pool, closePool } = require('./db/ppol');
const scheduler = require('./scheduler/cron');

async function main() {
    await pool.query('SELECT 1'); // test the database connection
    console.log('[index] Database connection OK');

    scheduler.start();
    console.log('[index] CEO_0 is running');
}

async function shutdown(signal) {
    console.log(`[index] Received ${signal}. Shutting down...`);
    try {
        await closePool();
    }
    finally {
        process.exit(0);
    }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
    console.log('[index] Fatal error during startup:', err);
    process.exit(1);
});