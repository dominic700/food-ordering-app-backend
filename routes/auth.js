import express from 'express';
import pool from '../db/connection.js';
import { telegramAuth } from '../middleware/auth.js';

const router = express.Router();

// ── POST /api/auth/init ───────────────────────────────────────
// Called when Mini App opens.
// Detects role: admin | cafe_owner | customer
// Creates global account if new customer
router.post('/init', telegramAuth, async (req, res) => {
  try {
    const { telegram_id, name } = req.telegramUser;
    const { phone } = req.body;

    // 1. Check if admin
    const adminCheck = await pool.query(
      'SELECT id, name FROM admins WHERE telegram_id = $1',
      [telegram_id]
    );
    if (adminCheck.rows.length > 0) {
      return res.json({ role: 'admin', account: adminCheck.rows[0] });
    }

    // 2. Check if cafe owner
    const ownerCheck = await pool.query(`
      SELECT co.id, co.cafe_id, co.name, co.phone, co.language,
             c.name AS cafe_name, c.logo_url, c.address, c.service_fee
      FROM cafe_owners co
      JOIN cafes c ON co.cafe_id = c.id
      WHERE co.telegram_id = $1
    `, [telegram_id]);
    if (ownerCheck.rows.length > 0) {
      return res.json({ role: 'cafe_owner', account: ownerCheck.rows[0] });
    }

    // 3. Customer — find or create global account
    let accountResult = await pool.query(
      'SELECT * FROM global_accounts WHERE telegram_id = $1',
      [telegram_id]
    );

    if (accountResult.rows.length === 0) {
      if (!phone) {
        return res.status(400).json({ error: 'Phone number required for first login' });
      }
      accountResult = await pool.query(
        `INSERT INTO global_accounts (telegram_id, name, phone)
         VALUES ($1, $2, $3) RETURNING *`,
        [telegram_id, name, phone]
      );
    }

    res.json({ role: 'customer', account: accountResult.rows[0] });

  } catch (err) {
    console.error('Auth init error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
