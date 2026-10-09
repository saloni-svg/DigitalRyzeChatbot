// Lead scoring settings (weights + qualification rules).
// GET  /api/admin/scoring          -> { config }   (everyone signed in)
// POST /api/admin/scoring { config } -> save       (admins only)
import { supa } from "../db.js";
import { requireAuth } from "../auth.js";

export const DEFAULT_CONFIG = {
  weights: { intent: 30, budget: 20, timeline: 15, business_fit: 15, service_fit: 10, engagement: 5, contact: 5 },
  rules: {
    min_score: 50,
    min_strength: 2,
    require_contact: true,
    exclude_intents: ["Job/career inquiry", "Spam", "Support request", "Existing client"]
  },
  actions: { call_min_score: 75, require_call_request: true, hot_alert_score: 75 }
};

function clean(c) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const w = (c && c.weights) || {};
  Object.keys(out.weights).forEach(k => {
    const v = Number(w[k]);
    if (Number.isFinite(v)) out.weights[k] = Math.max(0, Math.min(100, Math.round(v)));
  });
  const r = (c && c.rules) || {};
  if (Number.isFinite(Number(r.min_score))) out.rules.min_score = Math.max(0, Math.min(100, Math.round(Number(r.min_score))));
  if (Number.isFinite(Number(r.min_strength))) out.rules.min_strength = Math.max(0, Math.min(4, Math.round(Number(r.min_strength))));
  if (typeof r.require_contact === "boolean") out.rules.require_contact = r.require_contact;
  if (Array.isArray(r.exclude_intents)) out.rules.exclude_intents = r.exclude_intents.map(String).slice(0, 9);
  const a = (c && c.actions) || {};
  ["call_min_score", "hot_alert_score"].forEach(k => {
    if (Number.isFinite(Number(a[k]))) out.actions[k] = Math.max(0, Math.min(100, Math.round(Number(a[k]))));
  });
  if (typeof a.require_call_request === "boolean") out.actions.require_call_request = a.require_call_request;
  return out;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const me = await requireAuth(req, res, { admin: req.method === "POST" });
  if (!me) return;
  const db = supa();
  if (!db) return res.status(500).json({ error: "Database not configured" });
  try {
    if (req.method === "GET") {
      const rows = await db.get("scoring_config?select=config,updated_at,updated_by&id=eq.1").catch(() => []);
      const row = (rows || [])[0];
      return res.status(200).json({ config: clean(row && row.config), updated_at: row ? row.updated_at : null, updated_by: row ? row.updated_by : null, defaults: DEFAULT_CONFIG });
    }
    if (req.method === "POST") {
      const b = typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});
      const config = clean(b.config);
      if (!Object.values(config.weights).some(v => v > 0)) return res.status(400).json({ error: "At least one weight must be above 0." });
      await db.upsert("scoring_config", { id: 1, config, updated_at: new Date().toISOString(), updated_by: me.email }, "id");
      return res.status(200).json({ config });
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not save scoring settings. Has the scoring_config table been created?" });
  }
}
