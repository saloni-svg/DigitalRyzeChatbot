// Next best action tracking: mark a lead's action as done (or undo).
// POST /api/admin/actions { key, session_id, action, done: true | false }
import { supa, enc } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const me = await requireAuth(req, res);
  if (!me) return;
  const db = supa();
  if (!db) return res.status(500).json({ error: "Database not configured" });
  const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
  const key = String(b.key || "").slice(0, 100);
  if (!key) return res.status(400).json({ error: "Missing key" });
  try {
    if (b.done) {
      const row = { key, session_id: String(b.session_id || key.split("#")[0]).slice(0, 64), action: String(b.action || "").slice(0, 40),
        done_by: `${me.first_name || ""} ${me.last_name || ""}`.trim() || me.email, done_at: new Date().toISOString() };
      await db.upsert("lead_actions", row, "key");
      return res.status(200).json({ action: row });
    }
    await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/lead_actions?key=eq.${enc(key)}`, {
      method: "DELETE",
      headers: { apikey: process.env.SUPABASE_SERVICE_KEY, ...(process.env.SUPABASE_SERVICE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } : {}) }
    });
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not save. Has the lead_actions table been created?" });
  }
}
