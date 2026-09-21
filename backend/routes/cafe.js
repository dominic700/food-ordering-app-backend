import express from 'express';
import pool from '../db/connection.js';
import { telegramAuth, cafeOwnerAuth } from '../middleware/auth.js';
import { createNotification } from '../utils/notifications.js';
import { sendTelegramMessage, registrationApprovedMessage, creditLimitSetMessage } from '../utils/telegramBot.js';

const router = express.Router();
router.use(telegramAuth, cafeOwnerAuth);

// ── GET /api/cafe/dashboard ───────────────────────────────────
// Revenue is split by payment type:
//   wallet_revenue -> orders paid from deposited balance/credit
//   instant_revenue -> orders paid by cash or transfer
// so the cafe owner's Profile page can show them separately.
router.get('/dashboard', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const stats = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM orders WHERE cafe_id = $1 AND status = 'pending')               AS pending_orders,
        (SELECT COUNT(*) FROM orders WHERE cafe_id = $1 AND status = 'approved'
          AND created_at >= NOW() - INTERVAL '30 days')                                        AS approved_orders_30d,
        (SELECT COUNT(*) FROM orders WHERE cafe_id = $1
          AND created_at::date = CURRENT_DATE)                                                 AS orders_today,
        (SELECT COUNT(*) FROM per_cafe_accounts WHERE cafe_id = $1 AND status = 'approved')   AS total_customers,
        (SELECT COUNT(*) FROM per_cafe_accounts WHERE cafe_id = $1 AND status = 'pending')    AS pending_registrations,
        (SELECT COUNT(*) FROM per_cafe_accounts WHERE cafe_id = $1 AND status = 'approved'
          AND balance < 0)                                                                      AS accounts_in_credit,
        (SELECT COALESCE(SUM(total),0) FROM orders WHERE cafe_id = $1
          AND status = 'approved' AND created_at >= NOW() - INTERVAL '30 days')               AS revenue_30d,
        (SELECT COALESCE(SUM(total),0) FROM orders WHERE cafe_id = $1
          AND status = 'approved' AND payment_method = 'wallet'
          AND created_at >= NOW() - INTERVAL '30 days')                                        AS wallet_revenue_30d,
        (SELECT COALESCE(SUM(total),0) FROM orders WHERE cafe_id = $1
          AND status = 'approved' AND payment_method IN ('cash','transfer')
          AND created_at >= NOW() - INTERVAL '30 days')                                        AS instant_revenue_30d,
        (SELECT COALESCE(SUM(total),0) FROM orders WHERE cafe_id = $1
          AND status = 'approved' AND created_at::date = CURRENT_DATE)                         AS revenue_today,
        (SELECT COALESCE(SUM(total),0) FROM orders WHERE cafe_id = $1
          AND status = 'approved' AND payment_method = 'wallet'
          AND created_at::date = CURRENT_DATE)                                                  AS wallet_revenue_today,
        (SELECT COALESCE(SUM(total),0) FROM orders WHERE cafe_id = $1
          AND status = 'approved' AND payment_method IN ('cash','transfer')
          AND created_at::date = CURRENT_DATE)                                                  AS instant_revenue_today,
        (SELECT COALESCE(SUM(amount),0) FROM deposits WHERE cafe_id = $1
          AND status = 'verified' AND created_at >= NOW() - INTERVAL '30 days')                AS deposits_30d
    `, [cafe_id]);
    res.json(stats.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/cafe/registrations ───────────────────────────────
router.get('/registrations', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(`
      SELECT pca.id, pca.status, pca.registered_at, ga.name, ga.phone, ga.telegram_id
      FROM per_cafe_accounts pca
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      WHERE pca.cafe_id = $1 AND pca.status = 'pending'
      ORDER BY pca.registered_at ASC
    `, [cafe_id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/cafe/registrations/:pcaId/approve ─────────────
router.patch('/registrations/:pcaId/approve', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(`
      UPDATE per_cafe_accounts
      SET status = 'approved', approved_at = NOW()
      WHERE id = $1 AND cafe_id = $2 AND status = 'pending'
      RETURNING *
    `, [req.params.pcaId, cafe_id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Registration not found' });
    const pca = result.rows[0];

    const ga = await pool.query('SELECT telegram_id, name, language FROM global_accounts WHERE id = $1', [pca.global_account_id]);
    const cafe = await pool.query('SELECT name FROM cafes WHERE id = $1', [cafe_id]);
    if (ga.rows.length > 0) {
      const cafeName = cafe.rows[0]?.name || 'The cafe';

      sendTelegramMessage(
        ga.rows[0].telegram_id,
        registrationApprovedMessage(cafeName, ga.rows[0].language)
      );

      createNotification({
        telegramId: ga.rows[0].telegram_id,
        cafeId:     cafe_id,
        type:       'registration_approved',
        title:      `Registration approved!`,
        body:       `${cafeName} approved your account. You can now use wallet balance and credit.`
      });
    }

    res.json(pca);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/cafe/registrations/:pcaId/reject ──────────────
router.patch('/registrations/:pcaId/reject', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(`
      UPDATE per_cafe_accounts SET status = 'suspended'
      WHERE id = $1 AND cafe_id = $2 AND status = 'pending'
      RETURNING *
    `, [req.params.pcaId, cafe_id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Registration not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/cafe/customers ───────────────────────────────────
// All approved customers, with their single signed balance and
// credit_limit (the floor the cafe owner set) — used by the
// Customers page.
router.get('/customers', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(`
      SELECT pca.id, pca.balance, pca.credit_limit,
             pca.status, pca.registered_at,
             ga.name, ga.phone, ga.telegram_id
      FROM per_cafe_accounts pca
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      WHERE pca.cafe_id = $1 AND pca.status = 'approved'
      ORDER BY ga.name ASC
    `, [cafe_id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/cafe/customers/:pcaId ───────────────────────────
// Single customer — full profile: signed balance (positive =
// has funds, negative = using credit), credit_limit, last 30
// days orders AND deposits (each with the payer's name, even
// though the payer is always the same customer here — included
// for clarity/consistency with the design request).
router.get('/customers/:pcaId', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;

    const account = await pool.query(`
      SELECT pca.*, ga.name, ga.phone, ga.telegram_id
      FROM per_cafe_accounts pca
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      WHERE pca.id = $1 AND pca.cafe_id = $2
    `, [req.params.pcaId, cafe_id]);

    if (account.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    const customer = account.rows[0];

    const orders = await pool.query(`
      SELECT o.*,
        json_agg(json_build_object(
          'name', oi.name, 'quantity', oi.quantity, 'item_total', oi.item_total
        )) AS items
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.per_cafe_account_id = $1
        AND o.created_at >= NOW() - INTERVAL '30 days'
      GROUP BY o.id ORDER BY o.created_at DESC
    `, [req.params.pcaId]);

    const deposits = await pool.query(`
      SELECT id, amount, payment_method, transaction_number, status, created_at, verified_at
      FROM deposits
      WHERE per_cafe_account_id = $1
      ORDER BY created_at DESC
    `, [req.params.pcaId]);

    // Attach payer name to every deposit/order row for display
    const deposits_with_payer = deposits.rows.map(d => ({ ...d, payer_name: customer.name }));
    const orders_with_payer   = orders.rows.map(o => ({ ...o, payer_name: customer.name }));

    res.json({
      customer,
      orders:   orders_with_payer,
      deposits: deposits_with_payer
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/cafe/settings ─────────────────────────────────────
router.get('/settings', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(
      'SELECT id, name, service_fee, is_active FROM cafes WHERE id = $1',
      [cafe_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cafe not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/cafe/toggle ───────────────────────────────────
// Cafe owner can deactivate or reactivate their own cafe.
router.patch('/toggle', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(
      'UPDATE cafes SET is_active = NOT is_active WHERE id = $1 RETURNING id, name, is_active',
      [cafe_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cafe not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/cafe/customers/:pcaId/credit-limit ─────────────
// Cafe owner sets a customer's credit limit directly from their
// profile/detail page — no application, no deposit threshold,
// can be set or changed at any time after the customer is
// approved. This is how far NEGATIVE their balance is allowed
// to go.
router.patch('/customers/:pcaId/credit-limit', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const { credit_limit } = req.body;

    const limit = parseFloat(credit_limit);
    if (isNaN(limit) || limit < 0) {
      return res.status(400).json({ error: 'credit_limit must be a non-negative number' });
    }

    const result = await pool.query(`
      UPDATE per_cafe_accounts
      SET credit_limit = $1
      WHERE id = $2 AND cafe_id = $3 AND status = 'approved'
      RETURNING id, global_account_id, balance, credit_limit
    `, [limit, req.params.pcaId, cafe_id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Customer not found' });
    const pca = result.rows[0];

    const ga = await pool.query('SELECT telegram_id, language FROM global_accounts WHERE id = $1', [pca.global_account_id]);
    const cafe = await pool.query('SELECT name FROM cafes WHERE id = $1', [cafe_id]);
    if (ga.rows.length > 0) {
      const cafeName = cafe.rows[0]?.name || 'The cafe';

      sendTelegramMessage(
        ga.rows[0].telegram_id,
        creditLimitSetMessage(cafeName, limit, ga.rows[0].language)
      );

      createNotification({
        telegramId: ga.rows[0].telegram_id,
        cafeId:     cafe_id,
        type:       'credit_limit_set',
        title:      `Credit limit updated — ${limit.toFixed(2)} ETB`,
        body:       `${cafeName} set your credit limit to ${limit.toFixed(2)} ETB.`
      });
    }

    res.json(pca);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── GET /api/cafe/fee-stats ───────────────────────────────────
// Read-only counterpart to admin's /api/admin/cafes/:cafeId/fee-stats,
// scoped to the logged-in cafe owner's own cafe. Shows items sold,
// revenue, and service fee owed SINCE THE LAST RESET — there is
// intentionally NO restart/reset endpoint here. The only reset button
// lives on the admin side (fee-restart); because both queries key off
// the same `fee_collections` table, an admin reset instantly resets
// what the cafe owner sees on their Profile page too.
router.get('/fee-stats', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;

    const lastCollection = await pool.query(`
      SELECT collected_at FROM fee_collections
      WHERE cafe_id = $1
      ORDER BY collected_at DESC LIMIT 1
    `, [cafe_id]);

    const periodStart = lastCollection.rows.length > 0
      ? lastCollection.rows[0].collected_at
      : (await pool.query('SELECT created_at FROM cafes WHERE id = $1', [cafe_id])).rows[0]?.created_at;

    // Summed straight from `orders` (one row per order) — not joined
    // with order_items, which would fan out and multiply
    // service_fee/total by the number of items in each order.
    // Only 'approved' orders count, so pending/cancelled orders never
    // inflate this — cancelled money is never included.
    const current = await pool.query(`
      SELECT
        COALESCE(SUM(o.service_fee), 0) AS total_fee,
        COALESCE(SUM(o.total), 0)       AS total_revenue,
        COUNT(o.id)                     AS total_orders,
        COALESCE((
          SELECT SUM(oi.quantity)
          FROM order_items oi
          JOIN orders o2 ON oi.order_id = o2.id
          WHERE o2.cafe_id = $1 AND o2.status = 'approved' AND o2.created_at > $2
        ), 0) AS total_items
      FROM orders o
      WHERE o.cafe_id = $1
        AND o.status = 'approved'
        AND o.created_at > $2
    `, [cafe_id, periodStart]);

    // Last 30 days of completed collection periods, for reference
    const history = await pool.query(`
      SELECT period_start, period_end, total_items, total_fee, total_revenue, collected_at
      FROM fee_collections
      WHERE cafe_id = $1
        AND collected_at >= NOW() - INTERVAL '30 days'
      ORDER BY collected_at DESC
    `, [cafe_id]);

    res.json({
      period_start:   periodStart,
      current_period: current.rows[0],
      history:        history.rows,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── POST /api/cafe/revenue/reset ────────────────────────────
// Cafe owner resets their 30-day counter and saves a snapshot.
// Keeps only the last 6 snapshots per cafe.
router.post('/revenue/reset', async (req, res) => {
  const client = await pool.connect();
  try {
    const { cafe_id } = req.cafeOwner;

    // Get current 30d stats to save as snapshot
    const stats = await client.query(`
      SELECT
        (SELECT COALESCE(SUM(total),0) FROM orders
          WHERE cafe_id = $1 AND status = 'approved'
          AND created_at >= NOW() - INTERVAL '30 days') AS revenue_30d,
        (SELECT COALESCE(SUM(total),0) FROM orders
          WHERE cafe_id = $1 AND status = 'approved' AND payment_method = 'wallet'
          AND created_at >= NOW() - INTERVAL '30 days') AS wallet_revenue,
        (SELECT COALESCE(SUM(total),0) FROM orders
          WHERE cafe_id = $1 AND status = 'approved' AND payment_method IN ('cash','transfer')
          AND created_at >= NOW() - INTERVAL '30 days') AS instant_revenue,
        (SELECT COALESCE(SUM(amount),0) FROM deposits
          WHERE cafe_id = $1 AND status = 'verified'
          AND created_at >= NOW() - INTERVAL '30 days') AS deposits_30d,
        (SELECT COUNT(*) FROM orders
          WHERE cafe_id = $1 AND status = 'approved'
          AND created_at >= NOW() - INTERVAL '30 days') AS orders_count
    `, [cafe_id]);

    const s = stats.rows[0];

    // Save snapshot
    await client.query(`
      INSERT INTO revenue_snapshots
        (cafe_id, period_start, period_end, revenue_30d, wallet_revenue, instant_revenue, deposits_30d, orders_count)
      VALUES ($1, NOW() - INTERVAL '30 days', NOW(), $2, $3, $4, $5, $6)
    `, [cafe_id, s.revenue_30d, s.wallet_revenue, s.instant_revenue, s.deposits_30d, s.orders_count]);

    // Keep only last 6 snapshots
    await client.query(`
      DELETE FROM revenue_snapshots
      WHERE cafe_id = $1
        AND id NOT IN (
          SELECT id FROM revenue_snapshots
          WHERE cafe_id = $1
          ORDER BY created_at DESC
          LIMIT 6
        )
    `, [cafe_id]);

    res.json({ success: true, snapshot: s });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});


// ── GET /api/cafe/revenue/history ────────────────────────────
// Returns last 6 saved snapshots for the cafe owner history view.
router.get('/revenue/history', async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(`
      SELECT id, period_start, period_end, revenue_30d, wallet_revenue,
             instant_revenue, deposits_30d, orders_count, created_at
      FROM revenue_snapshots
      WHERE cafe_id = $1
      ORDER BY created_at DESC
      LIMIT 6
    `, [cafe_id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/cafe/language ───────────────────────────────────
// Saves the cafe owner's chosen app language so server-sent
// Telegram bot notifications (new order, new registration, etc.)
// are written in the same language, not just the in-app UI text.
router.patch('/language', async (req, res) => {
  try {
    const { id } = req.cafeOwner;
    const { language } = req.body;

    if (!['en', 'am'].includes(language)) {
      return res.status(400).json({ error: "language must be 'en' or 'am'" });
    }

    const result = await pool.query(
      `UPDATE cafe_owners SET language = $1 WHERE id = $2 RETURNING language`,
      [language, id]
    );

    res.json({ language: result.rows[0].language });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
