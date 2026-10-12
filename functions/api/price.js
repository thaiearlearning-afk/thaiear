/* ============================================================
   functions/api/price.js — the membership price in the visitor's currency, read from Stripe
   ------------------------------------------------------------
   GET /api/price → { amount, currency, interval, display }
   Public (the price is public). Lets the site show the real price without it
   being hardcoded, so changing the Stripe Price is the only edit needed.

   ⚠ MULTI-CURRENCY (2026-10-12, sw v808; CAD added the same evening). The Price carries
   currency_options — GBP (the default) plus USD EUR CAD AUD NZD SGD HKD THB — and Stripe
   Checkout charges the one for the buyer's country. This picks the same option from
   Cloudflare's country, so the subscribe page shows what checkout will charge; a country
   not listed below gets the default (GBP).
   The two are separate geolocations and can disagree at the margin (a VPN, travel), which is
   why terms.html still says "the price shown at checkout".
   ⚠ A currency added to the Price in Stripe needs its countries added to LOCAL/EURO here,
   or those visitors keep seeing £.
   ?cc=XX shows another country's price (for testing; every price here is public anyway).

   Env: STRIPE_SECRET_KEY, STRIPE_PRICE_ID
   ============================================================ */

const SYMBOLS = { GBP: '£', USD: '$', EUR: '€', CAD: 'CA$', AUD: 'A$', NZD: 'NZ$', SGD: 'S$', HKD: 'HK$', THB: '฿' };

// Country (ISO 3166, as Cloudflare reports it) → a currency the Price carries.
const LOCAL = { US: 'USD', PR: 'USD', CA: 'CAD', AU: 'AUD', NZ: 'NZD', SG: 'SGD', HK: 'HKD', TH: 'THB' };
// The euro area (Bulgaria joined 2026-01-01), then the states that use the euro by agreement.
const EURO = 'AT BE BG CY DE EE ES FI FR GR HR IE IT LT LU LV MT NL PT SI SK AD MC SM VA ME XK'.split(' ');

export async function onRequestGet({ request, env }) {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_PRICE_ID) return json({ error: 'config' });
  try {
    const r = await fetch('https://api.stripe.com/v1/prices/' + env.STRIPE_PRICE_ID + '?expand%5B%5D=currency_options', {
      headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
    });
    const p = await r.json();
    if (!r.ok || p.unit_amount == null) return json({ error: 'stripe' });
    let currency = (p.currency || 'gbp').toUpperCase();
    let unit = p.unit_amount;
    const cc = country(request);
    const want = EURO.includes(cc) ? 'EUR' : LOCAL[cc];
    const opt = want && p.currency_options && p.currency_options[want.toLowerCase()];
    if (opt && opt.unit_amount != null) { currency = want; unit = opt.unit_amount; }
    const amount = unit / 100;
    const interval = (p.recurring && p.recurring.interval) || 'month';
    const symbol = SYMBOLS[currency] || '';
    const num = Number.isInteger(amount) ? String(amount) : amount.toFixed(2);   // £6.99, but ฿299 and HK$69
    const display = symbol ? symbol + num : num + ' ' + currency;
    return json({ amount, currency, interval, display });
  } catch (_) {
    return json({ error: 'failed' });
  }
}

function country(request) {
  const c = (new URL(request.url).searchParams.get('cc') || (request.cf && request.cf.country) || '').toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : '';
}

// private: the answer depends on where the visitor is, so no shared cache may keep one copy for all.
function json(obj) {
  return new Response(JSON.stringify(obj), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, max-age=300' },
  });
}
