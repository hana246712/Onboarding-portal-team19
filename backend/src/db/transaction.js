// Runs fn(client) inside one database transaction: all of it is saved, or none of it.

const pool = require('./pool');

async function inTransaction(fn) {
  const client = await pool.db().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { inTransaction };
