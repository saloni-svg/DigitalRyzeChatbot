// Calendly bookings for the dashboard Calendar page.
// GET /api/admin/calendar?from=ISO&to=ISO&email=someone@email.com
//   Reads the meetings booked through your Calendly link with the Calendly API (CALENDLY_TOKEN on Vercel).
//   email: only bookings made with this email. Empty = every booking.
import { requireAuth } from "../auth.js";

const API = "https://api.calendly.com";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DAY = 86400000;
let account = null;   // { uri, org, name }, cached while the server is warm

async function calendly(url, token) {
  const r = await fetch(url.startsWith("http") ? url : API + url, { headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error((d && (d.message || d.title)) || `Calendly returned ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return d;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });
  const me = await requireAuth(req, res);
  if (!me) return;
  if (!me.owner && me.can_calendar === false) return res.status(403).json({ error: "Calendar access is turned off for your account. Ask an admin to turn it on." });
  const token = String(process.env.CALENDLY_TOKEN || "").trim();
  if (!token) return res.status(500).json({ error: "Calendly is not connected yet: add CALENDLY_TOKEN on Vercel, then run vercel --prod." });

  const q = req.query || {};
  const email = String(q.email || q.visitor || "").trim().toLowerCase().slice(0, 200);
  if (email && !EMAIL.test(email)) return res.status(400).json({ error: "Please enter a valid email address." });
  let from = new Date(q.from), to = new Date(q.to);
  if (isNaN(from) || isNaN(to) || to <= from) { from = new Date(Date.now() - 7 * DAY); to = new Date(Date.now() + 35 * DAY); }
  if (to - from > 100 * DAY) to = new Date(+from + 100 * DAY);

  try {
    if (!account) {
      const u = (await calendly("/users/me", token)).resource || {};
      account = { uri: u.uri, org: u.current_organization, name: u.name || u.email || "", email: u.email || "",
        link: String(u.scheduling_url || "").replace(/^https?:\/\//, "") };
    }
    const params = new URLSearchParams({
      min_start_time: from.toISOString(), max_start_time: to.toISOString(),
      status: "active", count: "100", sort: "start_time:asc"
    });
    if (email) params.set("invitee_email", email);

    // Whole organisation (every team member's link) when allowed, otherwise just this account.
    let list = [], scope = "";
    const scopes = account.org ? [["organization", account.org], ["user", account.uri]] : [["user", account.uri]];
    for (const [key, value] of scopes) {
      try {
        params.set(key, value); if (key === "user") params.delete("organization");
        let page = await calendly("/scheduled_events?" + params.toString(), token);
        list = page.collection || [];
        for (let i = 0; i < 3 && page.pagination && page.pagination.next_page; i++) {
          page = await calendly(page.pagination.next_page, token);
          list = list.concat(page.collection || []);
        }
        scope = key;
        break;
      } catch (err) {
        if (key === "organization" && (err.status === 403 || err.status === 401)) continue;
        throw err;
      }
    }

    // Who booked each meeting (name and email of the invitee).
    const events = await Promise.all(list.slice(0, 120).map(async ev => {
      let invitees = [];
      try {
        const inv = await calendly(ev.uri + "/invitees?count=10&status=active", token);
        invitees = (inv.collection || []).map(i => ({ name: i.name || "", email: String(i.email || "").toLowerCase() }));
      } catch (err) { console.error("Calendly invitees failed", err.message); }
      const loc = ev.location || {};
      return {
        id: ev.uri, title: ev.name || "Meeting", start: ev.start_time, end: ev.end_time, allDay: false, calendly: true,
        invitees, hosts: (ev.event_memberships || []).map(m => m.user_name || m.user_email).filter(Boolean),
        guests: invitees.map(i => i.email), join_url: loc.join_url || (/^https?:/.test(loc.location || "") ? loc.location : "")
      };
    }));
    return res.status(200).json({ events, calendar_name: account.name, account_email: account.email, account_link: account.link, scope, from: from.toISOString(), to: to.toISOString(), found: list.length });
  } catch (err) {
    console.error("Calendly read failed", err);
    if (err.status === 401) { account = null; return res.status(502).json({ error: "Calendly rejected the token. Create a new personal access token and update CALENDLY_TOKEN on Vercel." }); }
    return res.status(502).json({ error: "Could not load Calendly bookings: " + err.message });
  }
}
