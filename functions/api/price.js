/* ============================================================
   functions/api/price.js — the current membership price, read from Stripe
   ------------------------------------------------------------
   GET /api/price → { amount, currency, interval, display }
   Public (the price is public). Lets the site show the real price without it
   being hardcoded, so changing the Stripe Price is the only edit needed.

   Env: STRIPE_SECRET_KEY, STRIPE_PRICE_ID
   ============================================================ */

const SYMBOLS = { GBP: '£', USD: '$', EUR: '€' };

export async function onRequestGet({ env }) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) return json({ error: 'config' });
  try {
    const r = await fetch('https://api.stripe.com/v1/prices/' + env.STRIPE_PRICE_ID, {
      headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
    });
    const p = await r.json();
    if (!r.ok || p.unit_amount == null) return json({ error: 'stripe' });
    const amount = p.unit_amount / 100;
    const currency = (p.currency || 'gbp').toUpperCase();
    const interval = (p.recurring && p.recurring.interval) || 'month';
    const symbol = SYMBOLS[currency] || '';
    const display = symbol ? symbol + amount.toFixed(2) : amount.toFixed(2) + ' ' + currency;
    return json({ amount, currency, interval, display });
  } catch (_) {
    return json({ error: 'failed' });
  }
}

function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=300' },
  });
}
