/* TEMPORARY debug endpoint — dumps how a customer's discount/coupon is shaped in Stripe so we can
   fix lifetime auto-detection precisely. Guarded by a secret key. DELETE after diagnosing.
   Usage:  /api/sub-debug?key=lt-debug-7q9x2k&email=THE_LIFETIME_EMAIL                                */
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (url.searchParams.get('key') !== 'lt-debug-7q9x2k') return new Response('nope', { status: 403 });
  const email = url.searchParams.get('email');
  if (!email) return new Response('?email= required', { status: 400 });

  const custs = await sg(env, 'customers?email=' + encodeURIComponent(email) + '&limit=1');
  const cust = custs && custs.data && custs.data[0];
  if (!cust) return json({ error: 'no Stripe customer for that email', raw: custs });

  const subsPlain = await sg(env, 'subscriptions?customer=' + cust.id + '&status=all&limit=3');
  const first = subsPlain && subsPlain.data && subsPlain.data[0];
  const subsExpanded = first
    ? await sg(env, 'subscriptions/' + first.id + '?expand[]=discounts')
    : null;

  // Resolve the coupon behind each discount so we can see duration / percent_off / amount_off.
  const coupons = [];
  const discs = (subsExpanded && Array.isArray(subsExpanded.discounts)) ? subsExpanded.discounts : [];
  for (const d of discs) {
    let id = null;
    if (d && d.source && typeof d.source.coupon === 'string') id = d.source.coupon;
    else if (d && d.coupon && typeof d.coupon === 'object') id = d.coupon.id;
    else if (d && typeof d.coupon === 'string') id = d.coupon;
    if (id) { const c = await sg(env, 'coupons/' + id);
      coupons.push({ id, duration: c && c.duration, percent_off: c && c.percent_off, amount_off: c && c.amount_off, valid: c && c.valid }); }
  }

  const out = {
    customer_id: cust.id,
    customer_discounts: cust.discounts || null,
    sub_id: first && first.id,
    sub_status: first && first.status,
    sub_plan_amount: planAmountOf(first),
    sub_discounts_expanded: subsExpanded && subsExpanded.discounts || null,
    resolved_coupons: coupons,
    expand_error: subsExpanded && subsExpanded.error || null,
  };
  return json(out);
}

function planAmountOf(sub) {
  const item = sub && sub.items && sub.items.data && sub.items.data[0];
  return item && item.price && typeof item.price.unit_amount === 'number' ? item.price.unit_amount : null;
}

async function sg(env, path) {
  const r = await fetch('https://api.stripe.com/v1/' + path, {
    headers: { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY },
  });
  return r.json();
}

function json(obj) {
  return new Response(JSON.stringify(obj, null, 2), {
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
