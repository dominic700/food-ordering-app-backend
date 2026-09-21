import pool from '../db/connection.js';

// ── createNotification ───────────────────────────────────────
// Inserts an in-app notification row for the bell icon history.
// This is SEPARATE from the Telegram bot message (utils/telegramBot.js)
// — that one is the push notification with sound, this one is the
// persistent "Notifications" history page inside the Mini App.
//
// Fails silently (logs only) so a notification failure never
// breaks the main request.
export async function createNotification({ telegramId, cafeId = null, type, title, body = null }) {
  try {
    if (!telegramId || !type || !title) return;
    await pool.query(`
      INSERT INTO notifications (telegram_id, cafe_id, type, title, body)
      VALUES ($1, $2, $3, $4, $5)
    `, [telegramId, cafeId, type, title, body]);
  } catch (err) {
    console.error('createNotification error:', err.message);
  }
}
