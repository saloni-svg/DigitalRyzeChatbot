// Admin backend: returns saved conversations from Supabase.
// GET /api/admin/chats   header: x-admin-key: <ADMIN_PASSWORD>


import { requireAuth } from "../auth.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed" });

  const me = await requireAuth(req, res);
  if (!me) return;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return res.status(500).json({ error: "Supabase keys are not set on Vercel." });

  const limit = Math.min(parseInt(req.query.limit, 10) || 1000, 2000);
  const headers = { apikey: key, Prefer: "count=exact" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;

  const base = url.replace(/\/$/, "");
  try {
    const [r, rl, ra, rx, ro] = await Promise.all([
      fetch(`${base}/rest/v1/chats?select=*&order=updated_at.desc&limit=${limit}`, { headers }),
      fetch(`${base}/rest/v1/leads?select=*&order=created_at.desc&limit=${limit}`, { headers }),
      fetch(`${base}/rest/v1/chat_analysis?select=*&limit=5000`, { headers }),
      fetch(`${base}/rest/v1/lead_actions?select=*&limit=5000`, { headers }),
      fetch(`${base}/rest/v1/lead_outcomes?select=*&limit=5000`, { headers })
    ]);
    if (!r.ok) {
      console.error("Supabase read failed", r.status, await r.text());
      return res.status(502).json({ error: "Could not read chats from Supabase." });
    }
    const chats = await r.json();
    let leads = [];
    if (rl.ok) leads = await rl.json();
    else console.error("Leads read failed (has the leads table been created?)", rl.status, await rl.text());
    const range = r.headers.get("content-range") || "";
    const total = parseInt(range.split("/")[1], 10) || chats.length;
    const analyses = ra.ok ? await ra.json() : [];
    const actions = rx.ok ? await rx.json() : [];
    const outcomes = ro.ok ? await ro.json() : [];
    return res.status(200).json({ chats, leads, analyses, actions, outcomes, total });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error." });
  }
}
