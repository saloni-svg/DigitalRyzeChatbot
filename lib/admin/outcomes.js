// Step 5: record what actually happened to a lead (contacted, meeting, proposal, won, lost).
// POST /api/admin/outcomes { key, session_id, stage, lost_reason?, deal_value?, currency?, note?, features?,
//                            meeting_at?, meeting_minutes?, meeting_invite?, meeting_lead? }
// For stage "meeting", meeting_at (ISO date and time) is required. The meeting is then added to (or moved in)
// Google Calendar through the Google Apps Script web app (LEAD_WEBHOOK_URL).
import { supa, enc } from "../db.js";
import { requireAuth } from "../auth.js";

const STAGES = ["new", "contacted", "meeting", "proposal", "won", "lost"];
const LOST_REASONS = ["Price", "Chose a competitor", "No response", "Not a fit", "Bad timing", "Other"];
const DURATIONS = [15, 30, 45, 60, 90, 120];
const str = (v, n) => String(v == null ? "" : v).trim().slice(0, n);

// Create or move the Google Calendar event. Returns { ok, id } or { ok: false, error }.
async function syncCalendar({ eventId, start, minutes, lead, note, by, invite, dashboard }) {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) return { ok: false, error: "LEAD_WEBHOOK_URL is not set on Vercel." };
  // Trim so a stray space or line break pasted into Vercel can't break the match.
  const secret = String(process.env.LEAD_WEBHOOK_SECRET || "").trim();
  const end = new Date(new Date(start).getTime() + minutes * 60000).toISOString();
  const name = lead.name || "Website lead";
  const description = [
    "Strategy call booked from the DigitalRyze dashboard.",
    "",
    "Lead: " + name,
    lead.email ? "Email: " + lead.email : "",
    lead.phone ? "Phone: " + lead.phone : "",
    lead.business ? "Business: " + lead.business : "",
    lead.need ? "Needs: " + lead.need : "",
    note ? "Notes: " + note : "",
    "",
    "Booked by: " + by,
    "Open the chat: " + dashboard
  ].filter((x, i, a) => x !== "" || (a[i - 1] && a[i - 1] !== "")).join("\n");
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "follow",
      body: JSON.stringify({
        secret, type: "meeting",
        event_id: eventId || "", title: `DigitalRyze call: ${name}`, start, end, description,
        guest: invite && lead.email ? lead.email : ""
      })
    });
    const text = (await r.text()).trim();
    let d = null;
    try { d = JSON.parse(text); } catch { /* not JSON */ }
    if (d && d.ok && d.id) return { ok: true, id: d.id };
    if (/^forbidden/.test(text)) {
      // Lengths only (never the secret itself), so you can see which side is wrong.
      const theirs = (text.match(/expected (\d+)/) || [])[1];
      return { ok: false, error: `The secrets don't match. Vercel sent a ${secret.length}-character secret` +
        (theirs ? `, the Apps Script expects ${theirs} characters.` : `. (Update the Apps Script "forbidden" line to see its length too.)`) +
        (secret.length === 0 ? " LEAD_WEBHOOK_SECRET is empty: set it in Vercel and run vercel --prod." : "") };
    }
    if (text === "ok") return { ok: false, error: "The Apps Script has not been updated for Google Calendar yet." };
    return { ok: false, error: (d && d.error) || text.slice(0, 160) || `Apps Script returned ${r.status}` };
  } catch (err) {
    return { ok: false, error: "Could not reach the Apps Script: " + err.message };
  }
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const me = await requireAuth(req, res);
  if (!me) return;
  const db = supa();
  if (!db) return res.status(500).json({ error: "Database not configured" });
  const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const key = String(b.key || "").slice(0, 100);
  const stage = String(b.stage || "");
  if (!key || !STAGES.includes(stage)) return res.status(400).json({ error: "Missing lead or invalid stage." });
  const by = `${me.first_name || ""} ${me.last_name || ""}`.trim() || me.email;

  // Meeting date and time (sent by the browser as an exact moment, so time zones are handled).
  let meetingAt = null, minutes = 30;
  // Meetings are normally booked by the visitor through Calendly; a date here is optional.
  if (stage === "meeting" && b.meeting_at) {
    const at = new Date(b.meeting_at);
    if (isNaN(at)) return res.status(400).json({ error: "Please check the meeting date." });
    const yearMs = 365 * 86400000;
    if (Math.abs(at - Date.now()) > 2 * yearMs) return res.status(400).json({ error: "Please check the meeting date." });
    meetingAt = at.toISOString();
    minutes = DURATIONS.includes(Number(b.meeting_minutes)) ? Number(b.meeting_minutes) : 30;
  }

  try {
    const prev = ((await db.get(`lead_outcomes?select=*&key=eq.${enc(key)}`).catch(() => [])) || [])[0];
    const history = Array.isArray(prev && prev.history) ? prev.history : [];
    const moved = prev && prev.meeting_at && meetingAt && new Date(prev.meeting_at).getTime() !== new Date(meetingAt).getTime();
    if (!prev || prev.stage !== stage || moved) history.push({ stage, at: new Date().toISOString(), by, ...(meetingAt ? { meeting_at: meetingAt } : {}) });
    const value = Number(b.deal_value);
    const row = {
      key, session_id: String(b.session_id || key.split("#")[0]).slice(0, 64), stage,
      lost_reason: stage === "lost" ? (LOST_REASONS.includes(b.lost_reason) ? b.lost_reason : "Other") : null,
      deal_value: stage === "won" && Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : null,
      currency: stage === "won" ? String(b.currency || "INR").slice(0, 3).toUpperCase() : null,
      note: b.note ? String(b.note).slice(0, 1000) : null,
      // Snapshot of what was known about the lead when the outcome was recorded (training data for Step 6).
      features: b.features && typeof b.features === "object" ? b.features : (prev && prev.features) || null,
      history: history.slice(-30), updated_by: by, updated_at: new Date().toISOString(),
      // Meeting fields are only written for "meeting", so moving on to Proposal or Won keeps the meeting on record.
      ...(stage === "meeting" && meetingAt ? { meeting_at: meetingAt, meeting_minutes: minutes } : {})
    };
    try {
      await db.upsert("lead_outcomes", row, "key");
    } catch (err) {
      if (/meeting_at|meeting_minutes|calendar_event_id/.test(err.message)) {
        return res.status(500).json({ error: "Meeting dates need 3 new columns. Run calendar-setup.sql in the Supabase SQL Editor, then try again." });
      }
      throw err;
    }

    let calendar = null;
    if (stage === "meeting" && meetingAt) {
      const lead = b.meeting_lead && typeof b.meeting_lead === "object" ? b.meeting_lead : {};
      calendar = await syncCalendar({
        eventId: prev && prev.calendar_event_id,
        start: meetingAt, minutes,
        lead: { name: str(lead.name, 80), email: str(lead.email, 160), phone: str(lead.phone, 40), business: str(lead.business, 120), need: str(lead.need, 300) },
        note: row.note, by, invite: !!b.meeting_invite,
        dashboard: process.env.DASHBOARD_URL || `https://${req.headers.host}/admin/`
      });
      if (calendar.ok) {
        row.calendar_event_id = calendar.id;
        await db.patch("lead_outcomes", `key=eq.${enc(key)}`, { calendar_event_id: calendar.id })
          .catch(err => console.error("Saving calendar event id failed", err.message));
      } else {
        console.error("Google Calendar sync failed:", calendar.error);
      }
    }
    return res.status(200).json({ outcome: { ...(prev || {}), ...row }, calendar });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not save. Has the lead_outcomes table been created?" });
  }
}
