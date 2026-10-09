// Shared helpers: Supabase access, CORS and admin alerts.

export function supa() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  const base = url.replace(/\/$/, "") + "/rest/v1";
  const h = (extra = {}) => {
    const x = { apikey: key, "Content-Type": "application/json", ...extra };
    if (key.startsWith("eyJ")) x.Authorization = `Bearer ${key}`;
    return x;
  };
  async function check(r) {
    if (!r.ok) throw new Error(`Supabase ${r.status}: ${await r.text()}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  return {
    get: path => fetch(`${base}/${path}`, { headers: h() }).then(check),
    insert: (table, row) =>
      fetch(`${base}/${table}`, { method: "POST", headers: h({ Prefer: "return=representation" }), body: JSON.stringify(row) })
        .then(check).then(rows => (rows || [])[0]),
    upsert: (table, row, onConflict) =>
      fetch(`${base}/${table}?on_conflict=${onConflict}`, {
        method: "POST", headers: h({ Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify(row)
      }).then(check),
    patch: (table, filter, fields) =>
      fetch(`${base}/${table}?${filter}`, { method: "PATCH", headers: h({ Prefer: "return=representation" }), body: JSON.stringify(fields) })
        .then(check)
  };
}

export const enc = encodeURIComponent;

export function cors(req, res, methods) {
  const allowed = (process.env.ALLOWED_ORIGINS || "https://digitalryze.com,https://www.digitalryze.com")
    .split(",").map(s => s.trim());
  if (req.headers.host) allowed.push(`https://${req.headers.host}`);
  const origin = req.headers.origin || "";
  const ok = !origin || allowed.includes(origin) || allowed.includes("*");
  if (origin && ok) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", methods);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return ok;
}

// Email (through the Google Apps Script) and optional SMS (Twilio) when a visitor wants a human.
export async function notifyHandoff(info) {
  const jobs = [];
  if (process.env.LEAD_WEBHOOK_URL) {
    jobs.push(fetch(process.env.LEAD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      redirect: "follow",
      body: JSON.stringify({ secret: process.env.LEAD_WEBHOOK_SECRET || "", type: "handoff", ...info })
    }));
  }
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: tok, TWILIO_FROM: from, ADMIN_PHONE: to } = process.env;
  if (sid && tok && from && to) {
    const body = `DigitalRyze: ${info.name || "A website visitor"} wants to talk to a person now. Open ${info.dashboard}`;
    jobs.push(fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(`${sid}:${tok}`).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({ From: from, To: to, Body: body.slice(0, 300) })
    }));
  }
  jobs.push(pushToComputers(info));
  const results = await Promise.allSettled(jobs);
  results.forEach(r => { if (r.status === "rejected") console.error("Handoff alert failed", r.reason); });
}

// Hot lead: email (through the Apps Script) + computer pop-up.
export async function notifyHot(info) {
  const dashboard = (process.env.DASHBOARD_URL || "https://digitalryze-chatbot.vercel.app/admin/");
  const jobs = [];
  if (process.env.LEAD_WEBHOOK_URL) {
    jobs.push(fetch(process.env.LEAD_WEBHOOK_URL, {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "follow",
      body: JSON.stringify({
        secret: process.env.LEAD_WEBHOOK_SECRET || "", type: "alert",
        subject: `Hot lead (${info.score}/100): ${info.name}`,
        body: [
          `${info.name} scored ${info.score}/100 on the website chat.`,
          "",
          `Next best action: ${info.action}`,
          `Why: ${info.reason}`,
          "",
          `Need: ${info.need || ""}`, `Service: ${info.service || ""}`, `Budget: ${info.budget || ""}`,
          `Email: ${info.email || ""}`, `Phone: ${info.phone || ""}`,
          "", `Open the dashboard: ${dashboard}`, "", "Conversation:", info.transcript || ""
        ].join("\n")
      })
    }));
  }
  jobs.push(pushToComputers({ title: `\ud83d\udd25 Hot lead: ${info.name} (${info.score})`, body: `${info.action}. ${info.reason}`, dashboard, tag: "hot-lead" }));
  const results = await Promise.allSettled(jobs);
  results.forEach(r => { if (r.status === "rejected") console.error("Hot alert failed", r.reason); });
}

// Pop-up alerts on every computer where someone clicked "Enable computer alerts".
async function pushToComputers(info) {
  const { VAPID_PUBLIC_KEY: pub, VAPID_PRIVATE_KEY: priv } = process.env;
  const db = supa();
  if (!pub || !priv || !db) return;
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:admin@digitalryze.com", pub, priv);
  const subs = (await db.get("push_subscriptions?select=endpoint,keys").catch(() => [])) || [];
  const payload = JSON.stringify({
    title: info.title || "Live chat request",
    body: (info.title ? String(info.body || "") : `${info.name || "A website visitor"} wants to talk to a person now.${info.reason ? " " + info.reason : ""}`).slice(0, 180),
    url: info.dashboard || "/admin/",
    tag: info.tag || "live-chat"
  });
  await Promise.all(subs.map(s => webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, payload, { TTL: 300, urgency: "high" })
    .catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // This browser turned alerts off or the subscription expired: remove it.
        return fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/push_subscriptions?endpoint=eq.${enc(s.endpoint)}`, {
          method: "DELETE",
          headers: { apikey: process.env.SUPABASE_SERVICE_KEY, ...(process.env.SUPABASE_SERVICE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } : {}) }
        });
      }
      console.error("Push failed", err.statusCode, err.body);
    })));
}
