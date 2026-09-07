// central place that knows which status transitions are legal
const { query, withTransaction } = require('../db/pool');

const ALLOWED_TRANSITIONS = {
  new:      ['enriched', 'failed', 'skipped'],
  enriched: ['drafted', 'failed', 'skipped'],
  drafted:  ['approved', 'failed', 'skipped'],
  approved: ['sent', 'failed', 'skipped'],
  sent:     ['replied', 'bounced'],
  replied:  [],
  bounced:  [],
  failed:   ['new'],     // allow manual/automated retry from the top
  skipped:  ['new'],
};

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`[stateMachine] Illegal transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

/**
 * move a prospect to a new status, validating the transition first.
 * optionally applies extra column updates (e.g. drafted copy) in the same
 * statement, so the status change and its payload commit atomically.
 *
 * @param {string} prospectId
 * @param {string} toStatus
 * @param {object} [fields]  extra columns to set alongside the status, e.g.
 *                           { email_body: '...', subject_line_1: '...' }
 */

async function transition(prospectId, toStatus, fields = {}) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      'SELECT status FROM prospects WHERE id = $1 FOR UPDATE',
      [prospectId]
    );
    if (rows.length === 0) {
      throw new Error(`[stateMachine] Prospect not found: ${prospectId}`);
    }

    const fromStatus = rows[0].status;
    const allowed = ALLOWED_TRANSITIONS[fromStatus] || [];
    if (!allowed.includes(toStatus)) {
      throw new InvalidTransitionError(fromStatus, toStatus);
    }

    const setCols = ['status = $1'];
    const values = [toStatus];
    let i = 2;
    for (const [col, val] of Object.entries(fields)) {
      setCols.push(`${col} = $${i}`);
      values.push(val);
      i += 1;
    }
    values.push(prospectId);

    const sql = `UPDATE prospects SET ${setCols.join(', ')} WHERE id = $${i} RETURNING *`;
    const result = await client.query(sql, values);
    return result.rows[0];
  });
}

// fetch a batch of prospects sitting in a given status, oldest first
async function claimBatch(status, limit = 25) {
  const { rows } = await query(
    `SELECT * FROM prospects WHERE status = $1 ORDER BY status_updated_at ASC LIMIT $2`,
    [status, limit]
  );
  return rows;
}

// mark a prospect failed with an error message, incrementing retry_count.
async function markFailed(prospectId, errorMessage) {
  return withTransaction(async (client) => {
    await client.query(
      `UPDATE prospects
         SET status = 'failed', last_error = $1, retry_count = retry_count + 1
       WHERE id = $2`,
      [errorMessage, prospectId]
    );
  });
}

// update columns on a prospect WITHOUT changing its pipeline status
async function updateFields(prospectId, fields = {}) {
  const cols = Object.keys(fields);
  if (cols.length === 0) return null;

  const setCols = cols.map((col, i) => `${col} = $${i + 1}`);
  const values = cols.map((col) => fields[col]);
  values.push(prospectId);

  const sql = `UPDATE prospects SET ${setCols.join(', ')} WHERE id = $${cols.length + 1} RETURNING *`;
  const { rows } = await query(sql, values);
  return rows[0];
}

module.exports = {
  transition,
  claimBatch,
  markFailed,
  updateFields,
  InvalidTransitionError,
  ALLOWED_TRANSITIONS,
};