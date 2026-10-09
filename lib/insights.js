// Conversation intelligence (Step 4).
// 1. Embeddings (Voyage AI): turn each question / objection / buying signal / gap into a meaning vector.
// 2. pgvector (Supabase): store the vectors.
// 3. Clustering (unsupervised ML): group items with similar meaning, without predefined labels.
// 4. Claude Sonnet: name each group and write the summary and recommendations.
import { supa, enc } from "./db.js";

const VOYAGE_MODEL = process.env.VOYAGE_MODEL || "voyage-3.5-lite";
const REPORT_MODEL = process.env.INSIGHTS_MODEL || process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const FALLBACK_MODEL = process.env.SUMMARY_MODEL || "claude-haiku-4-5-20251001";
const KINDS = ["question", "objection", "buying_signal", "gap"];
const SIMILARITY = Number(process.env.CLUSTER_SIMILARITY || 0.68); // how close two items must be to share a group

// ---------- 1. Embeddings ----------
export async function embedTexts(texts) {
  const key = process.env.VOYAGE_API_KEY;
  if (!key || !texts.length) return null;
  const r = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({ input: texts, model: VOYAGE_MODEL, input_type: "document" })
  });
  if (!r.ok) throw new Error(`Voyage API ${r.status}: ${await r.text()}`);
  const d = await r.json();
  const out = new Array(texts.length);
  (d.data || []).forEach(x => { out[x.index] = x.embedding; });
  return out;
}

// ---------- 2. Store items + vectors (pgvector) ----------
export async function storeItems(db, sessionId, analysis) {
  const items = [];
  [["question", analysis.questions], ["objection", analysis.objections], ["buying_signal", analysis.buying_signals], ["gap", analysis.gaps]]
    .forEach(([kind, list]) => (list || []).forEach(text => items.push({ kind, text })));
  await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/chat_items?session_id=eq.${enc(sessionId)}`, {
    method: "DELETE",
    headers: { apikey: process.env.SUPABASE_SERVICE_KEY, ...(process.env.SUPABASE_SERVICE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } : {}) }
  });
  if (!items.length) return 0;
  let vectors = null;
  try { vectors = await embedTexts(items.map(i => i.text)); } catch (err) { console.error("Embedding failed", err); }
  const rows = items.map((it, i) => ({
    session_id: sessionId, kind: it.kind, text: it.text,
    embedding: vectors && vectors[i] ? JSON.stringify(vectors[i]) : null
  }));
  await fetch(`${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/chat_items`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal", apikey: process.env.SUPABASE_SERVICE_KEY,
      ...(process.env.SUPABASE_SERVICE_KEY.startsWith("eyJ") ? { Authorization: `Bearer ${process.env.SUPABASE_SERVICE_KEY}` } : {}) },
    body: JSON.stringify(rows)
  }).then(async r => { if (!r.ok) throw new Error(`Saving items failed ${r.status}: ${await r.text()}`); });
  return rows.length;
}

// ---------- 3. Clustering (unsupervised ML) ----------
function normalize(v) {
  let n = 0; for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return v.map(x => x / n);
}
function dot(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
function mean(vs) {
  const m = new Array(vs[0].length).fill(0);
  vs.forEach(v => { for (let i = 0; i < v.length; i++) m[i] += v[i]; });
  return normalize(m);
}

// Leader clustering to find the groups, then k-means passes to refine them (cosine similarity).
export function cluster(items, threshold = SIMILARITY) {
  const withVec = items.filter(i => Array.isArray(i.vec));
  const withoutVec = items.filter(i => !Array.isArray(i.vec));
  let groups = [];
  withVec.forEach(it => {
    let best = -1, bestSim = -2;
    groups.forEach((g, gi) => { const sim = dot(it.vec, g.centroid); if (sim > bestSim) { bestSim = sim; best = gi; } });
    if (best >= 0 && bestSim >= threshold) {
      groups[best].members.push(it);
      groups[best].centroid = mean(groups[best].members.map(m => m.vec));
    } else groups.push({ centroid: it.vec, members: [it] });
  });
  for (let pass = 0; pass < 3 && groups.length > 1; pass++) {
    const fresh = groups.map(g => ({ centroid: g.centroid, members: [] }));
    withVec.forEach(it => {
      let best = 0, bestSim = -2;
      fresh.forEach((g, gi) => { const sim = dot(it.vec, g.centroid); if (sim > bestSim) { bestSim = sim; best = gi; } });
      fresh[best].members.push(it);
    });
    groups = fresh.filter(g => g.members.length).map(g => ({ centroid: mean(g.members.map(m => m.vec)), members: g.members }));
  }
  // Items without a vector (no embeddings key yet) are grouped by exact wording.
  const byText = {};
  withoutVec.forEach(it => { const k = it.text.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim(); (byText[k] = byText[k] || []).push(it); });
  Object.values(byText).forEach(members => groups.push({ centroid: null, members }));

  return groups.map(g => {
    // the example closest to the centre best represents the group
    const sorted = g.centroid ? g.members.slice().sort((a, b) => dot(b.vec, g.centroid) - dot(a.vec, g.centroid)) : g.members;
    const sessions = new Set(g.members.map(m => m.session_id));
    return { size: g.members.length, chats: sessions.size, examples: [...new Set(sorted.map(m => m.text))].slice(0, 6), sessions: [...sessions] };
  }).sort((a, b) => b.chats - a.chats || b.size - a.size);
}

// ---------- 4. Report: clusters + Claude Sonnet naming, summary and recommendations ----------
const REPORT_TOOL = {
  name: "record_insights",
  description: "Name each group and write the insights summary.",
  input_schema: {
    type: "object",
    properties: {
      names: {
        type: "array",
        description: "One short name (2 to 6 words) for every group, per kind. Give groups that mean the same thing EXACTLY the same name so they are merged. Use general wording, never company or person names.",
        items: { type: "object", properties: { kind: { type: "string" }, index: { type: "integer" }, name: { type: "string" } }, required: ["kind", "index", "name"] }
      },
      summary: { type: "string", description: "3 to 5 plain sentences about what prospects want, their main objections, and notable changes." },
      recommendations: { type: "array", items: { type: "string" }, description: "3 to 5 specific, practical recommendations for DigitalRyze." }
    },
    required: ["names", "summary", "recommendations"]
  }
};

export async function buildReport({ from, to, stats }) {
  const db = supa();
  if (!db) throw new Error("Database not configured");
  const where = `created_at=gte.${enc(from)}&created_at=lt.${enc(to)}`;
  const raw = (await db.get(`chat_items?select=session_id,kind,text,embedding&${where}&order=created_at.desc&limit=3000`)) || [];
  const embedded = raw.filter(r => r.embedding).length;
  const byKind = {};
  KINDS.forEach(k => { byKind[k] = []; });
  raw.forEach(r => {
    if (!byKind[r.kind]) return;
    let vec = null;
    if (r.embedding) { try { vec = normalize(typeof r.embedding === "string" ? JSON.parse(r.embedding) : r.embedding); } catch (e) { vec = null; } }
    byKind[r.kind].push({ session_id: r.session_id, text: r.text, vec });
  });
  const clusters = {};
  KINDS.forEach(k => { clusters[k] = cluster(byKind[k]).slice(0, 20); });

  // Ask Claude Sonnet to name the groups and write the summary (falls back to Haiku if slow or unavailable).
  let names = [], summary = "", recommendations = [], usedModel = null, summaryNote = "";
  const anything = KINDS.some(k => clusters[k].length);
  if (!anything) summaryNote = "No questions, objections or buying signals found in this period yet.";
  else if (!process.env.ANTHROPIC_API_KEY) summaryNote = "Claude API key is missing.";
  else {
    const listing = KINDS.map(k => `${k.toUpperCase()} GROUPS:\n` + (clusters[k].length
      ? clusters[k].slice(0, 12).map((c, i) => `${i}. (${c.chats} chats) examples: ${c.examples.slice(0, 3).map(e => `"${e}"`).join("; ")}`).join("\n")
      : "(none)")).join("\n\n");
    const ask = async (model, ms) => {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), ms);
      try {
        const r = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST", signal: ctrl.signal,
          headers: {
            "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01",
            ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID.trim() } : {})
          },
          body: JSON.stringify({
            model, max_tokens: 1500,
            system: "You are a marketing analyst for DigitalRyze, a digital marketing agency. You review grouped website chat data and write clear, practical insights for the owner. Plain English, no jargon, never use em dashes or en dashes. Only state what the data supports. If there is little data, still summarise what there is and say that more chats are needed for firm conclusions.",
            tools: [REPORT_TOOL], tool_choice: { type: "tool", name: REPORT_TOOL.name },
            messages: [{ role: "user", content: `Period: ${from.slice(0, 10)} to ${to.slice(0, 10)}\n\nKey numbers:\n${JSON.stringify(stats || {})}\n\n${listing}\n\nName every group (kind must be one of question, objection, buying_signal, gap and index is its number), then write the summary and recommendations.` }]
          })
        });
        if (!r.ok) throw new Error(`${model} returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const d = await r.json();
        const b = (d.content || []).find(x => x.type === "tool_use");
        if (!b || !b.input) throw new Error(`${model} returned no summary`);
        return b.input;
      } catch (err) {
        throw err.name === "AbortError" ? new Error(`${model} took too long`) : err;
      } finally { clearTimeout(timer); }
    };
    let out = null;
    const tries = [[REPORT_MODEL, 30000], [FALLBACK_MODEL, 15000]];
    for (const [model, ms] of tries) {
      try { out = await ask(model, ms); usedModel = model; break; }
      catch (err) { console.error("Insights summary failed", err.message); summaryNote = err.message; }
    }
    if (out) {
      summaryNote = "";
      names = out.names || [];
      summary = String(out.summary || "").replace(/\s*[\u2013\u2014]\s*/g, ", ");
      recommendations = (out.recommendations || []).map(x => String(x).replace(/\s*[\u2013\u2014]\s*/g, ", "));
    } else summaryNote = "The AI summary could not be created (" + summaryNote + "). The groups below are still accurate. Try Refresh insights again in a minute.";
  }
  KINDS.forEach(k => {
    clusters[k].forEach((c, i) => {
      const n = names.find(x => x.kind === k && Number(x.index) === i);
      c.name = n ? n.name : c.examples[0];
    });
    // Merge groups that ended up with the same name (same meaning).
    const merged = {};
    clusters[k].forEach(c => {
      const key = c.name.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
      if (!merged[key]) { merged[key] = { ...c, sessions: [...c.sessions] }; return; }
      const m = merged[key];
      m.size += c.size;
      m.sessions = [...new Set(m.sessions.concat(c.sessions))];
      m.examples = [...new Set(m.examples.concat(c.examples))].slice(0, 6);
    });
    clusters[k] = Object.values(merged).map(c => ({ ...c, chats: c.sessions.length }))
      .sort((a, b) => b.chats - a.chats || b.size - a.size).slice(0, 10);
  });

  const report = {
    from, to, created_at: new Date().toISOString(), clusters, summary, recommendations, summary_note: summaryNote,
    items: raw.length, embedded, method: embedded ? "embeddings + clustering" : "exact wording (add a Voyage AI key for meaning-based grouping)",
    model: usedModel || REPORT_MODEL, embedding_model: embedded ? VOYAGE_MODEL : null
  };
  await db.upsert("insights_reports", { key: `${from.slice(0, 10)}_${to.slice(0, 10)}`, report, created_at: report.created_at }, "key").catch(() => {});
  return report;
}
