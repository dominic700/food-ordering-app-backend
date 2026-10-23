import express from 'express';
import pool from '../db/connection.js';
import { telegramAuth } from '../middleware/auth.js';

const router = express.Router();
router.use(telegramAuth);

// ── GET /api/notifications ────────────────────────────────────
// Returns the last 50 notifications for the current Telegram user,
// regardless of role (customer, cafe owner, or admin) — the bell
// icon works the same way in all three portals.
router.get('/', async (req, res) => {
  try {
    const { telegram_id } = req.telegramUser;
    const result = await pool.query(`
      SELECT id, type, title, body, is_read, created_at, cafe_id
      FROM notifications
      WHERE telegram_id = $1
      ORDER BY created_at DESC
      LIMIT 50
    `, [telegram_id]);

    const unreadCount = result.rows.filter(n => !n.is_read).length;
    res.json({ notifications: result.rows, unread_count: unreadCount });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/notifications/:id/read ─────────────────────────
router.patch('/:id/read', async (req, res) => {
  try {
    const { telegram_id } = req.telegramUser;
    const result = await pool.query(`
      UPDATE notifications SET is_read = true
      WHERE id = $1 AND telegram_id = $2 RETURNING *
    `, [req.params.id, telegram_id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/notifications/read-all ─────────────────────────
router.patch('/read-all', async (req, res) => {
  try {
    const { telegram_id } = req.telegramUser;
    await pool.query(`
      UPDATE notifications SET is_read = true
      WHERE telegram_id = $1 AND is_read = false
    `, [telegram_id]);
    res.json({ message: 'All notifications marked as read' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
