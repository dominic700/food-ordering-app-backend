import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';
import pool from '../db/connection.js';
dotenv.config();

// ── TELEGRAM AUTH ─────────────────────────────────────────────
// Validates Telegram WebApp initData sent from the Mini App
export const telegramAuth = (req, res, next) => {
  try {
    const initData = req.headers['x-telegram-init-data'];
    if (!initData) return res.status(401).json({ error: 'Missing Telegram init data' });

    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return res.status(401).json({ error: 'Missing hash' });

    params.delete('hash');

    const dataCheckString = Array.from(params.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');

    const secretKey = crypto
      .createHmac('sha256', 'WebAppData')
      .update(process.env.TELEGRAM_BOT_TOKEN)
      .digest();

    const expectedHash = crypto
      .createHmac('sha256', secretKey)
      .update(dataCheckString)
      .digest('hex');

    if (expectedHash !== hash) {
      return res.status(401).json({ error: 'Invalid Telegram init data' });
    }

    const userStr = params.get('user');
    if (!userStr) return res.status(401).json({ error: 'No user in init data' });

    const tgUser = JSON.parse(userStr);
    req.telegramUser = {
      telegram_id: tgUser.id,
      name: `${tgUser.first_name || ''} ${tgUser.last_name || ''}`.trim(),
      username: tgUser.username || null,
    };

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Telegram auth failed' });
  }
};


// ── JWT AUTH ──────────────────────────────────────────────────
// Used for admin login (email + password)
export const jwtAuth = (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
};


// ── CAFE OWNER ROLE CHECK ─────────────────────────────────────
// Used after telegramAuth to confirm user is a cafe owner
export const cafeOwnerAuth = async (req, res, next) => {
  try {
    const { telegram_id } = req.telegramUser;
    const result = await pool.query(
      'SELECT id, cafe_id, name, phone, language FROM cafe_owners WHERE telegram_id = $1',
      [telegram_id]
    );
    if (result.rows.length === 0) {
      return res.status(403).json({ error: 'Access denied. Not a cafe owner.' });
    }
    req.cafeOwner = result.rows[0];
    next();
  } catch (err) {
    return res.status(500).json({ error: 'Server error during role check' });
  }
};
