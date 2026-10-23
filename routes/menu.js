import express from 'express';
import pool from '../db/connection.js';
import { telegramAuth, cafeOwnerAuth } from '../middleware/auth.js';

const router = express.Router();
const round2 = (n) => Math.round(n * 100) / 100;

// ── GET /api/menu/:cafeId ─────────────────────────────────────
// Public — customer-facing menu.
//
// For each item, returns:
//   base_price        -> what the cafe owner entered (raw)
//   list_price        -> base_price + cafe.service_fee (no discount).
//                         This is what 'transfer' orders pay.
//   price             -> list_price after the item's own discount_percent
//                         is applied. This is what 'wallet' orders
//                         (balance and/or credit) pay, and is the
//                         primary price shown to the customer.
//   discount_percent  -> the item's discount, for showing a badge /
//                         strikethrough list_price in the UI.
router.get('/:cafeId', async (req, res) => {
  try {
    const { cafeId } = req.params;

    const cafeResult = await pool.query(
      'SELECT service_fee FROM cafes WHERE id = $1', [cafeId]
    );
    if (cafeResult.rows.length === 0) return res.status(404).json({ error: 'Cafe not found' });
    const serviceFee = parseFloat(cafeResult.rows[0].service_fee);

    const categories = await pool.query(`
      SELECT * FROM menu_categories WHERE cafe_id = $1
      ORDER BY display_order ASC, name ASC
    `, [cafeId]);

    const items = await pool.query(`
      SELECT * FROM menu_items WHERE cafe_id = $1 AND is_available = true
      ORDER BY category_id, name ASC
    `, [cafeId]);

    const itemsWithPricing = items.rows.map(item => {
      const basePrice = parseFloat(item.price);
      const discountPercent = parseFloat(item.discount_percent);
      const listPrice = round2(basePrice + serviceFee);
      const walletPrice = round2(listPrice * (1 - discountPercent / 100));

      return {
        ...item,
        base_price: basePrice.toFixed(2),
        list_price: listPrice.toFixed(2),
        price: walletPrice.toFixed(2),
        discount_percent: discountPercent
      };
    });

    res.json({
      categories: categories.rows,
      items: itemsWithPricing,
      service_fee: serviceFee
    });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── GET /api/menu/:cafeId/all ─────────────────────────────────
// Cafe owner — menu editor view.
// `price` and `discount_percent` here are the raw values the owner
// set/edits. `service_fee` is returned so the editor can preview the
// customer-facing list price (base_price + service_fee) and the
// wallet price after the item's discount.
router.get('/:cafeId/all', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;

    const cafeResult = await pool.query('SELECT service_fee FROM cafes WHERE id = $1', [cafe_id]);
    const serviceFee = parseFloat(cafeResult.rows[0]?.service_fee || 0);

    const categories = await pool.query(
      'SELECT * FROM menu_categories WHERE cafe_id = $1 ORDER BY display_order ASC',
      [cafe_id]
    );
    const items = await pool.query(
      'SELECT * FROM menu_items WHERE cafe_id = $1 ORDER BY category_id, name ASC',
      [cafe_id]
    );

    res.json({ categories: categories.rows, items: items.rows, service_fee: serviceFee });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/menu/categories ─────────────────────────────────
router.post('/categories', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const { name, display_order } = req.body;
    if (!name) return res.status(400).json({ error: 'Category name is required' });

    const result = await pool.query(`
      INSERT INTO menu_categories (cafe_id, name, display_order)
      VALUES ($1, $2, $3) RETURNING *
    `, [cafe_id, name, display_order || 0]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── DELETE /api/menu/categories/:id ──────────────────────────
router.delete('/categories/:id', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    await pool.query(
      'DELETE FROM menu_categories WHERE id = $1 AND cafe_id = $2',
      [req.params.id, cafe_id]
    );
    res.json({ message: 'Category deleted' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── POST /api/menu/items ──────────────────────────────────────
// `price` submitted here is the BASE price (before the cafe's
// service fee is added for customers).
// `discount_percent` (0-100, optional, default 0) is set by the cafe
// owner per item — applies only to 'wallet' orders (balance + credit).
router.post('/items', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const { category_id, name, description, price, image_url, discount_percent } = req.body;
    if (!name || !price) return res.status(400).json({ error: 'Name and price are required' });

    const discount = discount_percent !== undefined ? parseFloat(discount_percent) : 0;
    if (isNaN(discount) || discount < 0 || discount > 100) {
      return res.status(400).json({ error: 'discount_percent must be a number between 0 and 100' });
    }

    const result = await pool.query(`
      INSERT INTO menu_items (cafe_id, category_id, name, description, price, discount_percent, image_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *
    `, [cafe_id, category_id || null, name, description, price, discount, image_url]);

    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── PATCH /api/menu/items/:itemId ─────────────────────────────
// Cafe owner can update discount_percent here too — e.g. to run a
// promotion on a specific item for wallet/credit customers.
router.patch('/items/:itemId', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const { name, description, price, image_url, is_available, category_id, discount_percent } = req.body;

    if (discount_percent !== undefined) {
      const d = parseFloat(discount_percent);
      if (isNaN(d) || d < 0 || d > 100) {
        return res.status(400).json({ error: 'discount_percent must be a number between 0 and 100' });
      }
    }

    const result = await pool.query(`
      UPDATE menu_items
      SET name             = COALESCE($1, name),
          description      = COALESCE($2, description),
          price            = COALESCE($3, price),
          image_url        = COALESCE($4, image_url),
          is_available     = COALESCE($5, is_available),
          category_id      = COALESCE($6, category_id),
          discount_percent = COALESCE($7, discount_percent)
      WHERE id = $8 AND cafe_id = $9 RETURNING *
    `, [name, description, price, image_url, is_available, category_id, discount_percent, req.params.itemId, cafe_id]);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});


// ── DELETE /api/menu/items/:itemId ────────────────────────────
router.delete('/items/:itemId', telegramAuth, cafeOwnerAuth, async (req, res) => {
  try {
    const { cafe_id } = req.cafeOwner;
    const result = await pool.query(
      'DELETE FROM menu_items WHERE id = $1 AND cafe_id = $2 RETURNING id',
      [req.params.itemId, cafe_id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Item not found' });
    res.json({ message: 'Item deleted' });
  } catch (err) {
    console.error(err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

export default router;
