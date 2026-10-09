// Step 6 API. GET -> active model + metrics. POST { action: "train" } -> retrain (admins only).
import { requireAuth } from "../auth.js";
import { trainModel, activeModel, MIN_TOTAL, MIN_EACH, RELIABLE } from "../ml.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const me = await requireAuth(req, res, { admin: req.method === "POST" });
  if (!me) return;
  try {
    if (req.method === "GET") {
      const m = await activeModel();
      return res.status(200).json({ model: m ? m.model : null, metrics: m ? m.metrics : null, created_at: m ? m.created_at : null, trained_by: m ? m.trained_by : null, rules: { MIN_TOTAL, MIN_EACH, RELIABLE } });
    }
    if (req.method === "POST") {
      const out = await trainModel(`${me.first_name || ""} ${me.last_name || ""}`.trim() || me.email);
      return res.status(200).json(out);
    }
    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Could not train the model. Has the ml_models table been created?" });
  }
}
