import express    from 'express';
import cors       from 'cors';
import dotenv     from 'dotenv';
import path       from 'path';
import { fileURLToPath } from 'url';
import TelegramBot from 'node-telegram-bot-api';

import authRoutes         from './routes/auth.js';
import adminRoutes        from './routes/admin.js';
import cafeRoutes         from './routes/cafe.js';
import customerRoutes     from './routes/customer.js';
import orderRoutes        from './routes/orders.js';
import menuRoutes         from './routes/menu.js';
import depositRoutes      from './routes/deposits.js';
import notificationRoutes from './routes/notifications.js';

import pool                from './db/connection.js';
import { startAutoCancelJob } from './utils/autoCancel.js';
import { detectRole, saveCustomer } from './utils/roles.js';
import { buildWelcome, buildPostRegistration, buildHelp } from './utils/messages.js';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 5000;

// ── Service status tracker ─────────────────────────────────────
// Tracks DB + bot health so /health endpoint can report it
const status = {
  db:        { ok: false, error: null,  checkedAt: null },
  bot:       { ok: false, error: null,  startedAt: null },
  autoCancel:{ ok: false, startedAt: null },
  startedAt: new Date().toISOString(),
};

// ── Middleware ────────────────────────────────────────────────
app.use(express.json());
app.use(cors({ origin: process.env.FRONTEND_URL || '*', credentials: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Routes ────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/admin',         adminRoutes);
app.use('/api/cafe',          cafeRoutes);
app.use('/api/customer',      customerRoutes);
app.use('/api/orders',        orderRoutes);
app.use('/api/menu',          menuRoutes);
app.use('/api/deposits',      depositRoutes);
app.use('/api/notifications', notificationRoutes);

// ── GET / ─────────────────────────────────────────────────────
// Render health check — shows all service statuses
app.get('/', (req, res) => {
  res.json({
    service:   'Food Ordering Platform',
    api:       'running',
    db:        status.db.ok ? 'connected' : `error: ${status.db.error}`,
    bot:       status.bot.ok ? 'running' : `error: ${status.bot.error}`,
    autoCancel: status.autoCancel.ok ? 'running' : 'stopped',
    uptime:    process.uptime().toFixed(0) + 's',
    startedAt: status.startedAt,
  });
});

// ── GET /health ────────────────────────────────────────────────
// More detailed health check with all service states
app.get('/health', async (req, res) => {
  // Live DB ping on every /health request
  try {
    const result = await pool.query('SELECT NOW() AS now');
    status.db.ok        = true;
    status.db.error     = null;
    status.db.checkedAt = result.rows[0].now;
  } catch (err) {
    status.db.ok    = false;
    status.db.error = err.message;
  }

  const allOk = status.db.ok && status.bot.ok && status.autoCancel.ok;

  res.status(allOk ? 200 : 503).json({
    status:    allOk ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    services: {
      api: {
        status:    'running',
        uptime:    process.uptime().toFixed(0) + 's',
        startedAt: status.startedAt,
      },
      database: {
        status:    status.db.ok ? 'connected' : 'error',
        error:     status.db.error,
        checkedAt: status.db.checkedAt,
      },
      bot: {
        status:    status.bot.ok ? 'running' : 'error',
        error:     status.bot.error,
        startedAt: status.bot.startedAt,
      },
      autoCancel: {
        status:    status.autoCancel.ok ? 'running' : 'stopped',
        startedAt: status.autoCancel.startedAt,
      },
    },
  });
});

// ── 404 ───────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `Route ${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});


// ── startBot ──────────────────────────────────────────────────
// Starts the Telegram bot in polling mode.
// The bot uses the same DB connection as the API — no separate
// bot service or separate database URL needed.
function startBot() {
  const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const WEB_APP_URL = process.env.WEB_APP_URL;

  if (!TOKEN) {
    status.bot.ok    = false;
    status.bot.error = 'TELEGRAM_BOT_TOKEN not set';
    console.error('❌ Bot not started: TELEGRAM_BOT_TOKEN is missing');
    return;
  }

  // polling: { params: { timeout: 10 } } uses a shorter long-poll
  // window than the default (which can be 30-50s) — this means if
  // this instance dies or gets redeployed, Telegram frees up the
  // getUpdates slot for the next instance much sooner, shrinking the
  // window where two instances briefly overlap and produce
  // "409 Conflict: terminated by other getUpdates request".
  // deleteWebHook() also clears out any webhook that might have been
  // set previously by mistake — a webhook and polling can't both be
  // active for the same bot token.
  const bot = new TelegramBot(TOKEN, { polling: { params: { timeout: 10 } } });
  bot.deleteWebHook().catch(err => console.error('deleteWebHook error:', err.message));

  // Make bot instance available for sendTelegramMessage() in utils/telegramBot.js
  // by storing it on the global so existing route files can reach it.
  // (telegramBot.js already creates its own instance — we keep that for
  //  push notifications to stay backward compatible with existing routes)

  // ── /start ────────────────────────────────────────────────
  bot.onText(/\/start/, async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;
    try {
      const { role, account } = await detectRole(telegramId);
      const { text, options } = buildWelcome(role, account, WEB_APP_URL);
      await bot.sendMessage(chatId, text, options);
    } catch (err) {
      console.error('/start error:', err.message);
      await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
    }
  });

  // ── Contact (phone share) ─────────────────────────────────
  bot.on('contact', async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;
    const contact    = msg.contact;

    if (contact.user_id !== telegramId) {
      await bot.sendMessage(chatId, '⚠️ Please share your own phone number.');
      return;
    }
    try {
      const name  = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
                    || msg.from.username || 'Customer';
      const phone = contact.phone_number;
      await saveCustomer(telegramId, name, phone);
      const { text, options } = buildPostRegistration(name, WEB_APP_URL);
      await bot.sendMessage(chatId, text, options);
    } catch (err) {
      console.error('contact error:', err.message);
      await bot.sendMessage(chatId, '⚠️ Failed to create your account. Please try /start again.');
    }
  });

  // ── /app ──────────────────────────────────────────────────
  bot.onText(/\/app/, async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;
    try {
      const { role, account } = await detectRole(telegramId);
      if (role === 'new') {
        await bot.sendMessage(chatId, '⚠️ You need to register first. Send /start to get started.');
        return;
      }
      const { text, options } = buildWelcome(role, account, WEB_APP_URL);
      await bot.sendMessage(chatId, text, options);
    } catch (err) {
      console.error('/app error:', err.message);
      await bot.sendMessage(chatId, '⚠️ Something went wrong. Please try again.');
    }
  });

  // ── /status ───────────────────────────────────────────────
  bot.onText(/\/status/, async (msg) => {
    const chatId     = msg.chat.id;
    const telegramId = msg.from.id;
    try {
      const { role, account } = await detectRole(telegramId);
      let text = '';
      if      (role === 'new')        text = '❌ Not registered. Send /start to create your account.';
      else if (role === 'admin')      text = `✅ *Admin*\nName: ${account.name}`;
      else if (role === 'cafe_owner') text = `✅ *Cafe Owner*\nName: ${account.name}\nCafe: ${account.cafe_name}`;
      else                            text = `✅ *Customer*\nName: ${account.name}\nPhone: ${account.phone}`;
      await bot.sendMessage(chatId, text, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error('/status error:', err.message);
      await bot.sendMessage(chatId, '⚠️ Something went wrong.');
    }
  });

  // ── /help ─────────────────────────────────────────────────
  bot.onText(/\/help/, async (msg) => {
    const { text, options } = buildHelp();
    await bot.sendMessage(msg.chat.id, text, options);
  });

  // ── Unknown messages ──────────────────────────────────────
  bot.on('message', async (msg) => {
    if (msg.text?.startsWith('/') || msg.contact) return;
    await bot.sendMessage(
      msg.chat.id,
      '👋 Send /start to open the app or /help to see available commands.'
    );
  });

  // ── Error handling ────────────────────────────────────────
  bot.on('polling_error', (err) => {
    status.bot.ok    = false;
    status.bot.error = err.message;
    console.error('Bot polling error:', err.message);
  });

  bot.on('error', (err) => {
    status.bot.ok    = false;
    status.bot.error = err.message;
    console.error('Bot error:', err.message);
  });

  status.bot.ok        = true;
  status.bot.error     = null;
  status.bot.startedAt = new Date().toISOString();
  console.log('🤖 Telegram bot started (polling)');
}


// ── checkDatabase ─────────────────────────────────────────────
async function checkDatabase() {
  try {
    await pool.query('SELECT 1');
    status.db.ok        = true;
    status.db.error     = null;
    status.db.checkedAt = new Date().toISOString();
    console.log('✅ Database connected');
  } catch (err) {
    status.db.ok    = false;
    status.db.error = err.message;
    console.error('❌ Database connection failed:', err.message);
  }
}


// ── Start everything ──────────────────────────────────────────
app.listen(process.env.PORT || 5000, '0.0.0.0', async () => {
  console.log(`Server running on port ${process.env.PORT || 5000}`);

  // 1. Check database
  await checkDatabase();

  // 2. Start bot
  startBot();

  // 3. Start auto-cancel job
  try {
    startAutoCancelJob();
    status.autoCancel.ok        = true;
    status.autoCancel.startedAt = new Date().toISOString();
  } catch (err) {
    console.error('❌ Auto-cancel job failed to start:', err.message);
  }

  console.log('');
  console.log('═══════════════════════════════════');
  console.log('  Food Ordering Platform Running');
  console.log(`  API:        http://localhost:${PORT}`);
  console.log(`  Health:     http://localhost:${PORT}/health`);
  console.log(`  DB:         ${status.db.ok ? '✅ Connected' : '❌ Failed'}`);
  console.log(`  Bot:        ${status.bot.ok ? '✅ Running' : '❌ Failed'}`);
  console.log(`  AutoCancel: ✅ Running (every 60s)`);
  console.log('═══════════════════════════════════');
});
