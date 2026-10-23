import express from 'express';
import pool from '../db/connection.js';
import { verifyTelebirrPayment, extractReceiptCode } from '../utils/telebirrVerifier.js';
import { telegramAuth, cafeOwnerAuth } from '../middleware/auth.js';
import { sendTelegramMessage, newOrderMessage, orderApprovedMessage, orderCancelledMessage, transferRefundReminderMessage } from '../utils/telegramBot.js';
import { createNotification } from '../utils/notifications.js';

const router = express.Router();
const round2 = (n) => Math.round(n * 100) / 100;

// ── POST /api/orders ──────────────────────────────────────────
// payment_method:
//   'wallet'   -> REQUIRES an approved per_cafe_account. Pays from
//                 balance first, then credit. Each menu item's own
//                 discount_percent (set by the cafe owner per item)
//                 reduces the price for wallet orders only.
//   'transfer' -> Only requires a global_account (Telegram identity).
//                 No registration/approval needed. Pays full list
//                 price (no discount). Requires transfer_provider +
//                 transaction_number.
//   'cash'     -> Only requires a global_account. No registration
//                 needed. Pays full list price (no discount). The
//                 cafe owner gets a "collect cash" warning.
// ── POST /api/orders/verify-telebirr ─────────────────────────
router.post('/verify-telebirr', telegramAuth, async (req, res) => {
  try {
    const { cafe_id, receipt_input, expected_amount } = req.body;
    if (!cafe_id || !receipt_input || !expected_amount) {
      return res.status(400).json({ error: 'cafe_id, receipt_input and expected_amount are required' });
    }
    const cafeResult = await pool.query(
      'SELECT telebirr_name, telebirr_phone FROM cafes WHERE id = $1', [cafe_id]
    );
    if (cafeResult.rows.length === 0) return res.status(404).json({ error: 'Cafe not found' });
    const result = await verifyTelebirrPayment(receipt_input, parseFloat(expected_amount), cafeResult.rows[0]);
    res.json(result);
  } catch (err) {
    console.error('verify-telebirr error:', err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


router.post('/', telegramAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { telegram_id, name: telegramName } = req.telegramUser;
    const {
      cafe_id, items, note,
      payment_method,
      transfer_provider,
      transaction_number
    } = req.body;

    if (!cafe_id || !items?.length) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'cafe_id and items are required' });
    }

    const validMethods = ['wallet', 'transfer', 'cash'];
    const method = validMethods.includes(payment_method) ? payment_method : 'cash';

    if (method === 'transfer') {
      const validProviders = ['telebirr', 'cbe_birr', 'bank_transfer'];
      if (!transfer_provider || !transaction_number) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'transfer_provider and transaction_number are required for transfer payment' });
      }
      if (!validProviders.includes(transfer_provider)) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Invalid transfer_provider' });
      }
    }

    // ── Resolve customer identity + per_cafe_account linkage ──
    // 'wallet' REQUIRES an approved per_cafe_account.
    // 'cash' / 'transfer' only need the global_account (Telegram
    // identity) — registration at the cafe is NOT required.
    let pca          = null;
    let customerName = telegramName;
    let pcaId        = null;

    const gaResult = await client.query(
      'SELECT * FROM global_accounts WHERE telegram_id = $1',
      [telegram_id]
    );
    if (gaResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Account not found. Please open the bot and send /start first.' });
    }
    const globalAccount = gaResult.rows[0];
    customerName = globalAccount.name || telegramName;

    if (method === 'wallet') {
      const pcaResult = await client.query(`
        SELECT pca.* FROM per_cafe_accounts pca
        WHERE pca.global_account_id = $1 AND pca.cafe_id = $2 AND pca.status = 'approved'
      `, [globalAccount.id, cafe_id]);

      if (pcaResult.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(403).json({
          error: 'You need an approved account at this cafe to pay with wallet balance or credit. Please register first, or choose Cash or Transfer instead.'
        });
      }
      pca   = pcaResult.rows[0];
      pcaId = pca.id;
    } else {
      // cash / transfer — link to any existing per_cafe_account,
      // or create a minimal pending placeholder for record-keeping
      const existingPca = await client.query(
        'SELECT id FROM per_cafe_accounts WHERE global_account_id = $1 AND cafe_id = $2',
        [globalAccount.id, cafe_id]
      );
      if (existingPca.rows.length > 0) {
        pcaId = existingPca.rows[0].id;
      } else {
        const newPca = await client.query(`
          INSERT INTO per_cafe_accounts (global_account_id, cafe_id, status)
          VALUES ($1, $2, 'pending') RETURNING id
        `, [globalAccount.id, cafe_id]);
        pcaId = newPca.rows[0].id;
      }
    }

    // ── Cafe + service fee ─────────────────────────────────────
    const cafeResult = await client.query(
      'SELECT name, service_fee FROM cafes WHERE id = $1 AND is_active = true',
      [cafe_id]
    );
    if (cafeResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Cafe not found or inactive' });
    }
    const cafe              = cafeResult.rows[0];
    const serviceFeePerUnit = parseFloat(cafe.service_fee);

    // ── Price each item server-side ─────────────────────────────
    let subtotal    = 0;
    let feeTotal    = 0;
    let listTotal   = 0;
    let walletTotal = 0;
    const resolvedItems = [];

    for (const item of items) {
      const mi = await client.query(
        'SELECT * FROM menu_items WHERE id = $1 AND cafe_id = $2 AND is_available = true',
        [item.menu_item_id, cafe_id]
      );
      if (mi.rows.length === 0) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: `Item ${item.menu_item_id} not found or unavailable` });
      }

      const basePrice       = parseFloat(mi.rows[0].price);
      const discountPercent = parseFloat(mi.rows[0].discount_percent || 0);
      const listUnitPrice   = round2(basePrice + serviceFeePerUnit);
      const walletUnitPrice = round2(listUnitPrice * (1 - discountPercent / 100));

      const qty = item.quantity;
      subtotal    += basePrice * qty;
      feeTotal    += serviceFeePerUnit * qty;
      listTotal   += listUnitPrice * qty;
      walletTotal += walletUnitPrice * qty;

      const chargedUnitPrice = method === 'wallet' ? walletUnitPrice : listUnitPrice;

      resolvedItems.push({
        menu_item_id: mi.rows[0].id,
        name:         mi.rows[0].name,
        price:        chargedUnitPrice,
        quantity:     qty,
        item_total:   round2(chargedUnitPrice * qty)
      });
    }

    subtotal    = round2(subtotal);
    feeTotal    = round2(feeTotal);
    listTotal   = round2(listTotal);
    walletTotal = round2(walletTotal);

    const total          = method === 'wallet' ? walletTotal : listTotal;
    const discountAmount = method === 'wallet' ? round2(listTotal - walletTotal) : 0;

    // ── Payment logic ───────────────────────────────────────────
    // balance is a single SIGNED number now (no separate credit pool).
    // Spending always just subtracts from balance — it's allowed to
    // go negative down to -credit_limit (the floor the cafe owner set
    // directly on this customer's profile, with no application step).
    // paid_from_balance / paid_from_credit are still recorded for
    // reporting: how much of this order came out of an already-
    // positive balance vs. how much pushed it into negative territory.
    let paidFromBalance = 0;
    let paidFromCredit  = 0;

    if (method === 'wallet') {
      const balance     = parseFloat(pca.balance);
      const creditLimit = parseFloat(pca.credit_limit);
      const balanceAfter = round2(balance - total);

      if (balanceAfter < -creditLimit) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: 'Insufficient balance and credit',
          balance, credit_limit: creditLimit, order_total: total
        });
      }

      // Split purely for the reporting columns — actual deduction
      // below is just `balance = balance - total`.
      if (balance >= total) {
        paidFromBalance = total;
      } else if (balance > 0) {
        paidFromBalance = balance;
        paidFromCredit  = round2(total - balance);
      } else {
        paidFromCredit = total;
      }
    }

    // ── Create order ────────────────────────────────────────────
    const orderResult = await client.query(`
      INSERT INTO orders (
        cafe_id, per_cafe_account_id, subtotal, service_fee, total,
        discount_amount, paid_from_balance, paid_from_credit,
        payment_method, transfer_provider, transaction_number,
        status, note
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending',$12)
      RETURNING *
    `, [
      cafe_id, pcaId, subtotal, feeTotal, total,
      discountAmount, paidFromBalance, paidFromCredit,
      method,
      method === 'transfer' ? transfer_provider : null,
      method === 'transfer' ? transaction_number : null,
      note
    ]);

    const order = orderResult.rows[0];

    for (const item of resolvedItems) {
      await client.query(`
        INSERT INTO order_items (order_id, menu_item_id, name, price, quantity, item_total)
        VALUES ($1,$2,$3,$4,$5,$6)
      `, [order.id, item.menu_item_id, item.name, item.price, item.quantity, item.item_total]);
    }

    if (method === 'wallet') {
      await client.query(`
        UPDATE per_cafe_accounts
        SET balance = balance - $1
        WHERE id = $2
      `, [total, pcaId]);
    }

    const ownerResult = await client.query(
      'SELECT telegram_id, language FROM cafe_owners WHERE cafe_id = $1', [cafe_id]
    );

    await client.query('COMMIT');

    if (ownerResult.rows.length > 0) {
      const { telegram_id: ownerTelegramId, language: ownerLang } = ownerResult.rows[0];

      sendTelegramMessage(
        ownerTelegramId,
        newOrderMessage(order, customerName, resolvedItems, ownerLang)
      );

      createNotification({
        telegramId: ownerTelegramId,
        cafeId:     cafe_id,
        type:       'new_order',
        title:      method === 'cash' ? `New cash order — ${total.toFixed(2)} ETB` : `New order — ${total.toFixed(2)} ETB`,
        body:       `${customerName} placed an order via ${method}.`
      });
    }

    res.status(201).json({
      order,
      payment_summary: {
        subtotal,
        service_fee:       feeTotal,
        total,
        discount_amount:   discountAmount,
        amount_paid:       total,
        payment_method:    method,
        paid_from_balance: paidFromBalance,
        paid_from_credit:  paidFromCredit
      }
    });

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Order error:', err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});


// ── GET /api/orders/cafe/pending ──────────────────────────────
router.get('/cafe/pending', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(`
      SELECT o.*, ga.name AS customer_name, ga.phone AS customer_phone
      FROM orders o
      JOIN per_cafe_accounts pca ON o.per_cafe_account_id = pca.id
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      WHERE o.cafe_id = $1 AND o.status = 'pending'
      ORDER BY o.created_at ASC
    `, [cafe_id]);

    const orderIds = result.rows.map(r => r.id);
    let itemsByOrder = {};
    if (orderIds.length > 0) {
      const itemsResult = await pool.query(`
        SELECT order_id, name, quantity, price, item_total
        FROM order_items WHERE order_id = ANY($1)
      `, [orderIds]);
      itemsByOrder = itemsResult.rows.reduce((acc, row) => {
        (acc[row.order_id] ||= []).push(row);
        return acc;
      }, {});
    }

    const orders = result.rows.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));
    res.json(orders);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/orders/cafe/history ──────────────────────────────
router.get('/cafe/history', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(`
      SELECT o.*, ga.name AS customer_name, ga.phone AS customer_phone
      FROM orders o
      JOIN per_cafe_accounts pca ON o.per_cafe_account_id = pca.id
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      WHERE o.cafe_id = $1 AND o.created_at >= NOW() - INTERVAL '30 days'
      ORDER BY o.created_at DESC
    `, [cafe_id]);

    const orderIds = result.rows.map(r => r.id);
    let itemsByOrder = {};
    if (orderIds.length > 0) {
      const itemsResult = await pool.query(`
        SELECT order_id, name, quantity, price, item_total
        FROM order_items WHERE order_id = ANY($1)
      `, [orderIds]);
      itemsByOrder = itemsResult.rows.reduce((acc, row) => {
        (acc[row.order_id] ||= []).push(row);
        return acc;
      }, {});
    }

    const orders = result.rows.map(o => ({ ...o, items: itemsByOrder[o.id] || [] }));
    res.json(orders);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/orders/:orderId/approve ───────────────────────
router.patch('/:orderId/approve', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(`
      UPDATE orders SET status = 'approved', approved_at = NOW()
      WHERE id = $1 AND cafe_id = $2 AND status = 'pending'
      RETURNING *
    `, [req.params.orderId, cafe_id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found or already processed' });
    }
    const order = result.rows[0];

    const infoResult = await pool.query(`
      SELECT ga.telegram_id, ga.language, c.name AS cafe_name
      FROM orders o
      JOIN per_cafe_accounts pca ON o.per_cafe_account_id = pca.id
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      JOIN cafes c ON o.cafe_id = c.id
      WHERE o.id = $1
    `, [order.id]);

    if (infoResult.rows.length > 0) {
      const { telegram_id, language, cafe_name } = infoResult.rows[0];
      sendTelegramMessage(telegram_id, orderApprovedMessage(order, cafe_name, language));
      createNotification({
        telegramId: telegram_id,
        cafeId:     cafe_id,
        type:       'order_approved',
        title:      `Order approved — ${parseFloat(order.total).toFixed(2)} ETB`,
        body:       `${cafe_name} accepted your order.`
      });
    }

    res.json(order);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/orders/:orderId/cancel ────────────────────────
router.patch('/:orderId/cancel', telegramAuth, cafeOwnerAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { cafe_id } = req.cafeOwner;

    const orderResult = await client.query(
      `SELECT * FROM orders WHERE id = $1 AND cafe_id = $2 AND status = 'pending'`,
      [req.params.orderId, cafe_id]
    );
    if (orderResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Order not found or already processed' });
    }

    const order = orderResult.rows[0];

    // Refund: simply add the order's total back to balance — works
    // correctly whether the order was paid from a positive balance,
    // pushed it negative (credit), or both, since balance is now a
    // single signed number. cash/transfer orders have total
    // effectively 0 here for refund purposes since they never
    // touched balance (paid_from_balance + paid_from_credit = 0).
    const refundAmount = parseFloat(order.paid_from_balance) + parseFloat(order.paid_from_credit);
    if (refundAmount > 0) {
      await client.query(`
        UPDATE per_cafe_accounts
        SET balance = balance + $1
        WHERE id = $2
      `, [refundAmount, order.per_cafe_account_id]);
    }

    const cancelResult = await client.query(
      `UPDATE orders SET status = 'cancelled', cancelled_at = NOW() WHERE id = $1 RETURNING *`,
      [order.id]
    );
    const cancelledOrder = cancelResult.rows[0];

    // Fetch customer telegram_id + phone, cafe name, cafe owner phone
    const infoResult = await client.query(`
      SELECT
        ga.telegram_id   AS customer_telegram_id,
        ga.name          AS customer_name,
        ga.phone         AS customer_phone,
        ga.language      AS customer_language,
        c.name           AS cafe_name,
        co.phone         AS owner_phone,
        co.telegram_id   AS owner_telegram_id,
        co.language      AS owner_language
      FROM per_cafe_accounts pca
      JOIN global_accounts ga ON pca.global_account_id = ga.id
      JOIN cafes c            ON c.id = pca.cafe_id
      JOIN cafe_owners co     ON co.cafe_id = c.id
      WHERE pca.id = $1
    `, [order.per_cafe_account_id]);

    await client.query('COMMIT');

    if (infoResult.rows.length > 0) {
      const {
        customer_telegram_id, customer_name, customer_phone, customer_language,
        cafe_name, owner_phone, owner_telegram_id, owner_language
      } = infoResult.rows[0];

      const isTransfer = cancelledOrder.payment_method === 'transfer';

      // Notify customer — with transfer refund instructions if applicable
      sendTelegramMessage(
        customer_telegram_id,
        orderCancelledMessage(cancelledOrder, cafe_name, owner_phone, 'cafe', customer_language)
      );

      createNotification({
        telegramId: customer_telegram_id,
        cafeId:     cafe_id,
        type:       'order_cancelled',
        title:      `Order cancelled — ${parseFloat(cancelledOrder.total).toFixed(2)} ETB`,
        body:       isTransfer
          ? `${cafe_name} cancelled your transfer order. Contact them at ${owner_phone} for your refund.`
          : `${cafe_name} cancelled your order.`
      });

      // Notify cafe owner to send refund if transfer payment
      if (isTransfer) {
        sendTelegramMessage(
          owner_telegram_id,
          transferRefundReminderMessage(cancelledOrder, customer_name, customer_phone, 'cafe', owner_language)
        );

        createNotification({
          telegramId: owner_telegram_id,
          cafeId:     cafe_id,
          type:       'refund_required',
          title:      `Refund required — ${parseFloat(cancelledOrder.total).toFixed(2)} ETB to ${customer_name}`,
          body:       `Send ${parseFloat(cancelledOrder.total).toFixed(2)} ETB back to ${customer_name} (${customer_phone}).`
        });
      }
    }

    res.json({ message: 'Order cancelled' });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

export default router;
