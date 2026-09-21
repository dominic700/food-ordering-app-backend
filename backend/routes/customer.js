import express from 'express';
import pool from '../db/connection.js';
import { telegramAuth } from '../middleware/auth.js';
import { createNotification } from '../utils/notifications.js';
import { sendTelegramMessage, newRegistrationMessage, moneyReceivedMessage } from '../utils/telegramBot.js';

const router = express.Router();
router.use(telegramAuth);

// ── GET /api/customer/cafes ───────────────────────────────────
router.get('/cafes', async (req, res) => {
  try {
    const cafes = await pool.query(`
      SELECT id, name, description, logo_url, address, phone, service_fee,
             cbe_account_name, cbe_account_number, telebirr_name, telebirr_phone
      FROM cafes WHERE is_active = true ORDER BY name ASC
    `);
    const promos = await pool.query(`
      SELECT id, cafe_id, image_url, title
      FROM promotions WHERE is_active = true
      ORDER BY created_at DESC
    `);
    res.json({ cafes: cafes.rows, promotions: promos.rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/customer/account/:cafeId ────────────────────────
router.get('/account/:cafeId', async (req, res) => {
  try {
    const { telegram_id } = req.telegramUser;
    const { cafeId }      = req.params;

    const result = await pool.query(`
      SELECT pca.*, ga.name, ga.phone,
             c.cbe_account_name, c.cbe_account_number,
             c.telebirr_name, c.telebirr_phone
      FROM per_cafe_accounts pca
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      JOIN cafes c ON pca.cafe_id = c.id
      WHERE ga.telegram_id = $1 AND pca.cafe_id = $2
    `, [telegram_id, cafeId]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'No account at this cafe' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/customer/account/:cafeId/register ──────────────
// Customer registers at a cafe — for WALLET/CREDIT access.
// Accepts name + phone from the registration popup form.
// Updates global_account with the provided name/phone if changed.
//
// Cash/Transfer orders auto-create a minimal 'pending' per_cafe_account
// behind the scenes (see routes/orders.js) purely for record-linking —
// that does NOT count as a real registration request. So here we only
// treat it as "already registered" if a request was explicitly and
// recently submitted (within the last 5 minutes is too fragile to
// detect server-side, so instead: if status is 'pending' or 'approved'
// or 'suspended' we just re-use/refresh that row rather than blocking
// the customer with a 409 — this makes the flow forgiving for repeat
// taps and for customers who ordered cash first, then later open the
// registration popup).
router.post('/account/:cafeId/register', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { telegram_id } = req.telegramUser;
    const { cafeId }      = req.params;
    const { name, phone } = req.body;

    const ga = await client.query(
      'SELECT * FROM global_accounts WHERE telegram_id = $1',
      [telegram_id]
    );
    if (ga.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Global account not found' });
    }

    if (name || phone) {
      await client.query(`
        UPDATE global_accounts
        SET name  = COALESCE(NULLIF($1, ''), name),
            phone = COALESCE(NULLIF($2, ''), phone)
        WHERE telegram_id = $3
      `, [name, phone, telegram_id]);
    }

    const existing = await client.query(
      'SELECT * FROM per_cafe_accounts WHERE global_account_id = $1 AND cafe_id = $2',
      [ga.rows[0].id, cafeId]
    );

    let pca;
    if (existing.rows.length > 0) {
      const current = existing.rows[0];
      if (current.status === 'approved') {
        await client.query('ROLLBACK');
        return res.status(409).json({ error: 'Already approved at this cafe', account: current });
      }
      // Re-submit / refresh a pending (possibly auto-created by an
      // earlier cash/transfer order) or suspended account back to
      // pending so it shows up in the cafe owner's Registrations page.
      const refreshed = await client.query(`
        UPDATE per_cafe_accounts
        SET status = 'pending', registered_at = NOW(), approved_at = NULL
        WHERE id = $1 RETURNING *
      `, [current.id]);
      pca = refreshed.rows[0];
    } else {
      const created = await client.query(`
        INSERT INTO per_cafe_accounts (global_account_id, cafe_id)
        VALUES ($1, $2) RETURNING *
      `, [ga.rows[0].id, cafeId]);
      pca = created.rows[0];
    }

    await client.query('COMMIT');

    // Notify cafe owner of the new registration request — both the
    // Telegram bot push (sound + popup, primary alert) and the
    // in-app notification history row (bell icon).
    const ownerResult = await pool.query(
      'SELECT telegram_id, language FROM cafe_owners WHERE cafe_id = $1', [cafeId]
    );
    if (ownerResult.rows.length > 0) {
      const ownerTelegramId = ownerResult.rows[0].telegram_id;
      const displayName = name || ga.rows[0].name || 'A customer';
      const displayPhone = phone || ga.rows[0].phone;

      sendTelegramMessage(
        ownerTelegramId,
        newRegistrationMessage(displayName, displayPhone, ownerResult.rows[0].language)
      );

      createNotification({
        telegramId: ownerTelegramId,
        cafeId,
        type:  'registration_request',
        title: `New registration request`,
        body:  `${displayName} wants to register at your cafe.`
      });
    }

    res.status(201).json(pca);
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});


// ── POST /api/customer/account/:cafeId/transfer ──────────────
// Send wallet balance (or credit) from one customer to another
// at the same cafe. Both must be approved at this cafe.
// Sender's balance can go negative down to -credit_limit
// (same rule as ordering with wallet).
router.post('/account/:cafeId/transfer', async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { telegram_id } = req.telegramUser;
    const { cafeId }      = req.params;
    const { to_phone, amount } = req.body;

    if (!to_phone || !amount || parseFloat(amount) <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'to_phone and a positive amount are required' });
    }

    const transferAmount = parseFloat(parseFloat(amount).toFixed(2));

    // ── Resolve sender ────────────────────────────────────────
    const senderResult = await client.query(`
      SELECT pca.id, pca.balance, pca.credit_limit, ga.name AS sender_name
      FROM per_cafe_accounts pca
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      WHERE ga.telegram_id = $1 AND pca.cafe_id = $2 AND pca.status = 'approved'
    `, [telegram_id, cafeId]);

    if (senderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'You need an approved account at this cafe to send money.' });
    }
    const sender = senderResult.rows[0];

    // Check sender can afford it (balance can go negative down to -credit_limit)
    const balanceAfter = parseFloat(sender.balance) - transferAmount;
    if (balanceAfter < -parseFloat(sender.credit_limit)) {
      await client.query('ROLLBACK');
      return res.status(400).json({
        error: `Insufficient balance and credit. You can send up to ${(parseFloat(sender.balance) + parseFloat(sender.credit_limit)).toFixed(2)} ETB.`,
        balance: parseFloat(sender.balance),
        credit_limit: parseFloat(sender.credit_limit),
      });
    }

    // ── Resolve receiver by phone ─────────────────────────────
    const receiverResult = await client.query(`
      SELECT pca.id, pca.balance, ga.name AS receiver_name, ga.telegram_id AS receiver_telegram_id, ga.language AS receiver_language
      FROM per_cafe_accounts pca
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      WHERE ga.phone = $1 AND pca.cafe_id = $2 AND pca.status = 'approved'
    `, [to_phone, cafeId]);

    if (receiverResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({
        error: `No approved account found for phone ${to_phone} at this cafe. Both sender and receiver must be registered and approved here.`
      });
    }
    const receiver = receiverResult.rows[0];

    // Can't send to yourself
    if (sender.id === receiver.id) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'You cannot send money to yourself.' });
    }

    // ── Execute transfer ──────────────────────────────────────
    await client.query(
      'UPDATE per_cafe_accounts SET balance = balance - $1 WHERE id = $2',
      [transferAmount, sender.id]
    );
    await client.query(
      'UPDATE per_cafe_accounts SET balance = balance + $1 WHERE id = $2',
      [transferAmount, receiver.id]
    );

    await client.query('COMMIT');

    // Notify both parties via Telegram push + in-app bell
    sendTelegramMessage(
      receiver.receiver_telegram_id,
      moneyReceivedMessage(
        sender.sender_name,
        transferAmount,
        parseFloat(receiver.balance) + transferAmount,
        receiver.receiver_language
      )
    );

    createNotification({
      telegramId: receiver.receiver_telegram_id,
      cafeId,
      type:  'wallet_received',
      title: `Received ${transferAmount.toFixed(2)} ETB from ${sender.sender_name}`,
      body:  `Your balance has been updated.`,
    });

    res.json({
      message:        'Transfer successful',
      amount:         transferAmount,
      to:             receiver.receiver_name,
      sender_balance: balanceAfter,
    });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Transfer error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});
router.get('/account/:cafeId/history', async (req, res) => {
  try {
    const { telegram_id } = req.telegramUser;
    const { cafeId }      = req.params;

    const pcaResult = await pool.query(`
      SELECT pca.id FROM per_cafe_accounts pca
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      WHERE ga.telegram_id = $1 AND pca.cafe_id = $2
    `, [telegram_id, cafeId]);

    if (pcaResult.rows.length === 0) {
      return res.status(404).json({ error: 'No account at this cafe' });
    }
    const pcaId = pcaResult.rows[0].id;

    const orders = await pool.query(`
      SELECT o.*,
        json_agg(json_build_object(
          'name', oi.name, 'quantity', oi.quantity,
          'price', oi.price, 'item_total', oi.item_total
        )) AS items
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.per_cafe_account_id = $1
      GROUP BY o.id ORDER BY o.created_at DESC
    `, [pcaId]);

    const deposits = await pool.query(`
      SELECT id, amount, payment_method, transaction_number, status, created_at
      FROM deposits WHERE per_cafe_account_id = $1
      ORDER BY created_at DESC
    `, [pcaId]);

    res.json({ orders: orders.rows, deposits: deposits.rows });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ── PATCH /api/customer/language ──────────────────────────────
// Saves the customer's chosen app language so server-sent Telegram
// bot notifications (new order approved, deposit verified, etc.)
// are written in the same language, not just the in-app UI text.
router.patch('/language', async (req, res) => {
  try {
    const { telegram_id } = req.telegramUser;
    const { language } = req.body;

    if (!['en', 'am'].includes(language)) {
      return res.status(400).json({ error: "language must be 'en' or 'am'" });
    }

    const result = await pool.query(
      `UPDATE global_accounts SET language = $1 WHERE telegram_id = $2 RETURNING language`,
      [language, telegram_id]
    );

    if (result.rows.length === 0) {
      // No global account yet (e.g. before first registration) —
      // nothing to persist server-side yet, but not an error; the
      // in-app localStorage preference still applies.
      return res.json({ language });
    }

    res.json({ language: result.rows[0].language });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
