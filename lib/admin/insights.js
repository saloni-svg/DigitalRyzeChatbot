// Conversation intelligence report.
// GET  /api/admin/insights?from=...&to=...   -> saved report for that period (if any)
// POST /api/admin/insights { from, to, stats } -> build a fresh report (embeddings + clustering + Claude Sonnet)
import { supa, enc } from "../db.js";
import { requireAuth } from "../auth.js";
import { buildReport } from "../insights.js";

export const config = { maxDuration: 60 };

function period(q) {
  const to = q.to && !isNaN(Date.parse(q.to)) ? new Date(q.to) : new Date();
  const from = q.from && !isNaN(Date.parse(q.from)) ? new Date(q.from) : new Date(Date.now() - 30 * 86400000);
  return { from: from.toISOString(), to: to.toISOString() };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const me = await requireAuth(req, res);
  if (!me) return;
  try {
    if (req.method === "GET") {
      const { from, to } = period(req.query || {});
      const db = supa();
      const rows = (await db.get(`insights_reports?select=report&key=eq.${enc(`${from.slice(0, 10)}_${to.slice(0, 10)}`)}`).catch(() => [])) || [];
      return res.status(200).json({ report: rows[0] ? rows[0].report : null });
    }
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const { from, to } = period(b);
      const report = await buildReport({ from, to, stats: b.stats || {} });
      return res.status(200).json({ report });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not build insights. Have the Step 4 tables been created in Supabase?" });
  }
}
