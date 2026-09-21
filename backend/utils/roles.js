import pool from '../db/connection.js';

// ── detectRole ─────────────────────────────────────────────────
// Given a telegram_id, returns the user's role and relevant data.
// We cast telegramId to string then BIGINT to avoid JS number precision issues
// with large Telegram IDs (> 2^31).
export async function detectRole(telegramId) {
  const id = String(telegramId);

  // 1. Check admin
  const adminResult = await pool.query(
    'SELECT id, name FROM admins WHERE telegram_id = $1::bigint',
    [id]
  );
  if (adminResult.rows.length > 0) {
    return { role: 'admin', account: adminResult.rows[0] };
  }

  // 2. Check cafe owner
  const ownerResult = await pool.query(
    `SELECT co.id, co.name, co.cafe_id, c.name AS cafe_name
     FROM cafe_owners co
     JOIN cafes c ON co.cafe_id = c.id
     WHERE co.telegram_id = $1::bigint`,
    [id]
  );
  if (ownerResult.rows.length > 0) {
    return { role: 'cafe_owner', account: ownerResult.rows[0] };
  }

  // 3. Check existing customer
  const customerResult = await pool.query(
    'SELECT id, name, phone FROM global_accounts WHERE telegram_id = $1::bigint',
    [id]
  );
  if (customerResult.rows.length > 0) {
    return { role: 'customer', account: customerResult.rows[0] };
  }

  // 4. New user
  return { role: 'new', account: null };
}

// ── saveCustomer ───────────────────────────────────────────────
// Creates a global_account for a new customer.
export async function saveCustomer(telegramId, name, phone) {
  const id = String(telegramId);
  const result = await pool.query(
    `INSERT INTO global_accounts (telegram_id, name, phone)
     VALUES ($1::bigint, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE
       SET name = EXCLUDED.name
     RETURNING *`,
    [id, name, phone]
  );
  return result.rows[0];
}
