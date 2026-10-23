// ── Telebirr Receipt Verifier ─────────────────────────────────
const BASE_URL = 'https://transactioninfo.ethiotelecom.et/receipt/';

export function extractReceiptCode(input) {
  const s = input.trim();
  const urlMatch = s.match(/transactioninfo\.ethiotelecom\.et\/receipt\/([A-Z0-9]+)/i);
  if (urlMatch) return urlMatch[1].toUpperCase();
  const amharicMatch = s.match(/ቁጥርዎ\s+([A-Z0-9]+)\s+ነዉ/);
  if (amharicMatch) return amharicMatch[1].toUpperCase();
  const clean = s.toUpperCase().replace(/\s/g, '');
  if (/^[A-Z0-9]{8,12}$/.test(clean)) return clean;
  return null;
}

async function fetchReceipt(receiptCode) {
  const url = BASE_URL + receiptCode;
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/91.0.4472.124 Safari/537.36' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseReceipt(html) {
  const data = {};
  const clean = (s) => s ? s.replace(/\s+/g, ' ').trim() : '';
  const stripTags = (s) => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&#[0-9]+;/g, '');

  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(m => clean(stripTags(m[1])));
    if (cells.length < 2) continue;
    const label = cells[0].toLowerCase();
    const value = cells[1];
    if (label.includes('payer name'))                  data.payer_name      = value;
    else if (label.includes('payer telebirr'))         data.payer_phone     = value;
    else if (label.includes('credited party name'))    data.credited_name   = value;
    else if (label.includes('credited party account')) data.credited_phone  = value;
    if (cells.length >= 3 && cells[2].toLowerCase().includes('birr')) {
      data.settled_amount = cells[2];
    }
  }
  return data;
}

export async function verifyTelebirrPayment(userInput, expectedAmount, cafeAccount) {
  const { telebirr_name, telebirr_phone } = cafeAccount;

  if (!telebirr_name || !telebirr_phone) {
    return { success: false, message: '❌ This cafe has not set up their Telebirr account info yet.', amount: null, receiptCode: null, data: null };
  }

  const receiptCode = extractReceiptCode(userInput);
  if (!receiptCode) {
    return { success: false, message: '❌ Invalid input. Please send a valid Telebirr receipt link, code, or SMS.', amount: null, receiptCode: null, data: null };
  }

  let html;
  try {
    html = await fetchReceipt(receiptCode);
  } catch (err) {
    return { success: false, message: '❌ Could not connect to Telebirr server. Please try again.', amount: null, receiptCode, data: null };
  }

  const data = parseReceipt(html);

  // Verify recipient name
  const creditedName = (data.credited_name || '').toLowerCase().trim();
  const expectedName = telebirr_name.toLowerCase().trim();
  if (!creditedName.includes(expectedName) && !expectedName.includes(creditedName)) {
    return {
      success: false,
      message: `❌ Wrong recipient. Money was sent to "${data.credited_name || 'unknown'}" but expected "${telebirr_name}".`,
      amount: null, receiptCode, data,
    };
  }

  // Verify recipient phone last 4 digits
  const creditedPhone = (data.credited_phone || '').replace(/\s/g, '');
  const expectedSuffix = telebirr_phone.replace(/\s/g, '').slice(-4);
  if (!creditedPhone.endsWith(expectedSuffix)) {
    return {
      success: false,
      message: `❌ Wrong account. Sent to ...${creditedPhone.slice(-4)} but expected ...${expectedSuffix}.`,
      amount: null, receiptCode, data,
    };
  }

  // Verify amount
  const amountStr = (data.settled_amount || '0').toLowerCase().replace(/birr/g, '').replace(/,/g, '').trim();
  const actualAmount = parseFloat(amountStr);
  if (isNaN(actualAmount)) {
    return { success: false, message: '❌ Could not read the amount from the receipt.', amount: null, receiptCode, data };
  }
  if (actualAmount < expectedAmount) {
    return {
      success: false,
      message: `❌ Insufficient amount. Paid ${actualAmount} Birr but expected ${expectedAmount} Birr.`,
      amount: actualAmount, receiptCode, data,
    };
  }

  return {
    success: true,
    message: `✅ Payment verified! Amount: ${actualAmount} Birr | Receipt: ${receiptCode}`,
    amount: actualAmount, receiptCode, data,
  };
}
