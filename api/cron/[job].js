// One serverless function for all scheduled jobs.
import analyze from "../../lib/cron/analyze.js";
import insights from "../../lib/cron/insights.js";

const jobs = { analyze, insights };

export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  const fn = jobs[String((req.query && req.query.job) || "")];
  if (!fn) return res.status(404).json({ error: "Not found" });
  return fn(req, res);
}
