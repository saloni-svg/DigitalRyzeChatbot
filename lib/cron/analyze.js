// Daily backup run of the Conversation Analyst (Vercel Cron). Protected by CRON_SECRET.
import { runPending } from "../analyst.js";

export default async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: "Unauthorized" });
  const started = Date.now();
  let analyzed = 0, pending = 0;
  try {
    do {
      const out = await runPending({ limit: 4 });
      analyzed += out.analyzed; pending = out.pending;
      if (!out.analyzed) break;
    } while (pending > 0 && Date.now() - started < 45000);
    return res.status(200).json({ analyzed, pending });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Analyst run failed", analyzed });
  }
}
