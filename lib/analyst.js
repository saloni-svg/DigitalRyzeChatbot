// Conversation Analyst: reads a chat and predicts the visitor's intent and how ready they are to buy.
import { supa, enc, notifyHot } from "./db.js";
import "../public/admin/scoring.js"; // shared scoring engine (sets globalThis.DRScore)
import { storeItems } from "./insights.js";

export const INTENTS = [
  "Information seeker", "Service inquiry", "Pricing inquiry", "Sales intent", "Support request",
  "Existing client", "Job/career inquiry", "Spam", "Other"
];
const MODEL = process.env.ANALYST_MODEL || "claude-haiku-4-5-20251001";
const RULES_VERSION = "v6"; // change this whenever the instructions change, so all chats get re-analysed
const MODEL_TAG = `${MODEL}#${RULES_VERSION}`;
const IDLE_MINUTES = 10;   // analyse a chat once it has been quiet this long
const LOOKBACK_DAYS = 60;  // only look at recent chats

// The AI answers yes/no evidence questions. Code turns the evidence into a strength score,
// so the same evidence always gives the same score.
const SYSTEM = `You analyse website chat conversations for DigitalRyze, a digital marketing agency (SEO, Google Ads, Meta Ads, web design, AI services, GoHighLevel automation, white label for agencies).

Judge only the VISITOR's own messages. Never assume anything they did not actually write.

STEP 1: INTENT (what the visitor mainly wanted)
- Information seeker: general knowledge or definitions, no sign of their own business need.
- Service inquiry: interested in DigitalRyze's services for themselves, or wants to talk to the team.
- Pricing inquiry: asks about cost, packages, fees or budget.
- Sales intent: a specific business need AND real buying signals (budget, timeline, asked for a call or proposal).
- Support request: needs help with a problem, not buying.
- Existing client: already works with DigitalRyze, asks about their account or project.
- Job/career inquiry: jobs, internships, hiring.
- Spam: irrelevant, abusive, gibberish, or selling something to DigitalRyze.
- Other: greetings only, introductions only, or nothing that fits.

STEP 2: EVIDENCE. Answer each question true or false, strictly from the visitor's words.
- vague_need: states a general goal with no specifics. Example: "I need more leads", "I want to grow my business".
- specific_need: names a concrete service or problem for their own business. Examples: "I need SEO for my e-commerce site", "our Google Ads cost per lead is too high", "I need a new website for my clinic". A greeting, a name, or "I want to talk to a human" is NOT a need.
- asked_price: asks about price, cost, packages or fees.
- business_details: describes their business: industry, what they sell, website, location, or current marketing. A company name on its own does NOT count.
- contact_shared: gives an email address or phone number.
- budget_or_spend: mentions a budget amount or how much they currently spend on marketing.
- timeline: mentions when they want to start or a deadline.
- asked_meeting: asks for a call, meeting, proposal, quote, or to get started.
- asked_human: asks to talk to a person, human, agent or the team.

STEP 3: need_summary: what they need in a few words, or "Not stated".

STEP 4: LEAD DETAILS (only from what the visitor wrote, otherwise use the "not stated" option)
- service: the main DigitalRyze service they want: SEO, Google Ads, Meta Ads, Social media, Web design, AI services, GoHighLevel automation, Branding, White label, Other, Not stated.
- budget_text: their budget or current spend in their own words (for example "1 lakh per month on Google Ads"), or "Not stated".
- budget_band: monthly marketing budget or spend. none = not stated. low = under about INR 50,000 or USD/CAD 1,000. medium = about INR 50,000 to 2,00,000 or USD/CAD 1,000 to 5,000. high = above that.
- timeline: none (not stated), later (more than 3 months away), within_90_days, within_30_days, immediately (now, this week, tomorrow, ASAP).
- business_type: their INDUSTRY in a few general words (for example "Dental clinic", "E-commerce clothing store", "Real estate agency"). Never use the company's own name. If they only gave a company name without saying what the business does, use "Not stated".
- business_fit: how well they fit DigitalRyze's clients. good = a real business or agency that needs marketing (local businesses, clinics, e-commerce, B2B, agencies). ok = a business but unclear fit. poor = student, job seeker, competitor selling to us, or no business. unknown = not enough information.
- company_size: unknown, solo, small (2 to 20 people), medium (21 to 200), large (over 200).
STEP 5: CONVERSATION INTELLIGENCE
Read carefully who said what. Lines starting with "Visitor:" are the visitor. Lines starting with "AI assistant:" or "Team member:" are DigitalRyze.

- questions: up to 5 questions that the VISITOR typed. Rewrite each as a short general question with no names, for example "How much does SEO cost?", "Do you work with dental clinics?".
  NEVER include questions the AI assistant asked the visitor (for example "What is your website?", "Are you running Google Ads now?", "What is your budget?"). If the visitor asked no questions, return an empty list.
  A request without a question mark still counts if the visitor is asking for information, for example "tell me about your SEO services" becomes "What SEO services do you offer?".

- objections: up to 4 concerns the VISITOR expressed, for example "Price is too high", "Already has an agency", "Needs to speak to partner", "Not ready yet", "Had a bad experience with agencies". Empty list if none.

- buying_signals: choose only from this exact list, only when the VISITOR clearly did it:
  "Asked for a call or meeting", "Asked to talk to a person", "Asked for a proposal or quote", "Asked about pricing", "Asked how soon they can start", "Shared a budget or ad spend", "Shared a timeline", "Agreed to book a meeting".
  Sharing an email or phone, saying hello, or naming a service is NOT a buying signal on its own.

- gaps: up to 3 questions the VISITOR asked that the AI assistant did NOT properly answer (it said it did not know, gave a vague reply, avoided the question, or only offered to connect them to the team). Write the visitor's question, for example "Exact cost of Meta Ads management".
  A gap is NEVER information the visitor did not give. If the assistant asked for the visitor's budget, website, business details or goals and the visitor did not reply, that is NOT a gap. If the visitor asked no unanswered questions, return an empty list.

- topics: up to 4 main subjects, for example "Google Ads", "SEO", "Pricing", "Web design", "Hiring".

STEP 6: confidence: 0 to 1 for how sure you are of the intent label. Below 0.6 if the chat is very short or vague. Do not repeat the same number for every chat.
STEP 7: reason: one plain sentence (no dashes) describing what the visitor actually said. Do not mention a score.

EXAMPLES
"What is SEO?" => Information seeker; all evidence false.
"I need more leads" (nothing else) => Service inquiry; vague_need true; everything else false.
"hello Rahul here" => Other; all evidence false.
"hello riya here from Riya industries, my email is riya@x.com" then "I want to talk to human" => Service inquiry; contact_shared true, asked_human true; specific_need false, business_details false.
"How much do you charge for SEO?" => Pricing inquiry; asked_price true.
"I run a dental clinic in Toronto and want more patients from Google" => Service inquiry; specific_need true, business_details true.
"We spend 1 lakh a month on Google Ads but sales are low. Email x@shop.com" => Sales intent; specific_need, business_details, budget_or_spend, contact_shared true.
"I need an SEO agency for my e-commerce site. Can someone call me tomorrow?" => Sales intent; specific_need, business_details, timeline, asked_meeting true.
"Are you hiring?" => Job/career inquiry; all evidence false.`;

const SERVICES = ["SEO", "Google Ads", "Meta Ads", "Social media", "Web design", "AI services", "GoHighLevel automation", "Branding", "White label", "Other", "Not stated"];
const BUYING_SIGNALS = ["Asked for a call or meeting", "Asked to talk to a person", "Asked for a proposal or quote", "Asked about pricing",
  "Asked how soon they can start", "Shared a budget or ad spend", "Shared a timeline", "Agreed to book a meeting"];
const SIGNALS = ["vague_need", "specific_need", "asked_price", "business_details", "contact_shared", "budget_or_spend", "timeline", "asked_meeting", "asked_human"];

const TOOL = {
  name: "record_analysis",
  description: "Record the intent and evidence for this conversation.",
  input_schema: {
    type: "object",
    properties: {
      intent: { type: "string", enum: INTENTS },
      signals: {
        type: "object",
        properties: Object.fromEntries(SIGNALS.map(k => [k, { type: "boolean" }])),
        required: SIGNALS
      },
      need_summary: { type: "string" },
      service: { type: "string", enum: SERVICES },
      budget_text: { type: "string" },
      budget_band: { type: "string", enum: ["none", "low", "medium", "high"] },
      timeline: { type: "string", enum: ["none", "later", "within_90_days", "within_30_days", "immediately"] },
      business_type: { type: "string" },
      business_fit: { type: "string", enum: ["unknown", "poor", "ok", "good"] },
      company_size: { type: "string", enum: ["unknown", "solo", "small", "medium", "large"] },
      questions: { type: "array", items: { type: "string" }, maxItems: 5 },
      objections: { type: "array", items: { type: "string" }, maxItems: 4 },
      buying_signals: { type: "array", items: { type: "string", enum: BUYING_SIGNALS }, maxItems: 4 },
      gaps: { type: "array", items: { type: "string" }, maxItems: 3 },
      topics: { type: "array", items: { type: "string" }, maxItems: 4 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string" }
    },
    required: ["intent", "signals", "need_summary", "service", "budget_text", "budget_band", "timeline", "business_type", "business_fit", "company_size", "questions", "objections", "buying_signals", "gaps", "topics", "confidence", "reason"]
  }
};

// Fixed rules: evidence -> strength (0 to 4), plus a plain explanation.
export function scoreStrength(intent, sig) {
  const s = sig || {};
  if (["Job/career inquiry", "Spam", "Support request", "Information seeker"].includes(intent) && !s.specific_need && !s.asked_price) {
    return { strength: 0, why: intent === "Information seeker" ? "Only asked general questions." : `${intent}, not a buying conversation.` };
  }
  if (intent === "Existing client" && !s.specific_need) return { strength: 0, why: "Existing client asking about their current work." };
  const need = s.specific_need || s.vague_need || s.asked_price;
  const engaged = need || s.asked_human || s.asked_meeting;
  if (s.asked_meeting && (s.specific_need || s.asked_price || s.business_details)) {
    return { strength: 4, why: "Asked for a call, meeting, proposal or to start, and described their need." };
  }
  if (s.specific_need && (s.budget_or_spend || s.timeline || s.contact_shared)) {
    const sig3 = [s.budget_or_spend && "a budget or spend", s.timeline && "a timeline", s.contact_shared && "contact details"].filter(Boolean).join(", ");
    return { strength: 3, why: `A specific need plus ${sig3}.` };
  }
  if (s.asked_price) return { strength: 2, why: "Asked about pricing." };
  if (s.specific_need) return { strength: 2, why: "Described a specific need, but no budget, timeline or contact details yet." };
  if (engaged && (s.business_details || s.contact_shared)) {
    return { strength: 2, why: `${s.asked_human || s.asked_meeting ? "Wants to talk to the team" : "Stated a general need"} and shared ${s.business_details ? "business details" : "contact details"}, but no specific need yet.` };
  }
  if (engaged) return { strength: 1, why: s.vague_need ? "A general need with no specifics." : "Wants to talk to the team but has not said what they need." };
  return { strength: 0, why: "No business need or buying signal." };
}

// Keep the intent label consistent with the strength.
function fixIntent(intent, strength, sig) {
  const s = sig || {};
  if (strength >= 3 && ["Service inquiry", "Pricing inquiry", "Other", "Information seeker"].includes(intent)) return "Sales intent";
  if (intent === "Sales intent" && strength < 3) {
    return s.asked_price ? "Pricing inquiry" : (s.specific_need || s.vague_need || s.asked_human || s.asked_meeting) ? "Service inquiry" : "Other";
  }
  return intent;
}

// Safety net: drop a "question" if it matches something the assistant asked much better than anything the visitor wrote.
const words = t => new Set(String(t || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(w => w.length > 2));
function overlap(a, b) { if (!a.size || !b.size) return 0; let n = 0; a.forEach(w => { if (b.has(w)) n++; }); return n / Math.min(a.size, b.size); }
function visitorOnly(questions, messages) {
  const sentences = role => (messages || []).filter(m => role.includes(m.role))
    .flatMap(m => String(m.content || "").split(/(?<=[?.!])\s+/)).map(words).filter(w => w.size);
  const bot = sentences(["assistant", "agent"]), visitor = sentences(["user", "visitor"]);
  return questions.filter(q => {
    const w = words(q);
    const fromBot = Math.max(0, ...bot.map(s => overlap(w, s)));
    const fromVisitor = Math.max(0, ...visitor.map(s => overlap(w, s)));
    return !(fromBot >= 0.5 && fromBot > fromVisitor + 0.2);
  });
}

export async function analyzeTranscript(messages) {
  const label = { user: "Visitor", visitor: "Visitor", assistant: "AI assistant", agent: "Team member", system: "Note" };
  const transcript = messages
    .filter(m => m && typeof m.content === "string" && m.content.trim())
    .map(m => `${label[m.role] || "Note"}: ${m.content.slice(0, 1500)}`)
    .join("\n").slice(-20000);
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID.trim() } : {})
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 900,
      system: SYSTEM,
      tools: [TOOL],
      tool_choice: { type: "tool", name: TOOL.name },
      messages: [{ role: "user", content: `Conversation:\n${transcript}` }]
    })
  });
  if (!r.ok) throw new Error(`Claude API ${r.status}: ${await r.text()}`);
  const data = await r.json();
  const block = (data.content || []).find(b => b.type === "tool_use");
  if (!block) throw new Error("No analysis returned");
  const a = block.input || {};
  const signals = {};
  SIGNALS.forEach(k => { signals[k] = !!(a.signals && a.signals[k]); });
  let intent = INTENTS.includes(a.intent) ? a.intent : "Other";
  const scored = scoreStrength(intent, signals);
  intent = fixIntent(intent, scored.strength, signals);
  const clean = t => String(t || "").replace(/\s*[\u2013\u2014]\s*/g, ", ");
  const list = (v, n) => (Array.isArray(v) ? v : []).map(x => clean(x).trim().slice(0, 160)).filter(Boolean).slice(0, n);
  return {
    intent,
    strength: scored.strength,
    strength_reason: scored.why,
    signals,
    need_summary: clean(a.need_summary).slice(0, 200) || "Not stated",
    service: SERVICES.includes(a.service) ? a.service : "Not stated",
    budget_text: clean(a.budget_text).slice(0, 120) || "Not stated",
    budget_band: ["none", "low", "medium", "high"].includes(a.budget_band) ? a.budget_band : "none",
    timeline: ["none", "later", "within_90_days", "within_30_days", "immediately"].includes(a.timeline) ? a.timeline : "none",
    business_type: clean(a.business_type).slice(0, 80) || "Not stated",
    business_fit: ["unknown", "poor", "ok", "good"].includes(a.business_fit) ? a.business_fit : "unknown",
    company_size: ["unknown", "solo", "small", "medium", "large"].includes(a.company_size) ? a.company_size : "unknown",
    questions: visitorOnly(list(a.questions, 5), messages), objections: list(a.objections, 4),
    buying_signals: [...new Set(list(a.buying_signals, 4).filter(x => BUYING_SIGNALS.includes(x)))],
    gaps: list(a.gaps, 3), topics: list(a.topics, 4),
    confidence: Math.max(0, Math.min(1, Number(a.confidence) || 0)),
    reason: clean(a.reason).slice(0, 400),
    model: MODEL_TAG
  };
}

async function analyzeOne(db, chat) {
  const live = (await db.get(`live_messages?select=role,content,created_at&session_id=eq.${enc(chat.session_id)}&order=id.asc`).catch(() => [])) || [];
  const msgs = (chat.messages || []).map((m, i) => ({ role: m.role, content: m.content, ts: m.ts || i }))
    .concat(live.map(m => ({ role: m.role, content: m.content, ts: new Date(m.created_at).getTime() })))
    .sort((x, y) => x.ts - y.ts);
  if (!msgs.some(m => m.role === "user" || m.role === "visitor")) return null;
  const a = await analyzeTranscript(msgs);
  const row = { session_id: chat.session_id, ...a, message_count: msgs.length, analyzed_at: new Date().toISOString() };
  await db.upsert("chat_analysis", row, "session_id");
  await maybeAlertHot(db, chat, row, msgs).catch(err => console.error("Hot-lead alert failed", err));
  await storeItems(db, chat.session_id, row).catch(err => console.error("Storing chat items failed", err));
  return row;
}

let cfgCache = null;
async function scoringConfig(db) {
  if (cfgCache && Date.now() - cfgCache.at < 60000) return cfgCache.cfg;
  const rows = (await db.get("scoring_config?select=config&id=eq.1").catch(() => [])) || [];
  const cfg = rows[0] && rows[0].config ? rows[0].config : globalThis.DRScore.DEFAULT;
  cfg.actions = Object.assign({}, globalThis.DRScore.DEFAULT.actions, cfg.actions || {});
  cfgCache = { cfg, at: Date.now() };
  return cfg;
}

// Email + computer pop-up the first time a chat scores at or above the hot-lead threshold.
async function maybeAlertHot(db, chat, row, msgs) {
  const S = globalThis.DRScore;
  if (!S) return;
  const prev = (await db.get(`chat_analysis?select=hot_alerted_at&session_id=eq.${enc(chat.session_id)}`).catch(() => [])) || [];
  if (prev[0] && prev[0].hot_alerted_at) return;
  const leads = (await db.get(`leads?select=name,email,phone&session_id=eq.${enc(chat.session_id)}`).catch(() => [])) || [];
  const text = msgs.filter(m => m.role === "user" || m.role === "visitor").map(m => m.content).join("\n");
  const email = leads.find(l => l.email)?.email || (text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i) || [])[0] || "";
  const phone = leads.find(l => l.phone)?.phone || ((text.match(/\+?\d[\d\s-]{8,}\d/) || [])[0] || "").trim();
  const cfg = await scoringConfig(db);
  const visitorMessages = msgs.filter(m => m.role === "user" || m.role === "visitor").length;
  const sc = S.score(row, { visitorMessages, hasEmail: !!email, hasPhone: !!phone }, cfg);
  if (!sc || sc.score < cfg.actions.hot_alert_score) return;
  const act = S.nextAction(row, sc, cfg);
  await db.patch("chat_analysis", `session_id=eq.${enc(chat.session_id)}`, { hot_alerted_at: new Date().toISOString() });
  const name = leads.find(l => l.name)?.name || "A website visitor";
  await notifyHot({
    name, email, phone, score: sc.score, action: act ? act.label : "", reason: act ? act.reason : sc.reason,
    need: row.need_summary, service: row.service, budget: row.budget_text,
    transcript: msgs.map(m => `${m.role === "user" || m.role === "visitor" ? "Visitor" : m.role === "agent" ? "Team" : "Bot"}: ${m.content}`).join("\n").slice(-4000)
  });
}

// Analyse chats that are new or changed since their last analysis and have been quiet for a while.
export async function runPending({ limit = 4, session = null, force = false } = {}) {
  const db = supa();
  if (!db) throw new Error("Database not configured");
  if (session) {
    const rows = await db.get(`chats?select=session_id,messages,updated_at&session_id=eq.${enc(session)}`);
    if (!rows || !rows.length) return { analyzed: 0, pending: 0, results: [] };
    const row = await analyzeOne(db, rows[0]);
    return { analyzed: row ? 1 : 0, pending: 0, results: row ? [row] : [] };
  }
  const cutoff = new Date(Date.now() - IDLE_MINUTES * 60000).toISOString();
  const since = new Date(Date.now() - LOOKBACK_DAYS * 86400000).toISOString();
  const [chats, done] = await Promise.all([
    db.get(`chats?select=session_id,messages,updated_at&updated_at=lt.${enc(cutoff)}&updated_at=gt.${enc(since)}&order=updated_at.desc&limit=500`),
    db.get(`chat_analysis?select=session_id,analyzed_at,model&limit=5000`)
  ]);
  const seen = {};
  (done || []).forEach(d => { seen[d.session_id] = d; });
  const todo = (chats || []).filter(c => {
    const d = seen[c.session_id];
    return force || !d || d.model !== MODEL_TAG || new Date(d.analyzed_at) < new Date(c.updated_at);
  });
  const batch = todo.slice(0, limit);
  const results = (await Promise.allSettled(batch.map(c => analyzeOne(db, c))))
    .map(r => (r.status === "fulfilled" ? r.value : (console.error("Analyst failed", r.reason), null)))
    .filter(Boolean);
  return { analyzed: results.length, pending: Math.max(0, todo.length - batch.length), results };
}
