/* ============================================================
   functions/api/marketing.js — sync marketing consent to MailerLite
   ------------------------------------------------------------
   POST /api/marketing  { optIn: true|false }  (called by auth.js after the
   consent checkbox writes to Supabase). Verifies the user, then upserts them
   in MailerLite as subscribed / unsubscribed. Supabase remains the record of
   consent; MailerLite is the send list.

   Env: SUPABASE_URL, SUPABASE_ANON_KEY, MAILERLITE_API_KEY (secret),
        MAILERLITE_GROUP_ID (optional — add opt-ins to a specific group)
   ============================================================ */

export async function onRequestPost({ request, env }) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  let user;
  try {
    const who = await fetch(env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: env.SUPABASE_ANON_KEY },
    });
    if (!who.ok) return json({ error: 'forbidden' }, 403);
    user = await who.json();
  } catch (_) {
    return json({ error: 'auth_unavailable' }, 503);
  }
  if (!user.email) return json({ error: 'no_email' }, 400);

  let optIn = true;
  try { const b = await request.json(); optIn = !(b && b.optIn === false); } catch (_) {}

  if (!env.MAILERLITE_API_KEY) return json({ ok: true, skipped: 'no_key' }, 200);

  const body = { email: user.email, status: optIn ? 'active' : 'unsubscribed' };
  if (env.MAILERLITE_GROUP_ID) body.groups = [env.MAILERLITE_GROUP_ID];

  try {
    const r = await fetch('https://connect.mailerlite.com/api/subscribers', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.MAILERLITE_API_KEY,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      return json({ error: 'mailerlite_error', status: r.status, detail: (await r.text()).slice(0, 300) }, 502);
    }
  } catch (e) {
    return json({ error: 'mailerlite_unavailable', detail: String(e && e.message || e) }, 502);
  }
  return json({ ok: true }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
