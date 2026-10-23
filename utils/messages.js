// ── buildWelcome ───────────────────────────────────────────────
// webAppUrl is passed in from index.js so this file doesn't need
// its own dotenv — it shares the parent process environment.
export function buildWelcome(role, account, webAppUrl) {
  switch (role) {
    case 'admin':
      return {
        text:
          `👋 Welcome back, *${account.name || 'Admin'}*!\n\n` +
          `You are logged in as the *Platform Admin*.\n` +
          `Tap the button below to open the Admin Terminal.`,
        options: {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '🏢 Open Admin Terminal', web_app: { url: `${webAppUrl}/admin` } }
          ]]}
        }
      };

    case 'cafe_owner':
      return {
        text:
          `👋 Welcome back, *${account.name || 'Cafe Owner'}*!\n\n` +
          `You are managing *${account.cafe_name}*.\n` +
          `Tap the button below to open your Cafe Dashboard.`,
        options: {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '☕ Open Cafe Dashboard', web_app: { url: `${webAppUrl}/cafe-home` } }
          ]]}
        }
      };

    case 'customer':
      return {
        text:
          `👋 Welcome back, *${account.name || 'there'}*!\n\n` +
          `Ready to order? Browse cafes, deposit money, and manage your account.\n` +
          `Tap the button below to open the app.`,
        options: {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: [[
            { text: '🍽️ Open Food App', web_app: { url: webAppUrl } }
          ]]}
        }
      };

    case 'new':
    default:
      return {
        text:
          `👋 *Welcome to the Food Ordering App!*\n\n` +
          `To get started, please share your phone number so we can create your account.\n\n` +
          `Tap the button below 👇`,
        options: {
          parse_mode: 'Markdown',
          reply_markup: {
            keyboard: [[{ text: '📱 Share Phone Number', request_contact: true }]],
            resize_keyboard: true,
            one_time_keyboard: true,
          }
        }
      };
  }
}

// ── buildPostRegistration ──────────────────────────────────────
export function buildPostRegistration(name, webAppUrl) {
  return {
    text:
      `✅ *Account created successfully!*\n\n` +
      `Welcome, *${name || 'there'}*! 🎉\n\n` +
      `You can now browse cafes, place orders, and manage your balance.\n` +
      `Tap the button below to open the app.`,
    options: {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[
        { text: '🍽️ Open Food App', web_app: { url: webAppUrl } }
      ]]}
    }
  };
}

// ── buildHelp ─────────────────────────────────────────────────
export function buildHelp() {
  return {
    text:
      `*Available commands:*\n\n` +
      `/start  — Open the app or register\n` +
      `/help   — Show this message\n` +
      `/app    — Open the food ordering app\n` +
      `/status — Check your account status`,
    options: { parse_mode: 'Markdown' }
  };
}
