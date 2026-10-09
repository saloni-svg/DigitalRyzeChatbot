/* DigitalRyze lead scoring engine.
 * Turns the Conversation Analyst's evidence into a 0 to 100 lead score and a qualified verdict,
 * using weights and rules that admins set in Settings. Pure functions, no AI call.
 */
(function (root) {
  var DEFAULT = {
    weights: { intent: 30, budget: 20, timeline: 15, business_fit: 15, service_fit: 10, engagement: 5, contact: 5 },
    rules: { min_score: 50, min_strength: 2, require_contact: true, exclude_intents: ["Job/career inquiry", "Spam", "Support request", "Existing client"] },
    actions: { call_min_score: 75, require_call_request: true, hot_alert_score: 75 }
  };
  var ACTIONS = {
    call_now: { icon: "\ud83d\udcde", label: "Call within 1 hour", urgent: true, priority: 1 },
    email_24h: { icon: "\u2709\ufe0f", label: "Email within 24 hours", urgent: true, priority: 2 },
    ask_need: { icon: "\ud83d\udcac", label: "Reply and ask what they need", urgent: true, priority: 3 },
    support: { icon: "\ud83d\udee0\ufe0f", label: "Pass to support or account team", urgent: true, priority: 4 },
    nurture: { icon: "\ud83c\udf31", label: "Add to nurture", urgent: false, priority: 5 },
    no_contact: { icon: "\u23f3", label: "No action possible", urgent: false, priority: 6 },
    no_action: { icon: "\u2796", label: "No action needed", urgent: false, priority: 7 },
    not_sales: { icon: "\ud83d\udeab", label: "Not a sales lead", urgent: false, priority: 8 }
  };
  var LABELS = {
    intent: "Intent strength", budget: "Budget", timeline: "Timeline", business_fit: "Business fit",
    service_fit: "Service fit", engagement: "Engagement", contact: "Contact details"
  };
  var OFFERED = ["SEO", "Google Ads", "Meta Ads", "Social media", "Web design", "AI services", "GoHighLevel automation", "Branding", "White label"];
  var NO_SALE = ["Job/career inquiry", "Spam"];

  // Each signal becomes a value from 0 to 1, with a short note explaining it.
  function parts(a, ctx) {
    var sig = a.signals || {};
    var out = {};
    out.intent = { v: (a.strength || 0) / 4, note: "Strength " + (a.strength || 0) + " of 4" };

    var band = a.budget_band || "none";
    var bv = { none: 0, low: 0.4, medium: 0.75, high: 1 }[band];
    if (band === "none" && sig.budget_or_spend) bv = 0.4;
    out.budget = { v: bv || 0, note: a.budget_text && a.budget_text !== "Not stated" ? a.budget_text : "Not stated" };

    var tl = a.timeline || "none";
    out.timeline = { v: { none: 0, later: 0.25, within_90_days: 0.5, within_30_days: 0.8, immediately: 1 }[tl] || 0,
      note: { none: "Not stated", later: "More than 3 months", within_90_days: "Within 3 months", within_30_days: "Within 30 days", immediately: "Right away" }[tl] || "Not stated" };

    var fit = a.business_fit || "unknown";
    var fv = { unknown: 0.3, poor: 0, ok: 0.6, good: 1 }[fit];
    if (fit === "unknown" && sig.business_details) fv = 0.5;
    out.business_fit = { v: fv, note: (a.business_type && a.business_type !== "Not stated" ? a.business_type + ", " : "") + fit + " fit" };

    var svc = a.service || "Not stated";
    var sv = OFFERED.indexOf(svc) !== -1 ? 1 : svc === "Other" ? 0.3 : (sig.vague_need ? 0.2 : 0);
    out.service_fit = { v: sv, note: svc };

    var n = ctx.visitorMessages || 0;
    out.engagement = { v: n >= 4 ? 1 : n === 3 ? 0.8 : n === 2 ? 0.5 : n === 1 ? 0.2 : 0, note: n + " visitor message" + (n === 1 ? "" : "s") };

    var email = ctx.hasEmail || false, phone = ctx.hasPhone || false;
    if (sig.contact_shared && !email && !phone) email = true;
    out.contact = { v: (email ? 0.5 : 0) + (phone ? 0.5 : 0), note: [email && "Email", phone && "Phone"].filter(Boolean).join(" + ") || "None" };
    return out;
  }

  function score(a, ctx, config) {
    config = config || DEFAULT;
    ctx = ctx || {};
    if (!a) return null;
    var w = config.weights || DEFAULT.weights, r = config.rules || DEFAULT.rules;
    var p = parts(a, ctx);
    var total = 0, sum = 0, breakdown = [];
    Object.keys(LABELS).forEach(function (k) {
      var wk = Math.max(0, Number(w[k]) || 0);
      total += wk;
      breakdown.push({ key: k, label: LABELS[k], weight: wk, value: p[k].v, note: p[k].note });
    });
    breakdown.forEach(function (b) { b.points = total ? (b.weight * b.value) / total * 100 : 0; sum += b.points; });
    var value = Math.round(sum);
    if (NO_SALE.indexOf(a.intent) !== -1) value = 0;

    var isContact = !!(ctx.hasEmail || ctx.hasPhone || (a.signals && a.signals.contact_shared));
    var excluded = (r.exclude_intents || []).indexOf(a.intent) !== -1;
    var isLead = isContact && !excluded && (a.strength || 0) >= 1;
    var fails = [];
    if (r.require_contact && !isContact) fails.push("no contact details");
    if (excluded) fails.push(a.intent.toLowerCase());
    if ((a.strength || 0) < r.min_strength) fails.push("intent strength below " + r.min_strength);
    if (value < r.min_score) fails.push("score below " + r.min_score);
    var qualified = fails.length === 0;

    var top = breakdown.filter(function (b) { return b.points >= 1; }).sort(function (x, y) { return y.points - x.points; }).slice(0, 3)
      .map(function (b) { return b.label.toLowerCase() + " (" + b.note + ")"; });
    var reason = qualified
      ? "Qualified: " + (top.length ? "driven by " + top.join(", ") : "meets all rules") + "."
      : "Not qualified: " + fails.join(", ") + "." + (top.length ? " Strongest signals: " + top.join(", ") + "." : "");

    return {
      score: value, tier: value >= 75 ? "hot" : value >= 50 ? "warm" : value >= 30 ? "mild" : "cold",
      is_contact: isContact, is_lead: isLead, is_qualified: qualified, reason: reason, breakdown: breakdown
    };
  }

  // Decide what the team should do next, from the analysis and the score.
  function nextAction(a, sc, config) {
    if (!a || !sc) return null;
    var act = (config && config.actions) || DEFAULT.actions;
    var sig = a.signals || {};
    var pick = function (key, why) { var x = ACTIONS[key]; return { key: key, icon: x.icon, label: x.label, urgent: x.urgent, priority: x.priority, reason: why }; };
    if (a.intent === "Job/career inquiry" || a.intent === "Spam") return pick("not_sales", a.intent === "Spam" ? "Spam or irrelevant chat." : "Asked about jobs, not a client.");
    if (a.intent === "Support request" || a.intent === "Existing client") {
      return sc.is_contact ? pick("support", "Needs help with an existing project or problem, not a new sale.") : pick("no_contact", "Needs help but left no email or phone.");
    }
    if (!sc.is_contact) {
      return (a.strength || 0) >= 1 ? pick("no_contact", "Showed interest (" + (a.need_summary && a.need_summary !== "Not stated" ? a.need_summary : a.intent) + ") but left no email or phone.")
        : pick("no_action", "Just browsing, no need or contact details.");
    }
    var asked = !!(sig.asked_meeting || sig.asked_human);
    if (sc.score >= act.call_min_score && (!act.require_call_request || sig.asked_meeting)) {
      return pick("call_now", "Score " + sc.score + (sig.asked_meeting ? ", asked for a call or proposal" : "") + (sig.budget_or_spend ? ", budget disclosed" : "") + (sig.timeline ? ", has a timeline" : "") + ".");
    }
    if (sc.is_qualified) return pick("email_24h", "Qualified lead (score " + sc.score + ")" + (a.need_summary && a.need_summary !== "Not stated" ? " needing " + (/^[A-Z][a-z]/.test(a.need_summary) ? a.need_summary.charAt(0).toLowerCase() + a.need_summary.slice(1) : a.need_summary) : "") + ". Follow up with a tailored email.");
    if (asked && !sig.specific_need) return pick("ask_need", "Wants to talk to the team but has not said what they need yet.");
    if ((a.strength || 0) >= 1) return pick("nurture", "Has contact details but is not ready yet (score " + sc.score + "). Keep in touch with useful content.");
    return pick("no_action", "Shared contact details but no business need.");
  }

  // ---------- Step 6: features + prediction for the ML model ----------
  var FEATURES = [
    ["strength", "Intent strength"], ["specific_need", "Specific need"], ["vague_need", "Only a general need"], ["asked_price", "Asked about price"],
    ["business_details", "Shared business details"], ["contact_shared", "Shared contact details"], ["budget_or_spend", "Mentioned a budget"],
    ["timeline", "Mentioned a timeline"], ["asked_meeting", "Asked for a call or proposal"], ["asked_human", "Asked for a person"],
    ["budget_level", "Budget size"], ["timeline_level", "How soon they want to start"], ["fit", "Business fit"], ["size", "Company size"],
    ["service_offered", "Wants a service we offer"], ["intent_sales", "Sales intent"], ["intent_pricing", "Pricing inquiry"],
    ["intent_service", "Service inquiry"], ["engagement", "Number of messages"]
  ];
  // Turn a lead's snapshot into numbers between 0 and 1.
  function featurize(f) {
    f = f || {};
    var sg = f.signals || {};
    var v = {
      strength: (Number(f.strength) || 0) / 4,
      budget_level: { none: 0, low: 0.33, medium: 0.67, high: 1 }[f.budget_band] || 0,
      timeline_level: { none: 0, later: 0.25, within_90_days: 0.5, within_30_days: 0.75, immediately: 1 }[f.timeline] || 0,
      fit: { poor: 0, unknown: 0.33, ok: 0.67, good: 1 }[f.business_fit] != null ? { poor: 0, unknown: 0.33, ok: 0.67, good: 1 }[f.business_fit] : 0.33,
      size: { unknown: 0.4, solo: 0.25, small: 0.5, medium: 0.75, large: 1 }[f.company_size] || 0.4,
      service_offered: OFFERED.indexOf(f.service) !== -1 ? 1 : 0,
      intent_sales: f.intent === "Sales intent" ? 1 : 0, intent_pricing: f.intent === "Pricing inquiry" ? 1 : 0, intent_service: f.intent === "Service inquiry" ? 1 : 0,
      engagement: Math.min(1, Math.log(1 + (Number(f.visitor_messages) || 0)) / Math.log(11))
    };
    ["specific_need", "vague_need", "asked_price", "business_details", "contact_shared", "budget_or_spend", "timeline", "asked_meeting", "asked_human"]
      .forEach(function (k) { v[k] = sg[k] ? 1 : 0; });
    return FEATURES.map(function (x) { return v[x[0]]; });
  }
  function sigmoid(z) { return 1 / (1 + Math.exp(-z)); }
  // Win probability + the factors that pushed it up or down for this lead.
  function predict(model, f) {
    if (!model || !model.weights) return null;
    var x = featurize(f), z = model.bias, parts = [];
    for (var i = 0; i < x.length; i++) {
      var zi = (x[i] - model.means[i]) / model.stds[i], c = model.weights[i] * zi;
      z += c; parts.push({ name: FEATURES[i][1], effect: c });
    }
    parts.sort(function (a, b) { return Math.abs(b.effect) - Math.abs(a.effect); });
    return { p: sigmoid(z), drivers: parts.filter(function (d) { return Math.abs(d.effect) > 0.05; }).slice(0, 4) };
  }

  var api = { DEFAULT: DEFAULT, LABELS: LABELS, ACTIONS: ACTIONS, FEATURES: FEATURES, score: score, nextAction: nextAction, featurize: featurize, predict: predict, sigmoid: sigmoid };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.DRScore = api;
})(typeof window !== "undefined" ? window : globalThis);
