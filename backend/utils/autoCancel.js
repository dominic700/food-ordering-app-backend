import pool from '../db/connection.js';
import { sendTelegramMessage, orderCancelledMessage, transferRefundReminderMessage } from './telegramBot.js';
import { createNotification } from './notifications.js';

const AUTO_CANCEL_MINUTES = 7;

export async function autoCancelOrders() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Find all orders pending longer than AUTO_CANCEL_MINUTES
    // Include all info needed for both customer + cafe owner messages
    const staleOrders = await client.query(`
      SELECT
        o.*,
        ga.telegram_id   AS customer_telegram_id,
        ga.name          AS customer_name,
        ga.phone         AS customer_phone,
        ga.language      AS customer_language,
        c.name           AS cafe_name,
        co.phone         AS owner_phone,
        co.telegram_id   AS owner_telegram_id,
        co.language      AS owner_language
      FROM orders o
      JOIN per_cafe_accounts pca ON o.per_cafe_account_id = pca.id
      JOIN global_accounts ga    ON pca.global_account_id = ga.id
      JOIN cafes c               ON o.cafe_id = c.id
      JOIN cafe_owners co        ON co.cafe_id = c.id
      WHERE o.status = 'pending'
        AND o.created_at < NOW() - ($1 * INTERVAL '1 minute')
    `, [AUTO_CANCEL_MINUTES]);

    if (staleOrders.rows.length === 0) {
      await client.query('ROLLBACK');
      return;
    }

    console.log(`[auto-cancel] Found ${staleOrders.rows.length} stale order(s) to cancel`);

    for (const order of staleOrders.rows) {

      // Refund wallet orders — balance was deducted at order time
      const refundAmount =
        parseFloat(order.paid_from_balance || 0) +
        parseFloat(order.paid_from_credit  || 0);

      if (refundAmount > 0) {
        await client.query(`
          UPDATE per_cafe_accounts
          SET balance = balance + $1
          WHERE id = $2
        `, [refundAmount, order.per_cafe_account_id]);
      }

      // Cancel the order
      await client.query(`
        UPDATE orders
        SET status = 'cancelled',
            cancelled_at = NOW(),
            note = COALESCE(note || ' ', '') || $1
        WHERE id = $2
      `, [`[auto-cancelled: no response within ${AUTO_CANCEL_MINUTES} min]`, order.id]);

      const isTransfer = order.payment_method === 'transfer';

      // ── Notify customer ──────────────────────────────────────
      // Transfer orders: tell customer to contact cafe owner for refund
      // Wallet orders: mention automatic balance refund
      sendTelegramMessage(
        order.customer_telegram_id,
        orderCancelledMessage(order, order.cafe_name, order.owner_phone, 'auto', order.customer_language)
      );

      createNotification({
        telegramId: order.customer_telegram_id,
        cafeId:     order.cafe_id,
        type:       'order_cancelled',
        title:      `Order auto-cancelled — ${parseFloat(order.total).toFixed(2)} ETB`,
        body:       isTransfer
          ? `${order.cafe_name} didn't respond in time. Contact them at ${order.owner_phone} for your transfer refund.`
          : `${order.cafe_name} didn't respond within ${AUTO_CANCEL_MINUTES} minutes.${refundAmount > 0 ? ` ${refundAmount.toFixed(2)} ETB refunded.` : ''}`,
      });

      // ── Notify cafe owner ────────────────────────────────────
      // Always notify them the order was auto-cancelled
      // Transfer orders: also remind them to send back the money
      if (isTransfer) {
        sendTelegramMessage(
          order.owner_telegram_id,
          transferRefundReminderMessage(order, order.customer_name, order.customer_phone, 'auto', order.owner_language)
        );

        createNotification({
          telegramId: order.owner_telegram_id,
          cafeId:     order.cafe_id,
          type:       'refund_required',
          title:      `Refund required — ${parseFloat(order.total).toFixed(2)} ETB to ${order.customer_name}`,
          body:       `Send ${parseFloat(order.total).toFixed(2)} ETB back to ${order.customer_name} (${order.customer_phone}).`
        });
      } else {
        // Non-transfer: just let the cafe owner know it was auto-cancelled
        createNotification({
          telegramId: order.owner_telegram_id,
          cafeId:     order.cafe_id,
          type:       'order_cancelled',
          title:      `Order auto-cancelled — #${order.id?.slice(0, 8)}`,
          body:       `Order from ${order.customer_name} was auto-cancelled after ${AUTO_CANCEL_MINUTES} minutes with no response.`
        });
      }

      console.log(`[auto-cancel] Cancelled order ${order.id} at ${order.cafe_name} (${order.payment_method})`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[auto-cancel] Error:', err.message);
  } finally {
    client.release();
  }
}


export function startAutoCancelJob() {
  console.log(`[auto-cancel] Job started — cancels pending orders after ${AUTO_CANCEL_MINUTES} minutes`);
  autoCancelOrders(); // run once immediately on startup
  setInterval(autoCancelOrders, 60 * 1000); // then every 60 seconds
}
