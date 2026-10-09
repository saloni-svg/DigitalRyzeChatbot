// The DigitalRyze bot: Claude + tools (save a lead, ask for a person), shared by the website chat and WhatsApp.
// respond() runs one visitor turn and saves the conversation. The website (api/chat.js) and
// WhatsApp (api/whatsapp.js) each handle their own delivery around it.
import { SYSTEM_PROMPT } from "./prompt.js";
import { notifyHandoff } from "./db.js";

const HANDOFF_RULES = `

LIVE HANDOFF (request_human tool)

When the visitor asks to talk to a human, a person, a real agent, Zafar or the team right now, call the request_human tool. Do not make contact details a condition, but if the visitor has already shared them and no lead is saved yet, call save_lead first.
After calling it, tell the visitor in one or two sentences that you are checking whether a team member is available and that they should stay on this chat for a minute or two. Do not promise that someone will join.
Call request_human only once per request. If the team was unavailable earlier in the chat, only call it again if the visitor asks again.`;

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const TOOLS = [
  {
    name: "save_lead",
    description:
      "Save a website visitor as a lead for the DigitalRyze team. Call once you have their name, at least one of email or phone, and their main requirement.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        business: { type: "string", description: "Business or agency name" },
        website: { type: "string" },
        location: { type: "string", description: "City or country" },
        service: { type: "string", description: "Service they are interested in" },
        requirement: { type: "string", description: "Their main goal or problem, in one or two sentences" },
        budget: { type: "string", description: "Monthly ad budget if mentioned" },
        visitor_type: { type: "string", enum: ["business", "agency", "affiliate", "other"] },
        wants_human: { type: "boolean" },
        notes: { type: "string" }
      },
      required: ["name", "requirement"]
    }
  },
  {
    name: "request_human",
    description: "Alert the DigitalRyze team that this visitor wants to chat with a real person now.",
    input_schema: {
      type: "object",
      properties: {
        reason: { type: "string", description: "What the visitor wants to talk about, in one sentence" },
        name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" }
      },
      required: ["reason"]
    }
  }
];

// Claude only accepts role + content, and needs user/assistant turns to alternate.
function forClaude(messages) {
  const out = [];
  for (const m of messages) {
    if (typeof m.content !== "string") { out.push(m); continue; }
    const last = out[out.length - 1];
    if (last && last.role === m.role && typeof last.content === "string") last.content += "\n\n" + m.content;
    else out.push({ role: m.role, content: m.content });
  }
  return out;
}

async function callClaude(messages, system) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID.trim() } : {})
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 700, system, tools: TOOLS, messages: forClaude(messages) })
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
  return r.json();
}

async function saveLead(lead, meta) {
  const url = process.env.LEAD_WEBHOOK_URL;
  if (!url) { console.warn("LEAD_WEBHOOK_URL not set, lead not saved", lead); return false; }
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    redirect: "follow",
    body: JSON.stringify({ secret: process.env.LEAD_WEBHOOK_SECRET || "", ...lead, ...meta })
  });
  const text = await r.text();
  return r.ok && text.trim() === "ok";
}

// ---------- Chat log storage (Supabase) ----------
async function logChat({ sessionId, messages, page, leadSaved, lead, handoff }) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !sessionId) return;
  const headers = {
    "Content-Type": "application/json",
    apikey: key,
    Prefer: "resolution=merge-duplicates,return=minimal"
  };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`; // legacy service_role key
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/chats?on_conflict=session_id`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      session_id: sessionId,
      messages,
      message_count: messages.length,
      page,
      lead_saved: leadSaved,
      updated_at: new Date().toISOString(),
      ...(handoff ? { handoff_status: "requested", handoff_at: new Date().toISOString(), agent_name: null } : {}),
      ...(lead ? {
        lead_name: lead.name || null,
        lead_email: lead.email || null,
        lead_phone: lead.phone || null,
        lead_business: lead.business || null,
        lead_requirement: lead.requirement || null
      } : {})
    })
  });
  if (!r.ok) console.error("Chat log failed", r.status, await r.text());
}

// ---------- One row per lead (Supabase) ----------
async function saveLeadRow(lead, meta) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key || !meta.sessionId) return false;
  const headers = { "Content-Type": "application/json", apikey: key, Prefer: "return=minimal" };
  if (key.startsWith("eyJ")) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(`${url.replace(/\/$/, "")}/rest/v1/leads`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      session_id: meta.sessionId,
      name: lead.name || null,
      email: lead.email || null,
      phone: lead.phone || null,
      business: lead.business || null,
      website: lead.website || null,
      location: lead.location || null,
      service: lead.service || null,
      requirement: lead.requirement || null,
      budget: lead.budget || null,
      visitor_type: lead.visitor_type || null,
      page: meta.page || null
    })
  });
  if (!r.ok) { console.error("Lead row failed", r.status, await r.text()); return false; }
  return true;
}

// ---------- GoHighLevel contact ----------
async function saveToGHL(lead, meta) {
  const token = process.env.GHL_API_KEY;
  const locationId = process.env.GHL_LOCATION_ID;
  if (!token || !locationId) return false;
  if (!lead.email && !lead.phone) return false;
  const headers = {
    Authorization: `Bearer ${token}`,
    Version: "2021-07-28",
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  const parts = String(lead.name || "").trim().split(/\s+/);
  const tags = ["website-chatbot"];
  if (lead.visitor_type) tags.push(`chatbot-${lead.visitor_type}`);
  if (lead.wants_human) tags.push("chatbot-wants-human");

  const r = await fetch("https://services.leadconnectorhq.com/contacts/upsert", {
    method: "POST",
    headers,
    body: JSON.stringify({
      locationId,
      firstName: parts[0] || "",
      lastName: parts.slice(1).join(" "),
      name: lead.name || "",
      email: lead.email || undefined,
      phone: lead.phone || undefined,
      companyName: lead.business || undefined,
      website: lead.website || undefined,
      source: "DigitalRyze website chatbot",
      tags
    })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { console.error("GHL upsert failed", r.status, JSON.stringify(data)); return false; }

  const contactId = data?.contact?.id || data?.id;
  if (contactId) {
    const note = [
      "Lead from DigitalRyze website chatbot",
      `Service: ${lead.service || ""}`,
      `Requirement: ${lead.requirement || ""}`,
      `Budget: ${lead.budget || ""}`,
      `Location: ${lead.location || ""}`,
      `Wants a human: ${lead.wants_human ? "Yes" : "No"}`,
      `Notes: ${lead.notes || ""}`,
      `Page: ${meta.page || ""}`,
      "",
      "Conversation:",
      meta.transcript || ""
    ].join("\n").slice(0, 10000);
    const n = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/notes`, {
      method: "POST", headers, body: JSON.stringify({ body: note })
    });
    if (!n.ok) console.error("GHL note failed", n.status, await n.text());
  }
  return true;
}


const WHATSAPP_RULES = `

WHATSAPP CHANNEL

This conversation is on WhatsApp, not the website. Keep replies short (2 to 5 short lines). Plain text only: no markdown headings, no tables. You may use *single asterisks* for bold sparingly. Write links as plain URLs.
You already have the visitor's WhatsApp number, so never ask for their phone number. When you call save_lead you can leave phone empty; it is filled in automatically.
If they want a person, the team replies here on WhatsApp, usually within business hours. Do not ask them to stay on a website chat.`;

// One visitor turn. messages: [{ role: "user" | "assistant", content, ts? }] ending with the visitor's message.
// Returns { reply, leadSaved, handoff }. Throws if Claude cannot be reached.
export async function respond({ messages, sessionId, page, leadSaved: alreadySaved, host, channel = "web", contact = {} }) {
  const whatsapp = channel === "whatsapp";
  let leadSaved = Boolean(alreadySaved);
  let capturedLead = null;
  const notes = [];
  if (leadSaved) notes.push("CONVERSATION NOTE: A lead has already been saved for this visitor.");
  if (whatsapp) notes.push(`VISITOR: WhatsApp number ${contact.phone || "unknown"}` + (contact.name ? `, WhatsApp profile name "${contact.name}" (confirm before using it as their real name).` : "."));
  const system = SYSTEM_PROMPT + HANDOFF_RULES + (whatsapp ? WHATSAPP_RULES : "") + (notes.length ? "\n\n" + notes.join("\n") : "");
  let handoff = false;
  const transcriptOf = () => messages.map(m => `${m.role === "user" ? "Visitor" : "Bot"}: ${m.content}`).join("\n");

  let convo = messages;
  let data = await callClaude(convo, system);

  // Keep text from every step. Claude often writes its reply BEFORE calling a tool,
  // then returns nothing after the tool result, so only reading the last step loses it.
  const texts = [];
  const collect = d => (d.content || []).forEach(b => { if (b.type === "text" && b.text.trim()) texts.push(b.text.trim()); });
  collect(data);

  // Handle up to three rounds of tool use.
  for (let round = 0; round < 3 && data.stop_reason === "tool_use"; round++) {
    const results = [];
    for (const block of data.content) {
      if (block.type !== "tool_use") continue;
      let ok = false;
      if (block.name === "save_lead") {
        const lead = { ...(block.input || {}) };
        if (whatsapp && !lead.phone && contact.phone) lead.phone = contact.phone;
        capturedLead = lead;
        const meta = { sessionId, page, transcript: transcriptOf().slice(0, 8000) };
        const saves = await Promise.allSettled([saveLead(lead, meta), saveToGHL(lead, meta), saveLeadRow(lead, meta)]);
        saves.forEach(r => { if (r.status === "rejected") console.error(r.reason); });
        ok = saves.some(r => r.status === "fulfilled" && r.value === true);
        if (ok) leadSaved = true;
      }
      if (block.name === "request_human") {
        handoff = true;
        const i = block.input || {};
        const who = capturedLead || {};
        await notifyHandoff({
          name: i.name || who.name || contact.name || "",
          email: i.email || who.email || "",
          phone: i.phone || who.phone || contact.phone || "",
          reason: (whatsapp ? "[WhatsApp] " : "") + (i.reason || ""),
          page,
          transcript: transcriptOf().slice(-4000),
          dashboard: `https://${host}/admin/`
        }).catch(err => console.error(err));
        results.push({ type: "tool_result", tool_use_id: block.id, content: whatsapp
          ? "The team has been alerted. Tell the visitor a team member will reply here on WhatsApp shortly (usually within business hours)."
          : "The team has been alerted. Tell the visitor you are checking who is available and to stay on this chat for a minute or two." });
        continue;
      }
      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        content: ok ? "Lead saved." : "Saving failed. Ask the visitor to call +91 760 044 3625 or use the booking link."
      });
    }
    convo = [...convo, { role: "assistant", content: data.content }, { role: "user", content: results }];
    data = await callClaude(convo, system);
    collect(data);
  }

  const reply = texts.join("\n\n").trim() || (leadSaved
    ? "Thanks, I've passed your details to our team. A DigitalRyze strategist will reply within one business day. You can also book a call here: https://calendly.com/digitalryze/virtual-coffee-with-digitalryze-team"
    : "Sorry, I didn't catch that. Could you rephrase?");

  await logChat({
    sessionId, page, leadSaved, lead: capturedLead, handoff,
    messages: [...messages, { role: "assistant", content: reply, ts: Date.now() }]
  }).catch(err => console.error("Chat log error", err));

  return { reply, leadSaved, handoff };
}
