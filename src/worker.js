// FTM_rec – Family Tree Data API (Cloudflare Worker + D1)
// Editors share one family PIN (secret FTM_PIN). No user accounts.

const P_COLS = ['FID','Name','AlsoKnownAs','Gender','Type','Generation','FatherFID','MotherFID','Relation','BirthOrder','BirthYear','DeathYear','Status','Notes'];
const M_COLS = ['MID','PersonA','PersonB','MarriageNo','YearMarried','YearEnded','EndType','Concurrent','Notes'];
const FID_RE = /^[FS]\d{4}$/, MID_RE = /^M\d{4}$/;
const MAX_FAILS = 8, LOCK_MIN = 15;
const fails = new Map(); // per-isolate brute-force throttle (best effort)

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...SEC_HEADERS },
});
const err = (msg, status = 400) => json({ error: msg }, status);

async function sha(s) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))); }
async function pinOk(given, expected) {
  const a = await sha(String(given || '')), b = await sha(String(expected));
  if (typeof crypto.subtle.timingSafeEqual === 'function') return crypto.subtle.timingSafeEqual(a, b);
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0;
}

function clean(rec, cols) {
  const out = {};
  for (const c of cols) {
    let v = rec?.[c];
    v = v === undefined || v === null ? '' : String(v).trim();
    out[c] = v.slice(0, c === 'Notes' ? 1000 : 200);
  }
  return out;
}
const now = () => new Date().toISOString();
const editorOf = (req) => (req.headers.get('X-FTM-Editor') || 'unknown').trim().slice(0, 40) || 'unknown';

async function allData(env) {
  const [p, m] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM people ORDER BY FID'),
    env.DB.prepare('SELECT * FROM marriages ORDER BY MID'),
  ]);
  return { people: p.results, marriages: m.results };
}
async function nextId(env, table, key, prefix) {
  const r = await env.DB.prepare(`SELECT ${key} AS id FROM ${table} WHERE ${key} LIKE ? ORDER BY ${key} DESC LIMIT 1`).bind(prefix + '%').first();
  const n = r ? parseInt(r.id.slice(1), 10) : 0;
  return prefix + String(n + 1).padStart(4, '0');
}
function upsertStmt(env, table, cols, rec, editor) {
  const all = [...cols, 'UpdatedBy', 'UpdatedAt'];
  const vals = [...cols.map(c => rec[c]), editor, now()];
  const sets = all.slice(1).map(c => `${c}=excluded.${c}`).join(',');
  return env.DB.prepare(`INSERT INTO ${table} (${all.join(',')}) VALUES (${all.map(() => '?').join(',')}) ON CONFLICT(${cols[0]}) DO UPDATE SET ${sets}`).bind(...vals);
}
const log = (env, editor, action, record, detail = '') =>
  env.DB.prepare('INSERT INTO audit_log (at, editor, action, record, detail) VALUES (?,?,?,?,?)').bind(now(), editor, action, record, String(detail).slice(0, 300));

async function api(req, env, url) {
  if (!env.FTM_PIN) return err('Server PIN not set. Add the FTM_PIN secret in Cloudflare.', 503);
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  const f = fails.get(ip);
  if (f && f.n >= MAX_FAILS && Date.now() - f.t < LOCK_MIN * 60000) return err('Too many wrong PINs. Try again later.', 429);
  if (!(await pinOk(req.headers.get('X-FTM-PIN'), env.FTM_PIN))) {
    fails.set(ip, { n: (f?.n || 0) + 1, t: Date.now() });
    return err('Wrong PIN', 401);
  }
  fails.delete(ip);

  const editor = editorOf(req);
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const body = method === 'POST' ? await req.json().catch(() => null) : null;
  if (method === 'POST' && !body) return err('Invalid JSON');

  // ---- read ----
  if (method === 'GET' && path === '/api/data') return json(await allData(env));
  if (method === 'GET' && path === '/api/log') {
    const r = await env.DB.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 200').all();
    return json({ log: r.results });
  }

  // ---- people ----
  if (method === 'POST' && path === '/api/person') {
    const rec = clean(body.rec, P_COLS);
    if (!rec.Name) return err('Name is required');
    rec.Type = rec.Type === 'S' ? 'S' : 'F';
    for (const k of ['FatherFID', 'MotherFID']) if (rec[k] && !FID_RE.test(rec[k])) return err(`Bad ${k}`);
    if (rec.FID) {
      if (!FID_RE.test(rec.FID)) return err('Bad FID');
      const cur = await env.DB.prepare('SELECT UpdatedAt, UpdatedBy FROM people WHERE FID=?').bind(rec.FID).first();
      if (!cur) return err('Record no longer exists', 409);
      if (body.base && cur.UpdatedAt !== body.base)
        return json({ error: `${rec.FID} was changed by ${cur.UpdatedBy} while you were editing. Reloaded — please redo your change.`, data: await allData(env) }, 409);
      await env.DB.batch([upsertStmt(env, 'people', P_COLS, rec, editor), log(env, editor, 'edit person', rec.FID, rec.Name)]);
    } else {
      for (let i = 0; i < 5; i++) { // retry if two editors add at the same moment
        rec.FID = await nextId(env, 'people', 'FID', rec.Type);
        try {
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO people (${P_COLS.join(',')},UpdatedBy,UpdatedAt) VALUES (${P_COLS.map(() => '?').join(',')},?,?)`).bind(...P_COLS.map(c => rec[c]), editor, now()),
            log(env, editor, 'add person', rec.FID, rec.Name),
          ]);
          break;
        } catch (e) { if (i === 4) return err('Could not allocate FID, try again', 409); }
      }
    }
    return json({ ok: true, id: rec.FID, data: await allData(env) });
  }
  let m = path.match(/^\/api\/person\/([FS]\d{4})$/);
  if (method === 'DELETE' && m) {
    const fid = m[1];
    const p = await env.DB.prepare('SELECT Name FROM people WHERE FID=?').bind(fid).first();
    if (!p) return err('Not found', 404);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM people WHERE FID=?').bind(fid),
      env.DB.prepare("UPDATE people SET FatherFID='' WHERE FatherFID=?").bind(fid),
      env.DB.prepare("UPDATE people SET MotherFID='' WHERE MotherFID=?").bind(fid),
      env.DB.prepare('DELETE FROM marriages WHERE PersonA=? OR PersonB=?').bind(fid, fid),
      log(env, editor, 'delete person', fid, p.Name),
    ]);
    return json({ ok: true, data: await allData(env) });
  }

  // ---- marriages ----
  if (method === 'POST' && path === '/api/marriage') {
    const rec = clean(body.rec, M_COLS);
    if (!FID_RE.test(rec.PersonA) || !FID_RE.test(rec.PersonB) || rec.PersonA === rec.PersonB) return err('Choose two different people');
    rec.Concurrent = rec.Concurrent === 'Y' ? 'Y' : 'N';
    if (rec.MID) {
      if (!MID_RE.test(rec.MID)) return err('Bad MID');
      const cur = await env.DB.prepare('SELECT UpdatedAt, UpdatedBy FROM marriages WHERE MID=?').bind(rec.MID).first();
      if (!cur) return err('Record no longer exists', 409);
      if (body.base && cur.UpdatedAt !== body.base)
        return json({ error: `${rec.MID} was changed by ${cur.UpdatedBy} while you were editing. Reloaded — please redo your change.`, data: await allData(env) }, 409);
      await env.DB.batch([upsertStmt(env, 'marriages', M_COLS, rec, editor), log(env, editor, 'edit marriage', rec.MID, `${rec.PersonA}–${rec.PersonB}`)]);
    } else {
      for (let i = 0; i < 5; i++) {
        rec.MID = await nextId(env, 'marriages', 'MID', 'M');
        try {
          await env.DB.batch([
            env.DB.prepare(`INSERT INTO marriages (${M_COLS.join(',')},UpdatedBy,UpdatedAt) VALUES (${M_COLS.map(() => '?').join(',')},?,?)`).bind(...M_COLS.map(c => rec[c]), editor, now()),
            log(env, editor, 'add marriage', rec.MID, `${rec.PersonA}–${rec.PersonB}`),
          ]);
          break;
        } catch (e) { if (i === 4) return err('Could not allocate MID, try again', 409); }
      }
    }
    return json({ ok: true, id: rec.MID, data: await allData(env) });
  }
  m = path.match(/^\/api\/marriage\/(M\d{4})$/);
  if (method === 'DELETE' && m) {
    await env.DB.batch([env.DB.prepare('DELETE FROM marriages WHERE MID=?').bind(m[1]), log(env, editor, 'delete marriage', m[1])]);
    return json({ ok: true, data: await allData(env) });
  }

  // ---- bulk import / generation recalculation ----
  if (method === 'POST' && path === '/api/import') {
    const people = (Array.isArray(body.people) ? body.people : []).slice(0, 5000).map(r => clean(r, P_COLS)).filter(r => FID_RE.test(r.FID) && r.Name);
    const marr = (Array.isArray(body.marriages) ? body.marriages : []).slice(0, 5000).map(r => clean(r, M_COLS)).filter(r => MID_RE.test(r.MID) && FID_RE.test(r.PersonA) && FID_RE.test(r.PersonB));
    people.forEach(r => { r.Type = r.FID[0]; });
    const stmts = [...people.map(r => upsertStmt(env, 'people', P_COLS, r, editor)), ...marr.map(r => upsertStmt(env, 'marriages', M_COLS, r, editor))];
    for (let i = 0; i < stmts.length; i += 90) await env.DB.batch(stmts.slice(i, i + 90));
    await log(env, editor, body.reason || 'import', `${people.length}P/${marr.length}M`).run();
    return json({ ok: true, people: people.length, marriages: marr.length, data: await allData(env) });
  }

  return err('Not found', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === '/api/ping') return json({ ftm: 'online', pinSet: !!env.FTM_PIN });
    if (url.pathname.startsWith('/api/')) {
      try { return await api(req, env, url); }
      catch (e) { return err('Server error: ' + (e.message || e), 500); }
    }
    return env.ASSETS.fetch(req);
  },
};
