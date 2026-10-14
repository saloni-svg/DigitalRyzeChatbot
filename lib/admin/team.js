// Team assignment and response times.
// GET  /api/admin/team                                   -> { members, settings, response, stats, me }
// POST { action: "assign", session_id, user_id }          -> assign (or unassign with user_id "")
// POST { action: "auto_assign" }                          -> assign new unassigned leads (round robin or smart)
// POST { action: "save_settings", settings }              -> admins: auto-assign mode, who gets leads, response target
//
// Smart assignment is a multi-armed bandit (Thompson sampling): for every team member it keeps a Beta
// distribution of their win rate for this kind of lead (intent from the Conversation Analyst, Claude Haiku),
// learned from Won/Lost outcomes. It samples from each and picks the best, minus a workload penalty, so it
// favours whoever wins this type of lead while still giving everyone a fair share and learning as it goes.
import { supa, enc } from "../db.js";
import { requireAuth } from "../auth.js";

const DAY = 86400000, MIN = 60000;
const DEFAULTS = { auto_assign: "off", members: [], sla_minutes: 120, priority: [], escalate: true, live_seconds: 45, max_handovers: 2 };
const ONLINE_MS = 90 * 1000;   // "available" = had the dashboard open in the last 90 seconds
const RESPONDED_STAGES = ["contacted", "meeting", "proposal", "won", "lost"];
const clean = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

function norm(v) {
  const s = { ...DEFAULTS, ...(v || {}) };
  s.auto_assign = ["off", "round_robin", "smart", "priority"].includes(s.auto_assign) ? s.auto_assign : "off";
  s.priority = Array.isArray(s.priority) ? s.priority.map(String).slice(0, 50) : [];
  s.escalate = s.escalate !== false;
  s.live_seconds = Math.min(600, Math.max(15, parseInt(s.live_seconds, 10) || 45));
  s.max_handovers = Math.min(5, Math.max(0, parseInt(s.max_handovers ?? 2, 10)));
  s.members = Array.isArray(s.members) ? s.members.map(String).slice(0, 50) : [];
  s.sla_minutes = Math.min(7 * 24 * 60, Math.max(5, parseInt(s.sla_minutes, 10) || 120));
  return s;
}
async function loadSettings(db) {
  const row = ((await db.get("app_settings?select=value&key=eq.team").catch(() => [])) || [])[0];
  return norm(row && row.value);
}
const nameOf = u => [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || "Team member";

// ---- Beta sampling for Thompson sampling (Marsaglia–Tsang gamma) ----
function gauss() { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function gamma(k) {
  if (k < 1) return gamma(k + 1) * Math.pow(Math.random(), 1 / k);
  const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x, v;
    do { x = gauss(); v = 1 + c * x; } while (v <= 0);
    v = v * v * v; const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
const betaSample = (a, b) => { const x = gamma(a), y = gamma(b); return x / (x + y); };

// Everything needed for response times, stats and assignment, in one pass.
async function snapshot(db) {
  const since = new Date(Date.now() - 90 * DAY).toISOString();
  const [members, chats, leads, outcomes, fus, live, analyses] = await Promise.all([
    db.get("admin_users?select=id,first_name,last_name,email,role,last_seen_at&order=created_at.asc")
      .catch(() => db.get("admin_users?select=id,first_name,last_name,email,role&order=created_at.asc")).catch(() => []),
    db.get(`chats?select=session_id,updated_at,handoff_at,handoff_status,assigned_to,assigned_name,assigned_at,assigned_reason,reassign_count,assign_log&updated_at=gte.${enc(since)}&limit=2000`)
      .catch(() => db.get(`chats?select=session_id,updated_at,handoff_at,handoff_status,assigned_to,assigned_name,assigned_at,assigned_reason&updated_at=gte.${enc(since)}&limit=2000`)),
    db.get(`leads?select=session_id,created_at,name,email,phone&created_at=gte.${enc(since)}&limit=3000`).catch(() => []),
    db.get("lead_outcomes?select=session_id,stage,history,updated_at&limit=5000").catch(() => []),
    db.get(`followups?select=session_id,sent_at&status=eq.sent&sent_at=gte.${enc(since)}&limit=5000`).catch(() => []),
    db.get(`live_messages?select=session_id,role,content,created_at&role=in.(agent,system)&created_at=gte.${enc(since)}&order=id.asc&limit=10000`).catch(() => []),
    db.get("chat_analysis?select=session_id,intent,service&limit=5000").catch(() => [])
  ]);
  const by = (rows, f) => { const m = {}; (rows || []).forEach(r => { (m[r.session_id] = m[r.session_id] || []).push(f ? f(r) : r); }); return m; };
  return {
    members: members || [], chats: chats || [], leadsBy: by(leads), outcomeOf: Object.fromEntries((outcomes || []).map(o => [o.session_id, o])),
    fuBy: by(fus), liveBy: by(live), intentOf: Object.fromEntries((analyses || []).map(a => [a.session_id, a.intent || ""]))
  };
}

// When did this lead start waiting, and when did the team first respond?
function responseFor(c, snap, slaMin, now) {
  const leads = snap.leadsBy[c.session_id] || [];
  const leadAt = leads.reduce((t, l) => Math.min(t, new Date(l.created_at).getTime() || Infinity), Infinity);
  const handAt = c.handoff_at ? new Date(c.handoff_at).getTime() : Infinity;
  const start = Math.min(leadAt, handAt);
  if (!isFinite(start)) return null;                                  // not a lead and never asked for a person
  const cands = [];
  (snap.liveBy[c.session_id] || []).forEach(m => {
    const t = new Date(m.created_at).getTime();
    if (t >= start && (m.role === "agent" || /joined the chat/i.test(m.content || ""))) cands.push(t);
  });
  const o = snap.outcomeOf[c.session_id];
  ((o && o.history) || []).forEach(h => { const t = new Date(h.at).getTime(); if (RESPONDED_STAGES.includes(h.stage) && t >= start - MIN) cands.push(t); });
  (snap.fuBy[c.session_id] || []).forEach(f => { const t = new Date(f.sent_at).getTime(); if (t >= start) cands.push(t); });
  const first = cands.length ? Math.min(...cands) : null;
  const closed = o && ["won", "lost"].includes(o.stage);
  return {
    start: new Date(start).toISOString(),
    first_response_min: first != null ? Math.max(0, Math.round((first - start) / MIN)) : null,
    waiting_min: first == null && !closed ? Math.round((now - start) / MIN) : null,
    overdue: first == null && !closed && now - start > slaMin * MIN
  };
}

const median = xs => { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); };

function buildStats(snap, response, settings) {
  const per = {}, fast = { won: 0, lost: 0 }, slow = { won: 0, lost: 0 }, all = [];
  const ensure = (id, name) => (per[id] = per[id] || { user_id: id, name, assigned: 0, responded: 0, overdue: 0, open: 0, won: 0, lost: 0, times: [] });
  snap.members.forEach(m => ensure(String(m.id), nameOf(m)));
  for (const c of snap.chats) {
    const r = response[c.session_id];
    const o = snap.outcomeOf[c.session_id];
    if (r && r.first_response_min != null) {
      all.push(r.first_response_min);
      if (o && (o.stage === "won" || o.stage === "lost")) (r.first_response_min <= settings.sla_minutes ? fast : slow)[o.stage]++;
    }
    if (!c.assigned_to) continue;
    const s = ensure(String(c.assigned_to), c.assigned_name || "Team member");
    s.assigned++;
    if (r && r.first_response_min != null) { s.responded++; s.times.push(r.first_response_min); }
    if (r && r.overdue) s.overdue++;
    if (o && o.stage === "won") s.won++; else if (o && o.stage === "lost") s.lost++; else s.open++;
  }
  const rate = x => x.won + x.lost ? Math.round(x.won / (x.won + x.lost) * 100) : null;
  return {
    members: Object.values(per).map(s => ({ ...s, median_response_min: median(s.times), win_rate: rate(s), times: undefined })),
    overall: { median_response_min: median(all), responded: all.length, within_target: all.filter(t => t <= settings.sla_minutes).length,
      win_rate_fast: rate(fast), win_rate_slow: rate(slow), fast_decided: fast.won + fast.lost, slow_decided: slow.won + slow.lost }
  };
}

// Pick an owner for one lead.
// Team members in the admin's priority order (anyone not ranked comes after, in the order they were added).
function byPriority(pool, settings) {
  const rank = id => { const i = settings.priority.indexOf(String(id)); return i === -1 ? 1e6 : i; };
  return pool.slice().sort((a, b) => rank(a.id) - rank(b.id));
}
const isOnline = m => m.last_seen_at && Date.now() - new Date(m.last_seen_at).getTime() < ONLINE_MS;

function chooseOwner(c, snap, settings, pool, openCount, recentCount, exclude = [], preferOnline = false) {
  pool = pool.filter(m => !exclude.includes(String(m.id)));
  if (preferOnline === "only") pool = pool.filter(isOnline);              // live handovers: only people who can answer now
  else if (preferOnline) { const on = pool.filter(isOnline); if (on.length) pool = on; }
  if (!pool.length) return null;
  if (settings.auto_assign === "priority" || (settings.auto_assign === "off" && settings.priority.length)) {
    const m = byPriority(pool, settings)[0];
    return { member: m, reason: `Priority order: ${nameOf(m).split(" ")[0]} is next in line` };
  }
  if (settings.auto_assign === "round_robin" || settings.auto_assign === "off" || !snap.chats) {
    const m = pool.slice().sort((a, b) => (recentCount[a.id] || 0) - (recentCount[b.id] || 0))[0];
    return { member: m, reason: "Auto-assigned (taking turns)" };
  }
  // Smart: Thompson sampling on each member's win rate for this intent (with their overall record as a weaker prior).
  const intent = snap.intentOf[c.session_id] || "";
  let best = null;
  for (const m of pool) {
    let wI = 0, lI = 0, wA = 0, lA = 0;
    for (const x of snap.chats) {
      if (String(x.assigned_to) !== String(m.id)) continue;
      const o = snap.outcomeOf[x.session_id]; if (!o || (o.stage !== "won" && o.stage !== "lost")) continue;
      const win = o.stage === "won";
      if (win) wA++; else lA++;
      if (intent && snap.intentOf[x.session_id] === intent) { if (win) wI++; else lI++; }
    }
    const a = 1 + wI + 0.5 * wA, b = 1 + lI + 0.5 * lA;
    const score = betaSample(a, b) - 0.04 * (openCount[m.id] || 0);       // fair share: busier people are less likely
    if (!best || score > best.score) best = { member: m, score, wI, lI, wA, lA };
  }
  const n = best.wI + best.lI;
  const first = nameOf(best.member).split(" ")[0];
  const reason = n && best.wI / n >= 0.5 ? `Smart: ${first} won ${best.wI} of ${n} ${intent || "similar"} leads`
    : n ? `Smart: fair share for ${first} (the model keeps learning)`
    : best.wA + best.lA ? `Smart: ${first} won ${best.wA} of ${best.wA + best.lA} leads overall`
    : "Smart: still learning, shared fairly";
  return { member: best.member, reason };
}

async function writeAssign(db, c, member, reason, handover) {
  const now = new Date().toISOString();
  const log = (Array.isArray(c.assign_log) ? c.assign_log : []).concat([{ to: String(member.id), name: nameOf(member), at: now, reason }]).slice(-20);
  const fields = { assigned_to: String(member.id), assigned_name: nameOf(member), assigned_at: now, assigned_reason: reason };
  const extra = { assign_log: log, reassign_count: (c.reassign_count || 0) + (handover ? 1 : 0) };
  // Only change it if nobody else changed it in the meantime.
  const guard = c.assigned_to ? `assigned_to=eq.${enc(c.assigned_to)}` : "assigned_to=is.null";
  const rows = await db.patch("chats", `session_id=eq.${enc(c.session_id)}&${guard}`, { ...fields, ...extra })
    .catch(() => db.patch("chats", `session_id=eq.${enc(c.session_id)}&${guard}`, fields));   // before team-handover.sql
  if (rows && rows.length) Object.assign(c, fields, extra);
  return !!(rows && rows.length);
}
const triedBy = c => (Array.isArray(c.assign_log) ? c.assign_log.map(x => String(x.to)) : []).concat(c.assigned_to ? [String(c.assigned_to)] : []);

// Live chat requests: assign right away, and pass to the next person if nobody accepts within live_seconds.
// Called from the live chat poll (every few seconds), so it must stay light.
export async function routeLiveRequests(db) {
  const settings = await loadSettings(db);
  if (settings.auto_assign === "off" && !settings.priority.length && !settings.escalate) return;
  const since = new Date(Date.now() - 10 * MIN).toISOString();
  const [pending, members, recent] = await Promise.all([
    db.get(`chats?select=session_id,handoff_at,assigned_to,assigned_name,assigned_at,assigned_reason,reassign_count,assign_log&handoff_status=eq.requested&handoff_at=gt.${enc(since)}`)
      .catch(() => db.get(`chats?select=session_id,handoff_at,assigned_to,assigned_name,assigned_at,assigned_reason&handoff_status=eq.requested&handoff_at=gt.${enc(since)}`)),
    db.get("admin_users?select=id,first_name,last_name,email,role,last_seen_at").catch(() => db.get("admin_users?select=id,first_name,last_name,email,role")),
    db.get(`chats?select=assigned_to&assigned_at=gte.${enc(new Date(Date.now() - DAY).toISOString())}&limit=1000`).catch(() => [])
  ]);
  if (!(pending || []).length || !(members || []).length) return;
  const pool = members.filter(m => !settings.members.length || settings.members.includes(String(m.id)));
  const recentCount = {}; (recent || []).forEach(r => { if (r.assigned_to) recentCount[r.assigned_to] = (recentCount[r.assigned_to] || 0) + 1; });
  const snapLite = { chats: null };
  for (const c of pending) {
    if (!c.assigned_to) {
      if (settings.auto_assign === "off" && !settings.priority.length) continue;
      const pick = chooseOwner(c, snapLite, settings, pool, {}, recentCount, [], true);
      if (pick) await writeAssign(db, c, pick.member, "Live chat: " + pick.reason.replace(/^Priority order: |^Auto-assigned /, ""), false);
      continue;
    }
    if (!settings.escalate) continue;
    const waited = Date.now() - new Date(c.assigned_at || c.handoff_at).getTime();
    if (waited < settings.live_seconds * 1000 || (c.reassign_count || 0) >= settings.max_handovers) continue;
    const pick = chooseOwner(c, snapLite, settings, pool, {}, recentCount, triedBy(c), "only");
    if (!pick) continue;                                                   // nobody else online: it stays where it is
    const prev = String(c.assigned_name || "The owner").split(" ")[0];
    await writeAssign(db, c, pick.member, `Passed to ${nameOf(pick.member).split(" ")[0]}: ${prev} didn't answer within ${settings.live_seconds} s`, true);
  }
}

// New leads: pass to the next person if the owner hasn't responded within the reply target.
async function escalateLeads(db, snap, settings, pool, openCount, recentCount) {
  if (!settings.escalate) return 0;
  const now = Date.now(); let moved = 0;
  for (const c of snap.chats) {
    if (!c.assigned_to || !c.assigned_at || c.handoff_status === "requested") continue;
    const o = snap.outcomeOf[c.session_id];
    if (o && ["won", "lost"].includes(o.stage)) continue;
    if (!(snap.leadsBy[c.session_id] || []).length) continue;
    const since = new Date(c.assigned_at).getTime();
    if (now - since < settings.sla_minutes * MIN) continue;
    if (firstResponseAfter(c, snap, since) != null) continue;          // they did respond
    if ((c.reassign_count || 0) >= settings.max_handovers) {
      if (!/^Needs attention/.test(c.assigned_reason || "")) {
        await db.patch("chats", `session_id=eq.${enc(c.session_id)}`, { assigned_reason: `Needs attention: no reply after ${c.reassign_count || 0} handover${c.reassign_count === 1 ? "" : "s"}` }).catch(() => {});
      }
      continue;
    }
    const pick = chooseOwner(c, snap, settings, pool, openCount, recentCount, triedBy(c), false);
    if (!pick) continue;
    const prev = String(c.assigned_name || "The owner").split(" ")[0];
    const hrs = settings.sla_minutes >= 60 ? Math.round(settings.sla_minutes / 6) / 10 + " h" : settings.sla_minutes + " min";
    if (await writeAssign(db, c, pick.member, `Passed to ${nameOf(pick.member).split(" ")[0]}: ${prev} didn't reply within ${hrs}`, true)) {
      openCount[pick.member.id] = (openCount[pick.member.id] || 0) + 1; moved++;
    }
  }
  return moved;
}

function firstResponseAfter(c, snap, since) {
  const cands = [];
  (snap.liveBy[c.session_id] || []).forEach(m => { const t = new Date(m.created_at).getTime(); if (t >= since && (m.role === "agent" || /joined the chat/i.test(m.content || ""))) cands.push(t); });
  const o = snap.outcomeOf[c.session_id];
  ((o && o.history) || []).forEach(h => { const t = new Date(h.at).getTime(); if (RESPONDED_STAGES.includes(h.stage) && t >= since) cands.push(t); });
  (snap.fuBy[c.session_id] || []).forEach(f => { const t = new Date(f.sent_at).getTime(); if (t >= since) cands.push(t); });
  return cands.length ? Math.min(...cands) : null;
}

export default async function handler(req, res) {
  const me = await requireAuth(req, res);
  if (!me) return;
  res.setHeader("Cache-Control", "no-store");
  const db = supa();
  if (!db) return res.status(500).json({ error: "Database not configured" });
  const isAdmin = !!(me.owner || me.role === "admin");

  try {
    const settings = await loadSettings(db);
    if (req.method === "GET") {
      const snap = await snapshot(db), now = Date.now(), response = {};
      for (const c of snap.chats) { const r = responseFor(c, snap, settings.sla_minutes, now); if (r) response[c.session_id] = r; }
      return res.status(200).json({
        members: snap.members.map(m => ({ id: String(m.id), name: nameOf(m), role: m.role, online: !!isOnline(m) })),
        settings, response, stats: buildStats(snap, response, settings),
        me: { id: me.owner ? "owner" : String(me.id), is_admin: isAdmin }
      });
    }
    if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
    const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
    const by = [me.first_name, me.last_name].filter(Boolean).join(" ") || me.email || "Team";
    const now = new Date().toISOString();

    if (b.action === "assign") {
      const session = clean(b.session_id, 64), uid = clean(b.user_id, 64);
      if (!session) return res.status(400).json({ error: "Missing chat." });
      const myId = me.owner ? "owner" : String(me.id);
      if (!isAdmin && uid && uid !== myId) return res.status(403).json({ error: "You can assign chats to yourself. Ask an admin to assign them to someone else." });
      let name = null;
      if (uid) {
        const u = ((await db.get(`admin_users?select=id,first_name,last_name,email&id=eq.${enc(uid)}`).catch(() => [])) || [])[0];
        if (!u && uid !== "owner") return res.status(404).json({ error: "Team member not found." });
        name = u ? nameOf(u) : "Main Admin";
      }
      const reason = uid === myId ? "Assigned to themselves" : `Assigned by ${by}`;
      const cur = ((await db.get(`chats?select=assign_log&session_id=eq.${enc(session)}`).catch(() => [])) || [])[0] || {};
      const log = (Array.isArray(cur.assign_log) ? cur.assign_log : []).concat(uid ? [{ to: uid, name, at: now, reason }] : []).slice(-20);
      const fields = uid ? { assigned_to: uid, assigned_name: name, assigned_at: now, assigned_reason: reason }
                         : { assigned_to: null, assigned_name: null, assigned_at: null, assigned_reason: null };
      await db.patch("chats", `session_id=eq.${enc(session)}`, { ...fields, assign_log: log, reassign_count: 0 })   // a person chose: handovers start again
        .catch(() => db.patch("chats", `session_id=eq.${enc(session)}`, fields));
      return res.status(200).json({ ok: true, assigned_to: uid || null, assigned_name: name });
    }

    if (b.action === "save_settings") {
      if (!isAdmin) return res.status(403).json({ error: "Only admins can change team settings." });
      const s = norm(b.settings);
      await db.upsert("app_settings", { key: "team", value: s, updated_at: now }, "key");
      return res.status(200).json({ ok: true, settings: s });
    }

    // Give past leads an owner from their history: whoever first accepted the live chat,
    // changed the outcome or sent a follow-up. Only fills leads that have no owner yet.
    if (b.action === "backfill") {
      if (!isAdmin) return res.status(403).json({ error: "Only admins can do this." });
      const [members, chats, leads, outcomes, fus, live] = await Promise.all([
        db.get("admin_users?select=id,first_name,last_name,email").catch(() => []),
        db.get("chats?select=session_id,agent_name,handoff_at,assigned_to,assign_log&assigned_to=is.null&limit=3000")
          .catch(() => db.get("chats?select=session_id,agent_name,handoff_at,assigned_to&assigned_to=is.null&limit=3000")),
        db.get("leads?select=session_id&limit=5000").catch(() => []),
        db.get("lead_outcomes?select=session_id,history,updated_by&limit=5000").catch(() => []),
        db.get("followups?select=session_id,sent_by,sent_at&status=eq.sent&limit=5000").catch(() => []),
        db.get("live_messages?select=session_id,content,created_at&role=eq.system&limit=10000").catch(() => [])
      ]);
      // Match a recorded name ("Zafar", "Zafar Shaikh", "Main Admin", "Marked as replied by …") to a team member.
      const norm = t => String(t || "").toLowerCase().replace(/\s+/g, " ").trim();
      const findMember = raw => {
        const t = norm(raw).replace(/^(marked as replied by|replied by|assigned by)\s+/, "");
        if (!t || t === "digitalryze team" || t === "digitalryze") return null;
        return (members || []).find(m => norm(nameOf(m)) === t) ||
               (members || []).find(m => norm(m.first_name) && t.split(" ")[0] === norm(m.first_name)) ||
               (members || []).find(m => m.email && norm(m.email) === t) || null;
      };
      const hasLead = new Set((leads || []).map(l => l.session_id));
      const events = {};          // session -> [{ at, who, how }]
      const add = (sid, at, who, how) => { if (sid && who) (events[sid] = events[sid] || []).push({ at: new Date(at || 0).getTime(), who, how }); };
      (live || []).forEach(m => { const x = /^(.+?) from DigitalR[yY][zZ][eE] (has )?joined the chat/.exec(m.content || ""); if (x) add(m.session_id, m.created_at, x[1], "accepted the live chat"); });
      (chats || []).forEach(c => { if (c.agent_name) add(c.session_id, c.handoff_at, c.agent_name, "accepted the live chat"); });
      (outcomes || []).forEach(o => {
        (o.history || []).forEach(h => { if (h.by && h.stage && h.stage !== "new") add(o.session_id, h.at, h.by, `set the outcome to ${h.stage}`); });
        if (o.updated_by && !(o.history || []).length) add(o.session_id, 0, o.updated_by, "updated the outcome");
      });
      (fus || []).forEach(f => add(f.session_id, f.sent_at, f.sent_by, "sent a follow-up"));

      let filled = 0, unmatched = 0;
      for (const c of chats || []) {
        if (!hasLead.has(c.session_id) && !c.handoff_at) continue;
        const ev = (events[c.session_id] || []).sort((a, b) => a.at - b.at);
        const hit = ev.map(e => ({ e, m: findMember(e.who) })).find(x => x.m);
        if (!hit) { if (ev.length) unmatched++; continue; }
        const at = hit.e.at ? new Date(hit.e.at).toISOString() : now;
        const reason = `From past activity: ${nameOf(hit.m).split(" ")[0]} ${hit.e.how}`;
        const fields = { assigned_to: String(hit.m.id), assigned_name: nameOf(hit.m), assigned_at: at, assigned_reason: reason };
        const ok = await db.patch("chats", `session_id=eq.${enc(c.session_id)}&assigned_to=is.null`,
          { ...fields, assign_log: [{ to: String(hit.m.id), name: nameOf(hit.m), at, reason }] })
          .catch(() => db.patch("chats", `session_id=eq.${enc(c.session_id)}&assigned_to=is.null`, fields));
        if (ok && ok.length) filled++;
      }
      return res.status(200).json({ ok: true, filled, unmatched });
    }

    if (b.action === "auto_assign") {
      await routeLiveRequests(db).catch(err => console.error("Live routing failed", err));
      if (settings.auto_assign === "off" && !settings.escalate) return res.status(200).json({ ok: true, assigned: 0, mode: "off" });
      const snap = await snapshot(db);
      const pool = snap.members.filter(m => !settings.members.length || settings.members.includes(String(m.id)));
      const openCount = {}, recentCount = {};
      const weekAgo = Date.now() - 7 * DAY;
      for (const c of snap.chats) {
        if (!c.assigned_to) continue;
        const o = snap.outcomeOf[c.session_id];
        if (!o || (o.stage !== "won" && o.stage !== "lost")) openCount[c.assigned_to] = (openCount[c.assigned_to] || 0) + 1;
        if (new Date(c.assigned_at || 0).getTime() > weekAgo) recentCount[c.assigned_to] = (recentCount[c.assigned_to] || 0) + 1;
      }
      // New leads and people who asked for a human in the last 14 days, not yet assigned or decided.
      const fresh = Date.now() - 14 * DAY;
      const todo = snap.chats.filter(c => !c.assigned_to && new Date(c.updated_at).getTime() > fresh &&
        ((snap.leadsBy[c.session_id] || []).length || c.handoff_status === "requested" || c.handoff_status === "accepted") &&
        !(snap.outcomeOf[c.session_id] && ["won", "lost"].includes(snap.outcomeOf[c.session_id].stage)));
      let assigned = 0;
      const handedOver = await escalateLeads(db, snap, settings, pool, openCount, recentCount);
      if (settings.auto_assign === "off") return res.status(200).json({ ok: true, assigned: 0, handed_over: handedOver, mode: "off" });
      for (const c of todo.slice(0, 40)) {
        const pick = chooseOwner(c, snap, settings, pool, openCount, recentCount);
        if (!pick) break;
        if (!(await writeAssign(db, c, pick.member, pick.reason, false))) continue;
        openCount[pick.member.id] = (openCount[pick.member.id] || 0) + 1;
        recentCount[pick.member.id] = (recentCount[pick.member.id] || 0) + 1;
        assigned++;
      }
      return res.status(200).json({ ok: true, assigned: assigned + handedOver, handed_over: handedOver, mode: settings.auto_assign });
    }
    return res.status(400).json({ error: "Unknown action" });
  } catch (err) {
    console.error("Team error", err);
    const msg = String((err && err.message) || err);
    if (/assigned_to|assigned_name|assigned_at|assigned_reason|app_settings|reassign_count|assign_log|last_seen_at/i.test(msg)) {
      return res.status(500).json({ error: "Team assignment needs a database update. Run team-setup.sql and team-handover.sql in the Supabase SQL Editor." });
    }
    return res.status(500).json({ error: "Team error: " + msg.replace(/\s+/g, " ").slice(0, 300) });
  }
}
