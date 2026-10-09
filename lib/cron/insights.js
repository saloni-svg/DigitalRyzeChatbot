// Weekly insights email (Vercel Cron, Mondays). Protected by CRON_SECRET.
import { supa } from "../db.js";
import { buildReport } from "../insights.js";
import { trainModel } from "../ml.js";

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Unauthorized" });
  try {
    const to = new Date(); to.setUTCHours(0, 0, 0, 0);
    const from = new Date(to.getTime() - 7 * 86400000);
    const db = supa();
    const an = (await db.get(`chat_analysis?select=intent,strength,service&analyzed_at=gte.${from.toISOString()}`).catch(() => [])) || [];
    const count = (arr, k) => arr.reduce((m, x) => { const v = x[k] || "Not stated"; m[v] = (m[v] || 0) + 1; return m; }, {});
    const stats = { chats_analysed: an.length, strong_or_ready: an.filter(a => a.strength >= 3).length, intents: count(an, "intent"), services: count(an, "service") };
    const r = await buildReport({ from: from.toISOString(), to: to.toISOString(), stats });

    const section = (title, list) => list && list.length
      ? `${title}\n` + list.slice(0, 5).map((c, i) => `  ${i + 1}. ${c.name} (${c.chats} chat${c.chats === 1 ? "" : "s"})`).join("\n") + "\n" : "";
    const body = [
      `DigitalRyze chatbot: weekly insights (${r.from.slice(0, 10)} to ${r.to.slice(0, 10)})`, "",
      `Chats analysed: ${stats.chats_analysed}. Strong buying intent or ready to talk: ${stats.strong_or_ready}.`, "",
      r.summary || "Not enough conversations this week for a summary.", "",
      r.recommendations.length ? "Recommendations:\n" + r.recommendations.map(x => `  - ${x}`).join("\n") + "\n" : "",
      section("Top questions:", r.clusters.question),
      section("Top objections:", r.clusters.objection),
      section("Buying signals:", r.clusters.buying_signal),
      section("Questions the bot could not answer well:", r.clusters.gap),
      `Full insights: ${(process.env.DASHBOARD_URL || "https://digitalryze-chatbot.vercel.app/admin/")}`
    ].join("\n");
    if (process.env.LEAD_WEBHOOK_URL) {
      await fetch(process.env.LEAD_WEBHOOK_URL, {
        method: "POST", headers: { "Content-Type": "application/json" }, redirect: "follow",
        body: JSON.stringify({ secret: process.env.LEAD_WEBHOOK_SECRET || "", type: "alert", subject: "Weekly chatbot insights", body })
      });
    }
    let ml = null;
    try { ml = await trainModel("weekly job"); } catch (err) { console.error("Weekly retrain failed", err); }
    return res.status(200).json({ ok: true, items: r.items, ml_trained: !!(ml && ml.trained) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Weekly insights failed" });
  }
}
