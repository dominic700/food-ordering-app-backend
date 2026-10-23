import dotenv from 'dotenv';
dotenv.config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_URL   = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── sendTelegramMessage ────────────────────────────────────────
export async function sendTelegramMessage(chatId, text) {
  try {
    if (!BOT_TOKEN) {
      console.warn('TELEGRAM_BOT_TOKEN not set — skipping notification');
      return;
    }
    if (!chatId) return;

    const res = await fetch(`${API_URL}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    chatId,
        text,
        parse_mode: 'HTML',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      console.error('Telegram sendMessage failed:', body);
    }
  } catch (err) {
    console.error('Telegram notify error:', err.message);
  }
}


// ── Bot message text fragments (en / am) ────────────────────────
// Every message builder below picks its fragments from here based
// on the `lang` argument passed in ('en' | 'am', defaults to 'en').
// This mirrors frontend/src/i18n/translations.js in spirit, but is
// kept separate since bot messages use Telegram HTML formatting and
// different phrasing than in-app UI text.
const L = {
  en: {
    newOrderTitle:      '🔔 <b>New Order Received!</b>',
    customerLabel:      'Customer',
    unknownName:        'Unknown',
    orderIdLabel:       'Order ID',
    totalLabel:         'Total',
    paymentLabel:       'Payment',
    cashPaymentBold:     '💵 <b>CASH PAYMENT</b> — Collect money from customer!',
    transferLabel:       '🏦 Transfer',
    walletCreditLabel:   '👛 Wallet / Credit',
    cashImportant:       '⚠️ <b>IMPORTANT:</b> This customer will pay in <b>CASH</b>.\nDo not forget to collect',
    fromThem:            'from them!',
    openAppReview:       'Open the app to review and approve this order.',
    specialRequestLabel: '📝 Special Request',

    orderApprovedTitle:  '✅ <b>Order Approved!</b>',
    hasAccepted:         'has accepted your order',
    nowPreparing:        'It is now being prepared. 🎉',
    cashRemember:        '💵 <b>Remember:</b> Please bring',
    inCashToCollect:      'in cash to pay when you collect your order.',

    orderAutoCancelledTitle: '⏱ <b>Order Auto-Cancelled</b>',
    orderCancelledTitle:     '❌ <b>Order Cancelled</b>',
    autoCancelReasonPrefix:  'Your order was automatically cancelled because',
    autoCancelReasonSuffix:  "didn't respond within 7 minutes.",
    cancelledYourOrder:      'cancelled your order',
    refundedToWallet:        'has been refunded to your wallet balance automatically.',
    transferRefundTitle:     '🏦 <b>Transfer Refund Required</b>',
    youPaidByTransfer:       'You paid',
    byTransferCafeWillSend:  'by transfer. The cafe will send your money back.',
    contactOwnerRefund:      '📞 Contact the cafe owner to receive your refund:',
    contactCafeDirectly:     'Contact the cafe directly',
    sendTransferDetails:     'Send them your transfer account name and phone number so they can refund you.',
    weApologize:             'We apologize for the inconvenience.',

    refundReqAutoTitle:  '⏱ <b>Auto-Cancelled Order — Refund Required</b>',
    refundReqTitle:      '❌ <b>Cancelled Order — Refund Required</b>',
    paidByTransferWasCancelled: 'paid by <b>transfer</b> was cancelled.',
    needToSendBack:      '💸 You need to send',
    backToCustomer:       'back to the customer:',
    customerBold:         '👤 Customer',
    phoneBold:            '📞 Phone',
    notAvailable:         'Not available',
    askCustomerSend:      'Ask the customer to send you their transfer account name/number via inbox, then send the refund to their account.',
    providerUsed:         'Provider used',
    transferFallback:     'transfer',

    newRegTitle:         '📝 <b>New Registration Request</b>',
    phoneLabel:          'Phone',
    naText:              'N/A',
    wantsToRegister:      'They want to register for wallet balance and credit payments at your cafe.',
    openAppApproveReject: 'Open the app to approve or reject this request.',

    regApprovedTitle:    '🎉 <b>Registration Approved!</b>',
    approvedYourAccount: 'approved your account.',
    canNowPayWallet:      'You can now pay with your wallet balance there.',

    depositVerifiedTitle: '💰 <b>Deposit Verified!</b>',
    hasBeenAddedTo:        'has been added to your balance at',
    canNowOrderWallet:     'You can now order using your wallet.',

    creditLimitSetTitle:  '💳 <b>Credit Limit Set!</b>',
    setYourCreditLimitTo: 'set your credit limit to',
    canUseCreditNote:      'You can use credit once your balance reaches zero, up to this limit.',

    moneyReceivedTitle:   '💸 <b>Money Received!</b>',
    sentYou:              'sent you',
    atThisCafe:           'at this cafe.',
    yourNewBalance:       'Your new balance',

    theCafe: 'The cafe',
  },
  am: {
    newOrderTitle:      '🔔 <b>አዲስ ትዕዛዝ ደርሷል!</b>',
    customerLabel:      'ደንበኛ',
    unknownName:        'ያልታወቀ',
    orderIdLabel:       'የትዕዛዝ መታወቂያ',
    totalLabel:         'ጠቅላላ',
    paymentLabel:       'ክፍያ',
    cashPaymentBold:     '💵 <b>የጥሬ ገንዘብ ክፍያ</b> — ከደንበኛው ገንዘብ ይሰብስቡ!',
    transferLabel:       '🏦 ዝውውር',
    walletCreditLabel:   '👛 ዋሌት / ብድር',
    cashImportant:       '⚠️ <b>አስፈላጊ፦</b> ይህ ደንበኛ በ<b>ጥሬ ገንዘብ</b> ይከፍላል።\nከነሱ መሰብሰብ አይርሱ',
    fromThem:            '',
    openAppReview:       'ይህን ትዕዛዝ ለመገምገም እና ለማጽደቅ መተግበሪያውን ይክፈቱ።',
    specialRequestLabel: '📝 ልዩ ጥያቄ',

    orderApprovedTitle:  '✅ <b>ትዕዛዝ ጸድቋል!</b>',
    hasAccepted:         'ትዕዛዝዎን ተቀብሏል',
    nowPreparing:        'አሁን በዝግጅት ላይ ነው። 🎉',
    cashRemember:        '💵 <b>ያስታውሱ፦</b> እባክዎ ይዘው ይምጡ',
    inCashToCollect:      'በጥሬ ገንዘብ ትዕዛዝዎን ሲወስዱ ለመክፈል።',

    orderAutoCancelledTitle: '⏱ <b>ትዕዛዝ በራስ-ሰር ተሰርዟል</b>',
    orderCancelledTitle:     '❌ <b>ትዕዛዝ ተሰርዟል</b>',
    autoCancelReasonPrefix:  'ትዕዛዝዎ በራስ-ሰር ተሰርዟል ምክንያቱም',
    autoCancelReasonSuffix:  'በ7 ደቂቃ ውስጥ ምላሽ አልሰጠም።',
    cancelledYourOrder:      'ትዕዛዝዎን ሰርዟል',
    refundedToWallet:        'ወደ ዋሌት ሂሳብዎ በራስ-ሰር ተመልሷል።',
    transferRefundTitle:     '🏦 <b>የዝውውር ተመላሽ ገንዘብ ያስፈልጋል</b>',
    youPaidByTransfer:       'ከፍለዋል',
    byTransferCafeWillSend:  'በዝውውር። ካፌው ገንዘብዎን ይመልሳል።',
    contactOwnerRefund:      '📞 ተመላሽ ገንዘብዎን ለማግኘት የካፌውን ባለቤት ያግኙ፦',
    contactCafeDirectly:     'ካፌውን በቀጥታ ያግኙ',
    sendTransferDetails:     'የዝውውር ሂሳብ ስምዎን እና ስልክ ቁጥርዎን ይላኩላቸው ገንዘብዎን መልሰው እንዲልኩልዎ።',
    weApologize:             'ስለ ችግሩ ይቅርታ እንጠይቃለን።',

    refundReqAutoTitle:  '⏱ <b>በራስ-ሰር የተሰረዘ ትዕዛዝ — ተመላሽ ገንዘብ ያስፈልጋል</b>',
    refundReqTitle:      '❌ <b>የተሰረዘ ትዕዛዝ — ተመላሽ ገንዘብ ያስፈልጋል</b>',
    paidByTransferWasCancelled: 'በ<b>ዝውውር</b> የተከፈለ ትዕዛዝ ተሰርዟል።',
    needToSendBack:      '💸 መላክ አለብዎት',
    backToCustomer:       'ወደ ደንበኛው መልሰው፦',
    customerBold:         '👤 ደንበኛ',
    phoneBold:            '📞 ስልክ',
    notAvailable:         'አይገኝም',
    askCustomerSend:      'ደንበኛው የዝውውር ሂሳብ ስም/ቁጥር በኢንቦክስ እንዲልክልዎ ይጠይቁ፣ ከዚያም ገንዘቡን ወደ ሂሳባቸው ይላኩ።',
    providerUsed:         'ጥቅም ላይ የዋለ አገልግሎት',
    transferFallback:     'ዝውውር',

    newRegTitle:         '📝 <b>አዲስ የምዝገባ ጥያቄ</b>',
    phoneLabel:          'ስልክ',
    naText:              'የለም',
    wantsToRegister:      'በካፌዎ ውስጥ ለዋሌት ሂሳብ እና ብድር ክፍያዎች መመዝገብ ይፈልጋሉ።',
    openAppApproveReject: 'ይህን ጥያቄ ለማጽደቅ ወይም ውድቅ ለማድረግ መተግበሪያውን ይክፈቱ።',

    regApprovedTitle:    '🎉 <b>ምዝገባ ጸድቋል!</b>',
    approvedYourAccount: 'መለያዎን አጽድቋል።',
    canNowPayWallet:      'አሁን በዚያ በዋሌት ሂሳብዎ መክፈል ይችላሉ።',

    depositVerifiedTitle: '💰 <b>ተቀማጭ ገንዘብ ተረጋግጧል!</b>',
    hasBeenAddedTo:        'ወደ ሂሳብዎ ታክሏል በ',
    canNowOrderWallet:     'አሁን ዋሌትዎን በመጠቀም ማዘዝ ይችላሉ።',

    creditLimitSetTitle:  '💳 <b>የብድር ገደብ ተቀናብሯል!</b>',
    setYourCreditLimitTo: 'የብድር ገደብዎን አዘጋጅቷል ወደ',
    canUseCreditNote:      'ሂሳብዎ ዜሮ ላይ ከደረሰ በኋላ እስከዚህ ገደብ ድረስ ብድር መጠቀም ይችላሉ።',

    moneyReceivedTitle:   '💸 <b>ገንዘብ ደርሷል!</b>',
    sentYou:              'ልኮልዎታል',
    atThisCafe:           'በዚህ ካፌ።',
    yourNewBalance:       'የአዲስ ሂሳብዎ',

    theCafe: 'ካፌው',
  },
};

function pick(lang) {
  return L[lang] === undefined ? L.en : L[lang];
}


// ── newOrderMessage ────────────────────────────────────────────
// Sent to CAFE OWNER when a new order arrives.
// Cash orders get a special warning to collect payment.
export function newOrderMessage(order, customerName, items, lang = 'en') {
  const t = pick(lang);
  const itemLines = items
    .map(i => `• ${i.quantity}x ${i.name} — ${parseFloat(i.item_total).toFixed(2)} ETB`)
    .join('\n');

  const isCash     = order.payment_method === 'cash';
  const isTransfer = order.payment_method === 'transfer';

  let paymentLine = '';
  if (isCash) {
    paymentLine = t.cashPaymentBold;
  } else if (isTransfer) {
    paymentLine = `${t.transferLabel} (${order.transfer_provider?.replace('_', ' ')})`;
  } else {
    paymentLine = t.walletCreditLabel;
  }

  // Extra warning block for cash orders
  const cashWarning = isCash
    ? `\n\n${t.cashImportant} <b>${parseFloat(order.total).toFixed(2)} ETB</b> ${t.fromThem}`
    : '';

  // Customer's special request note, if they left one
  const noteBlock = order.note && order.note.trim()
    ? `\n\n${t.specialRequestLabel}: <b>${order.note.trim()}</b>`
    : '';

  return (
    `${t.newOrderTitle}\n\n` +
    `${t.customerLabel}: ${customerName || t.unknownName}\n` +
    `${t.orderIdLabel}: #${order.id?.slice(0, 8)}\n\n` +
    `${itemLines}\n\n` +
    `${t.totalLabel}: <b>${parseFloat(order.total).toFixed(2)} ETB</b>\n` +
    `${t.paymentLabel}: ${paymentLine}` +
    `${cashWarning}` +
    `${noteBlock}\n\n` +
    `${t.openAppReview}`
  );
}


// ── orderApprovedMessage ───────────────────────────────────────
// Sent to CUSTOMER when cafe approves their order.
// Cash orders remind the customer to bring their money.
export function orderApprovedMessage(order, cafeName, lang = 'en') {
  const t = pick(lang);
  const isCash = order.payment_method === 'cash';

  const cashReminder = isCash
    ? `\n\n${t.cashRemember} <b>${parseFloat(order.total).toFixed(2)} ETB</b> ${t.inCashToCollect}`
    : '';

  return (
    `${t.orderApprovedTitle}\n\n` +
    `<b>${cafeName}</b> ${t.hasAccepted} #${order.id?.slice(0, 8)}.\n` +
    `${t.totalLabel}: <b>${parseFloat(order.total).toFixed(2)} ETB</b>\n\n` +
    `${t.nowPreparing}` +
    `${cashReminder}`
  );
}


// ── orderCancelledMessage ───────────────────────────────────────
// Sent to CUSTOMER when the cafe manually cancels their order.
// Transfer orders get special refund instructions with cafe owner
// phone so the customer knows who to contact.
export function orderCancelledMessage(order, cafeName, cafeOwnerPhone, cancelledBy = 'cafe', lang = 'en') {
  const t = pick(lang);
  const wasWallet   = order.payment_method === 'wallet';
  const wasTransfer = order.payment_method === 'transfer';
  const wasAuto     = cancelledBy === 'auto';

  const refundAmount = parseFloat(order.paid_from_balance || 0) + parseFloat(order.paid_from_credit || 0);

  const header = wasAuto ? t.orderAutoCancelledTitle : t.orderCancelledTitle;

  const reason = wasAuto
    ? `${t.autoCancelReasonPrefix} <b>${cafeName}</b> ${t.autoCancelReasonSuffix}`
    : `<b>${cafeName}</b> ${t.cancelledYourOrder} #${order.id?.slice(0, 8)}.`;

  let refundNote = '';
  if (wasWallet && refundAmount > 0) {
    refundNote = `\n\n💰 <b>${refundAmount.toFixed(2)} ETB</b> ${t.refundedToWallet}`;
  } else if (wasTransfer) {
    refundNote =
      `\n\n${t.transferRefundTitle}\n` +
      `${t.youPaidByTransfer} <b>${parseFloat(order.total).toFixed(2)} ETB</b> ${t.byTransferCafeWillSend}\n\n` +
      `${t.contactOwnerRefund}\n` +
      `<b>${cafeOwnerPhone || t.contactCafeDirectly}</b>\n\n` +
      `${t.sendTransferDetails}`;
  }

  return (
    `${header}\n\n` +
    `${reason}\n` +
    `${t.totalLabel}: <b>${parseFloat(order.total).toFixed(2)} ETB</b>` +
    `${refundNote}\n\n` +
    `${t.weApologize}`
  );
}


// ── transferRefundReminderMessage ─────────────────────────────
// Sent to CAFE OWNER when they cancel a transfer order —
// reminds them to send back the money to the customer and gives
// the customer's phone number.
export function transferRefundReminderMessage(order, customerName, customerPhone, cancelledBy = 'cafe', lang = 'en') {
  const t = pick(lang);
  const wasAuto = cancelledBy === 'auto';
  const header  = wasAuto ? t.refundReqAutoTitle : t.refundReqTitle;

  return (
    `${header}\n\n` +
    `Order #${order.id?.slice(0, 8)} ${t.paidByTransferWasCancelled}\n\n` +
    `${t.needToSendBack} <b>${parseFloat(order.total).toFixed(2)} ETB</b> ${t.backToCustomer}\n\n` +
    `${t.customerBold}: <b>${customerName || t.unknownName}</b>\n` +
    `${t.phoneBold}: <b>${customerPhone || t.notAvailable}</b>\n\n` +
    `${t.askCustomerSend}\n\n` +
    `${t.providerUsed}: ${order.transfer_provider?.replace('_', ' ') || t.transferFallback}`
  );
}


// ── newRegistrationMessage ──────────────────────────────────────
// Sent to CAFE OWNER when a customer requests to register
// (wallet/credit access). Without this push message, the cafe
// owner would only see the request if they happened to open the
// in-app notification bell — easy to miss, so this is the primary
// alert, same as new orders.
export function newRegistrationMessage(customerName, customerPhone, lang = 'en') {
  const t = pick(lang);
  return (
    `${t.newRegTitle}\n\n` +
    `${t.customerLabel}: <b>${customerName || t.unknownName}</b>\n` +
    `${t.phoneLabel}: ${customerPhone || t.naText}\n\n` +
    `${t.wantsToRegister}\n` +
    `${t.openAppApproveReject}`
  );
}


// ── registrationApprovedMessage ──────────────────────────────────
// Sent to CUSTOMER when the cafe approves their registration.
export function registrationApprovedMessage(cafeName, lang = 'en') {
  const t = pick(lang);
  return (
    `${t.regApprovedTitle}\n\n` +
    `<b>${cafeName}</b> ${t.approvedYourAccount}\n` +
    `${t.canNowPayWallet}`
  );
}


// ── depositVerifiedMessage ───────────────────────────────────────
// Sent to CUSTOMER when their deposit is verified and added to balance.
export function depositVerifiedMessage(amount, cafeName, lang = 'en') {
  const t = pick(lang);
  return (
    `${t.depositVerifiedTitle}\n\n` +
    `<b>${parseFloat(amount).toFixed(2)} ETB</b> ${t.hasBeenAddedTo} <b>${cafeName}</b>.\n\n` +
    `${t.canNowOrderWallet}`
  );
}


// ── creditLimitSetMessage ─────────────────────────────────────────
// Sent to CUSTOMER when the cafe owner sets or updates their credit
// limit directly from the customer's profile (no application step —
// the cafe owner can do this any time after approving registration).
export function creditLimitSetMessage(cafeName, limit, lang = 'en') {
  const t = pick(lang);
  return (
    `${t.creditLimitSetTitle}\n\n` +
    `<b>${cafeName}</b> ${t.setYourCreditLimitTo} <b>${parseFloat(limit).toFixed(2)} ETB</b>.\n\n` +
    `${t.canUseCreditNote}`
  );
}


// ── moneyReceivedMessage ──────────────────────────────────────────
// Sent to a CUSTOMER when another customer at the same cafe sends
// them money via the peer-to-peer wallet transfer.
export function moneyReceivedMessage(senderName, amount, newBalance, lang = 'en') {
  const t = pick(lang);
  return (
    `${t.moneyReceivedTitle}\n\n` +
    `<b>${senderName}</b> ${t.sentYou} <b>${parseFloat(amount).toFixed(2)} ETB</b> ${t.atThisCafe}\n` +
    `${t.yourNewBalance}: <b>${parseFloat(newBalance).toFixed(2)} ETB</b>`
  );
}
