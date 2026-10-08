/* ============================================================
   functions/api/lp.js — ad-landing TOTALS, and the "heard" click (2026-10-08)
   ------------------------------------------------------------
   POST /api/lp  { src: 'reddit'|'google'|'youtube', ev: 'land'|'page'|'topic'|'heard',
                   gclid?, rdt_cid? }      (sent by attrib.js §6 for visitors who arrived from an ad)

   1. TOTALS. Bumps ONE per-day counter: ad_landing_counts(day, src, ev, n). No user id, no IP, no
      click id, no time finer than the day. Not personal data. ADS_Q4_2026.md §4.
   2. THE HEARD CLICK. On `heard` only, if the URL carried a gclid / rdt_cid, it is held in
      ad_heard_clicks (click id + time, nothing else) so the daily uploaders can tell Google / Reddit
      "this click led to a sentence being played" — the third conversion, for visitors with no
      account. A click id IS personal data (UK GDPR Recital 26), held on legitimate interests
      (DATA_PROTECTION.md, LIA C as amended 2026-10-08):
        ⚠ NEVER for UK/EEA/CH — the SAME Set /api/attrib uses, imported, so the two cannot drift.
          An unknown country fails CLOSED.
        ⚠ NEVER MORE THAN 7 DAYS — every write prunes older rows; the uploaders delete on send and
          prune again. privacy.html promises both.
      Nothing is read from or written to the device for any of this (attrib.js reads the URL), so
      PECR reg 6 is not engaged.

   ⚠ Anyone can POST here; the worst case is inflated totals or junk click ids that Google / Reddit
   simply fail to match. Fields are whitelisted and length-capped.
   ⚠ Fails silently from the caller's side, like /api/attrib — a measurement must never be noticed.
   Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY. Tables + function: supabase_ad_landing_counts.sql
   ============================================================ */
import { CONSENT_REQUIRED_COUNTRIES } from './attrib.js';

const SRC = new Set(['reddit', 'google', 'youtube']);
const EV = new Set(['land', 'page', 'topic', 'heard']);
const HOLD_DAYS = 7;
const CLICK_RE = /^[A-Za-z0-9_\-.]{8,512}$/;

export async function onRequestPost({ request, env }) {
  let body = {};
  try { body = (await request.json()) || {}; } catch (_) {}
  const src = String(body.src || '').toLowerCase();
  const ev = String(body.ev || '').toLowerCase();
  if (!SRC.has(src) || !EV.has(ev)) return json({ error: 'bad_request' }, 400);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ ok: true, skipped: 'no_key' }, 200);

  const sb = (path, init) => fetch(env.SUPABASE_URL + path, Object.assign({
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: 'Bearer ' + env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
  }, init));

  try {
    const r = await sb('/rest/v1/rpc/bump_ad_landing', {
      method: 'POST', body: JSON.stringify({ p_src: src, p_ev: ev }),
    });
    if (!r.ok) return json({ error: 'db_error', status: r.status }, 502);
  } catch (_) {
    return json({ error: 'db_unavailable' }, 502);
  }

  if (ev === 'heard') {
    const cf = request.cf || {};
    const country = cf.country ? String(cf.country).toUpperCase() : null;
    const row = {};
    for (const f of ['gclid', 'rdt_cid']) {
      const v = typeof body[f] === 'string' ? body[f].trim() : '';
      if (CLICK_RE.test(v)) row[f] = v;
    }
    if (Object.keys(row).length && country && !CONSENT_REQUIRED_COUNTRIES.has(country)) {
      try {
        await sb('/rest/v1/ad_heard_clicks', { method: 'POST', body: JSON.stringify(row) });
      } catch (_) {}
    }
    /* The 7-day ceiling, enforced on every heard write whatever happened above. */
    try {
      const cutoff = new Date(Date.now() - HOLD_DAYS * 86400000).toISOString();
      await sb('/rest/v1/ad_heard_clicks?heard_at=lt.' + encodeURIComponent(cutoff), { method: 'DELETE' });
    } catch (_) {}
  }
  return json({ ok: true }, 200);
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
