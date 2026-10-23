import express from 'express';
import pool from '../db/connection.js';
import { telegramAuth } from '../middleware/auth.js';
import { uploadPromo, uploadCafeLogo } from '../middleware/upload.js';
import { createNotification } from '../utils/notifications.js';

const router = express.Router();

// ── Admin role check middleware ────────────────────────────────
async function adminAuth(req, res, next) {
  try {
    const { telegram_id } = req.telegramUser;
    const result = await pool.query(
      'SELECT id, name, email FROM admins WHERE telegram_id = $1',
      [telegram_id]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied. Not an admin.' });
    }
    req.admin = result.rows[0];
    next();
  } catch (err) {
    console.error('Admin auth error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
}

// All admin routes require Telegram auth + admin role
router.use(telegramAuth, adminAuth);


// ── GET /api/admin/cafes ──────────────────────────────────────
// NOTE: all order/customer stats are computed as scalar subqueries,
// not JOINs + GROUP BY. Joining per_cafe_accounts AND orders to the
// same cafe row at once creates a cross-product (every pca row paired
// with every order row), which silently multiplied SUM(o.service_fee)
// by the number of that cafe's customer accounts — inflating the fee
// total shown here. Subqueries avoid that entirely.
router.get('/cafes', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        c.*,
        co.name        AS owner_name,
        co.phone       AS owner_phone,
        co.telegram_id AS owner_telegram_id,
        COALESCE((
          SELECT COUNT(*) FROM per_cafe_accounts pca
          WHERE pca.cafe_id = c.id AND pca.status = 'approved'
        ), 0) AS customer_count,
        COALESCE((
          SELECT COUNT(*) FROM orders o WHERE o.cafe_id = c.id
        ), 0) AS total_orders,
        COALESCE((
          SELECT COUNT(*) FROM orders o
          WHERE o.cafe_id = c.id AND o.created_at::date = CURRENT_DATE
        ), 0) AS orders_today,
        COALESCE((
          SELECT SUM(oi.quantity)
          FROM order_items oi
          JOIN orders o2 ON oi.order_id = o2.id
          WHERE o2.cafe_id = c.id AND o2.status = 'approved'
        ), 0) AS total_items_all_time,
        COALESCE((
          SELECT SUM(o3.service_fee) FROM orders o3
          WHERE o3.cafe_id = c.id AND o3.status = 'approved'
        ), 0) AS total_fees
      FROM cafes c
      LEFT JOIN cafe_owners co ON co.cafe_id = c.id
      ORDER BY c.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/admin/cafes/:cafeId ─────────────────────────────
router.get('/cafes/:cafeId', async (req, res) => {
  try {
    const { cafeId } = req.params;

    const cafe = await pool.query(`
      SELECT c.*,
        co.name AS owner_name, co.phone AS owner_phone,
        co.telegram_id AS owner_telegram_id
      FROM cafes c
      LEFT JOIN cafe_owners co ON co.cafe_id = c.id
      WHERE c.id = $1
    `, [cafeId]);

    if (cafe.rows.length === 0) {
      return res.status(404).json({ error: 'Cafe not found' });
    }

    const orders = await pool.query(`
      SELECT o.*, ga.name AS customer_name, ga.phone AS customer_phone
      FROM orders o
      JOIN per_cafe_accounts pca ON o.per_cafe_account_id = pca.id
      JOIN global_accounts ga    ON pca.global_account_id = ga.id
      WHERE o.cafe_id = $1
        AND o.created_at >= NOW() - INTERVAL '30 days'
      ORDER BY o.created_at DESC
    `, [cafeId]);

    // NOTE: computed as independent scalar subqueries rather than
    // joining per_cafe_accounts + orders to the same cafe row, which
    // would cross-multiply and inflate total_revenue by the number of
    // that cafe's customer accounts.
    const stats = await pool.query(`
      SELECT
        COALESCE((
          SELECT COUNT(*) FROM per_cafe_accounts
          WHERE cafe_id = $1 AND status = 'approved'
        ), 0) AS customer_count,
        COALESCE((SELECT COUNT(*) FROM orders WHERE cafe_id = $1), 0) AS total_orders,
        COALESCE((
          SELECT SUM(total) FROM orders WHERE cafe_id = $1 AND status = 'approved'
        ), 0) AS total_revenue
    `, [cafeId]);

    res.json({ cafe: cafe.rows[0], orders: orders.rows, stats: stats.rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/admin/cafes ─────────────────────────────────────
// Creates a cafe. logo_url is just a string field — if the admin
// uploaded an image first via /api/admin/cafes/upload-logo, the
// returned URL is passed in here as logo_url.
router.post('/cafes', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const {
      name, description, logo_url, address,
      phone, service_fee,
      owner_telegram_id, owner_name, owner_phone,
      cbe_account_name, cbe_account_number,
      telebirr_name, telebirr_phone
    } = req.body;

    if (!name || !owner_telegram_id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Cafe name and owner Telegram ID are required' });
    }

    const cafe = await client.query(`
      INSERT INTO cafes (name, description, logo_url, address, phone, service_fee,
                         cbe_account_name, cbe_account_number, telebirr_name, telebirr_phone)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *
    `, [name, description, logo_url || null, address, phone, service_fee || 0,
        cbe_account_name || null, cbe_account_number || null,
        telebirr_name || null, telebirr_phone || null]);

    await client.query(`
      INSERT INTO cafe_owners (cafe_id, telegram_id, name, phone)
      VALUES ($1, $2, $3, $4)
    `, [cafe.rows[0].id, owner_telegram_id, owner_name, owner_phone]);

    await client.query('COMMIT');

    createNotification({
      telegramId: owner_telegram_id,
      cafeId:     cafe.rows[0].id,
      type:       'cafe_created',
      title:      `Welcome — ${cafe.rows[0].name} is set up!`,
      body:       'An admin created your cafe account. Open the bot to access your dashboard.'
    });

    res.status(201).json(cafe.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});


// ── PATCH /api/admin/cafes/:cafeId ───────────────────────────
router.patch('/cafes/:cafeId', async (req, res) => {
  try {
    const { cafeId } = req.params;
    const { name, description, address, phone, service_fee, logo_url,
            cbe_account_name, cbe_account_number, telebirr_name, telebirr_phone } = req.body;

    const result = await pool.query(`
      UPDATE cafes
      SET name               = COALESCE($1, name),
          description        = COALESCE($2, description),
          address            = COALESCE($3, address),
          phone              = COALESCE($4, phone),
          service_fee        = COALESCE($5, service_fee),
          logo_url           = COALESCE($6, logo_url),
          cbe_account_name   = COALESCE($7, cbe_account_name),
          cbe_account_number = COALESCE($8, cbe_account_number),
          telebirr_name      = COALESCE($9, telebirr_name),
          telebirr_phone     = COALESCE($10, telebirr_phone)
      WHERE id = $11 RETURNING *
    `, [name, description, address, phone, service_fee, logo_url,
        cbe_account_name, cbe_account_number, telebirr_name, telebirr_phone, cafeId]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Cafe not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/admin/cafes/:cafeId/toggle ────────────────────
router.patch('/cafes/:cafeId/toggle', async (req, res) => {
  try {
    const { cafeId } = req.params;
    const result = await pool.query(`
      UPDATE cafes SET is_active = NOT is_active
      WHERE id = $1 RETURNING id, name, is_active
    `, [cafeId]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Cafe not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── DELETE /api/admin/cafes/:cafeId ──────────────────────────
// Permanently deletes a cafe and all related data (cascade).
router.delete('/cafes/:cafeId', async (req, res) => {
  try {
    const { cafeId } = req.params;
    const result = await pool.query(
      `DELETE FROM cafes WHERE id = $1 RETURNING id, name`,
      [cafeId]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Cafe not found' });
    res.json({ success: true, deleted: result.rows[0] });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/admin/cafes/upload-logo ─────────────────────────
// Upload a cafe profile picture file. Returns { image_url } which
// the admin frontend then sends as `logo_url` in POST/PATCH /cafes.
// Mounted as its own route (not nested), and BEFORE export default,
// so it is correctly registered — this is the file upload route
// that was previously broken (declared after `export default router`,
// so Express never registered it and the request fell through to
// the SPA/404 handler, returning HTML and causing the
// "Unexpected token '<', "<!DOCTYPE"..." JSON parse error).
router.post('/cafes/upload-logo', (req, res) => {
  uploadCafeLogo(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    const imageUrl = `/uploads/cafes/${req.file.filename}`;
    res.status(201).json({ image_url: imageUrl });
  });
});


// ── GET /api/admin/promotions ─────────────────────────────────
router.get('/promotions', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, c.name AS cafe_name FROM promotions p
      LEFT JOIN cafes c ON p.cafe_id = c.id
      ORDER BY p.created_at DESC
    `);
    res.json(result.rows);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/admin/promotions ────────────────────────────────
// Add a promotion from an already-known image_url (no file upload).
router.post('/promotions', async (req, res) => {
  try {
    const { cafe_id, image_url, title } = req.body;
    if (!image_url) return res.status(400).json({ error: 'image_url is required' });

    const result = await pool.query(`
      INSERT INTO promotions (cafe_id, image_url, title)
      VALUES ($1, $2, $3) RETURNING *
    `, [cafe_id || null, image_url, title]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/admin/promotions/upload ─────────────────────────
// Upload a promo image file directly -> saves to uploads/promos/
// and creates the promotions row in one request. This route MUST
// be registered before `export default router` at the bottom of
// this file — previously it was placed AFTER the export, which
// meant Express never mounted it, and any request to this path
// fell through to the catch-all 404/SPA handler that returns HTML,
// causing "Unexpected token '<', "<!DOCTYPE"..." on the frontend
// when it tried to JSON.parse() the response.
router.post('/promotions/upload', (req, res) => {
  uploadPromo(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    try {
      const { title, cafe_id } = req.body;
      const imageUrl = `/uploads/promos/${req.file.filename}`;

      const result = await pool.query(`
        INSERT INTO promotions (cafe_id, image_url, title, is_active)
        VALUES ($1, $2, $3, true) RETURNING *
      `, [cafe_id || null, imageUrl, title || null]);

      res.status(201).json(result.rows[0]);
    } catch (dbErr) {
      console.error(dbErr.message);
      res.status(500).json({ error: 'Server error' });
    }
  });
});


// ── DELETE /api/admin/promotions/:id ─────────────────────────
router.delete('/promotions/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM promotions WHERE id = $1', [req.params.id]);
    res.json({ message: 'Promotion deleted' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/admin/cafes/:cafeId/fee-stats ───────────────────
// Returns:
//   current_period: item count + fee total since last restart
//   last_restart:   when the last restart was (or cafe created_at)
//   history:        last 30 days of completed collection periods
//   all_time_items: lifetime approved item count for dashboard card
router.get('/cafes/:cafeId/fee-stats', async (req, res) => {
  try {
    const { cafeId } = req.params;

    // Find when the last collection was (= start of current period)
    const lastCollection = await pool.query(`
      SELECT collected_at FROM fee_collections
      WHERE cafe_id = $1
      ORDER BY collected_at DESC LIMIT 1
    `, [cafeId]);

    // If never restarted, period starts from cafe creation
    const periodStart = lastCollection.rows.length > 0
      ? lastCollection.rows[0].collected_at
      : (await pool.query('SELECT created_at FROM cafes WHERE id = $1', [cafeId])).rows[0]?.created_at;

    // Current period: approved orders since last restart.
    // NOTE: total_fee/total_revenue are summed straight from `orders`
    // (one row per order) — NOT joined with order_items, which would
    // fan out one order into N rows (one per item) and multiply
    // o.service_fee/o.total by however many distinct items were in
    // that order. total_items is summed separately via its own
    // subquery, which is the only place a per-item join is correct.
    // Only 'approved' orders count — pending/cancelled never touch
    // the fee or revenue totals.
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
    `, [cafeId, periodStart]);

    // All-time approved item count (for the dashboard card)
    const allTime = await pool.query(`
      SELECT COALESCE(SUM(oi.quantity), 0) AS total_items
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.cafe_id = $1 AND o.status = 'approved'
    `, [cafeId]);

    // Last 30 days of completed collection history
    const history = await pool.query(`
      SELECT * FROM fee_collections
      WHERE cafe_id = $1
        AND collected_at >= NOW() - INTERVAL '30 days'
      ORDER BY collected_at DESC
    `, [cafeId]);

    res.json({
      period_start:    periodStart,
      current_period:  current.rows[0],
      all_time_items:  parseInt(allTime.rows[0].total_items),
      history:         history.rows,
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/admin/cafes/:cafeId/fee-restart ────────────────
// Admin presses "Restart" after collecting the weekly fee.
// Saves the current period's stats to fee_collections history,
// then the next call to fee-stats will start counting from now.
router.post('/cafes/:cafeId/fee-restart', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { cafeId } = req.params;
    const { collected_by } = req.body;

    // Find period start (same logic as fee-stats)
    const lastCollection = await client.query(`
      SELECT collected_at FROM fee_collections
      WHERE cafe_id = $1 ORDER BY collected_at DESC LIMIT 1
    `, [cafeId]);

    const periodStart = lastCollection.rows.length > 0
      ? lastCollection.rows[0].collected_at
      : (await client.query('SELECT created_at FROM cafes WHERE id = $1', [cafeId])).rows[0]?.created_at;

    // Compute current period totals (same fix as fee-stats: sum
    // service_fee/total straight from `orders`, not joined with
    // order_items, to avoid multiplying them by item count).
    const totals = await client.query(`
      SELECT
        COALESCE(SUM(o.service_fee), 0) AS total_fee,
        COALESCE(SUM(o.total), 0)       AS total_revenue,
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
    `, [cafeId, periodStart]);

    // Save to history — this is the single reset action for the
    // whole platform. Both this admin fee-stats/history view AND the
    // cafe owner's own read-only profile counters key off the most
    // recent row in fee_collections, so pressing Restart here resets
    // what the cafe owner sees too (there is no separate cafe-side
    // reset button by design).
    const record = await client.query(`
      INSERT INTO fee_collections
        (cafe_id, period_start, period_end, total_items, total_fee, total_revenue, collected_by)
      VALUES ($1, $2, NOW(), $3, $4, $5, $6)
      RETURNING *
    `, [
      cafeId,
      periodStart,
      parseInt(totals.rows[0].total_items),
      parseFloat(totals.rows[0].total_fee),
      parseFloat(totals.rows[0].total_revenue),
      collected_by || 'admin',
    ]);

    await client.query('COMMIT');
    res.status(201).json(record.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

export default router;
