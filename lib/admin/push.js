// Computer alerts (Web Push) for live chat requests.
// GET    /api/admin/push            -> { publicKey }
// POST   /api/admin/push { subscription }   save this browser
// DELETE /api/admin/push { endpoint }       stop alerts on this browser
import { supa, enc } from "../db.js";
import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    return res.status(200).json({ publicKey: process.env.VAPID_PUBLIC_KEY || "" });
  }
  const me = await requireAuth(req, res);
  if (!me) return;
  const db = supa();
  if (!db) return res.status(500).json({ error: "Database not configured" });
  const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

  try {
    if (req.method === "POST") {
      const sub = b.subscription || {};
      if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return res.status(400).json({ error: "Invalid subscription" });
      await db.upsert("push_subscriptions", { endpoint: sub.endpoint, keys: sub.keys, user_email: me.email }, "endpoint");
      return res.status(200).json({ ok: true });
    }
    if (req.method === "DELETE") {
      if (!b.endpoint) return res.status(400).json({ error: "Missing endpoint" });
      await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/push_subscriptions?endpoint=eq.${enc(b.endpoint)}`, {
        method: "DELETE",
        headers: { apikey: process.env.SUPABASE_SERVICE_KEY, ...(process.env.SUPABASE_SERVICE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } : {}) }
      });
      return res.status(200).json({ ok: true });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not save alert settings (has push_subscriptions been created?)" });
  }
}
