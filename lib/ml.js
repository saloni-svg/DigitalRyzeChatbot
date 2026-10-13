// Step 6: predictive lead scoring.
// Supervised ML: learns from leads marked Won (1) or Lost (0) and predicts the probability a new lead will be won.
// Model: logistic regression with L2 regularization and balanced class weights, trained by gradient descent.
// Evaluation: stratified k-fold cross-validation, AUC, accuracy, Brier score, compared with the rule-based lead score.
import { supa } from "./db.js";
import "../public/admin/scoring.js"; // shared features (sets globalThis.DRScore)

// Training unlocks at MIN_TOTAL decided leads (Won or Lost) with at least MIN_EACH of each.
// Below PREVIEW outcomes the model is shown as a low-confidence preview. Both can be changed in Vercel
// (ML_MIN_TOTAL, ML_MIN_EACH) without touching code.
const envInt = (name, def, min) => Math.max(min, parseInt(process.env[name], 10) || def);
export const MIN_EACH = envInt("ML_MIN_EACH", 2, 2);
export const MIN_TOTAL = Math.max(envInt("ML_MIN_TOTAL", 14, 4), MIN_EACH * 2);
export const PREVIEW = 20, RELIABLE = 200;
const S = () => globalThis.DRScore;

function standardize(X) {
  const d = X[0].length, n = X.length, means = new Array(d).fill(0), stds = new Array(d).fill(0);
  X.forEach(r => r.forEach((v, j) => { means[j] += v / n; }));
  X.forEach(r => r.forEach((v, j) => { stds[j] += (v - means[j]) ** 2 / n; }));
  for (let j = 0; j < d; j++) stds[j] = Math.sqrt(stds[j]) || 1;
  return { means, stds };
}

export function trainLogistic(X, y, { lambda = 1, iters = 1500, lr = 0.2 } = {}) {
  const n = X.length, d = X[0].length, { means, stds } = standardize(X);
  const Z = X.map(r => r.map((v, j) => (v - means[j]) / stds[j]));
  const pos = y.filter(v => v === 1).length, neg = n - pos;
  const cw = { 1: n / (2 * Math.max(pos, 1)), 0: n / (2 * Math.max(neg, 1)) }; // balanced class weights
  let w = new Array(d).fill(0), b = Math.log((pos + 1) / (neg + 1));
  for (let it = 0; it < iters; it++) {
    const gw = new Array(d).fill(0); let gb = 0;
    for (let i = 0; i < n; i++) {
      let z = b; for (let j = 0; j < d; j++) z += w[j] * Z[i][j];
      const err = (1 / (1 + Math.exp(-z)) - y[i]) * cw[y[i]];
      for (let j = 0; j < d; j++) gw[j] += err * Z[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + (lambda / n) * w[j]);
    b -= lr * gb / n;
  }
  return { weights: w, bias: b, means, stds };
}

export function auc(scores, y) {
  const pairs = scores.map((s, i) => [s, y[i]]).sort((a, b) => a[0] - b[0]);
  let rank = 0, sumPos = 0, pos = 0, i = 0;
  while (i < pairs.length) {
    let j = i; while (j < pairs.length && pairs[j][0] === pairs[i][0]) j++;
    const avg = (i + 1 + j) / 2; // average rank for ties
    for (let k = i; k < j; k++) if (pairs[k][1] === 1) { sumPos += avg; pos++; }
    i = j;
  }
  const neg = pairs.length - pos;
  return pos && neg ? (sumPos - pos * (pos + 1) / 2) / (pos * neg) : null;
}

function predictRaw(m, x) {
  let z = m.bias; for (let j = 0; j < x.length; j++) z += m.weights[j] * (x[j] - m.means[j]) / m.stds[j];
  return 1 / (1 + Math.exp(-z));
}

// Stratified k-fold cross-validation: every lead is scored by a model that never saw it.
export function crossValidate(X, y, k) {
  const idxPos = [], idxNeg = [];
  y.forEach((v, i) => (v ? idxPos : idxNeg).push(i));
  const folds = Array.from({ length: k }, () => []);
  idxPos.forEach((i, n) => folds[n % k].push(i));
  idxNeg.forEach((i, n) => folds[n % k].push(i));
  const out = new Array(y.length);
  folds.forEach(test => {
    const testSet = new Set(test);
    const tr = y.map((_, i) => i).filter(i => !testSet.has(i));
    const m = trainLogistic(tr.map(i => X[i]), tr.map(i => y[i]));
    test.forEach(i => { out[i] = predictRaw(m, X[i]); });
  });
  return out;
}

export async function trainModel(trainedBy) {
  const db = supa();
  if (!db) throw new Error("Database not configured");
  const rows = (await db.get("lead_outcomes?select=stage,features&stage=in.(won,lost)&limit=10000")) || [];
  const data = rows.filter(r => r.features && r.features.intent);
  const y = data.map(r => (r.stage === "won" ? 1 : 0));
  const won = y.filter(Boolean).length, lost = y.length - won;
  if (data.length < MIN_TOTAL || won < MIN_EACH || lost < MIN_EACH) {
    return { trained: false, won, lost, message: `Not enough outcomes yet. Training needs at least ${MIN_TOTAL} leads marked Won or Lost, including ${MIN_EACH} of each. You have ${won} won and ${lost} lost.` };
  }
  const X = data.map(r => S().featurize(r.features));
  const k = Math.max(2, Math.min(5, won, lost));
  const cv = crossValidate(X, y, k);
  const rule = data.map(r => Number(r.features.score) || 0);
  const model = trainLogistic(X, y);
  const metrics = {
    examples: data.length, won, lost, folds: k,
    auc_ml: auc(cv, y), auc_rule: auc(rule, y),
    accuracy_ml: cv.filter((p, i) => (p >= 0.5 ? 1 : 0) === y[i]).length / y.length,
    brier_ml: cv.reduce((s, p, i) => s + (p - y[i]) ** 2, 0) / y.length,
    base_rate: won / y.length,
    reliability: data.length >= RELIABLE ? "reliable" : data.length >= PREVIEW ? "early" : "preview",
    importance: S().FEATURES.map((f, j) => ({ name: f[1], weight: model.weights[j] }))
      .sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))
  };
  const full = { ...model, features: S().FEATURES.map(f => f[0]), version: 1, trained_at: new Date().toISOString() };
  await db.patch("ml_models", "active=eq.true", { active: false }).catch(() => {});
  await db.insert("ml_models", { model: full, metrics, active: true, trained_by: trainedBy || "scheduled job" });
  return { trained: true, model: full, metrics };
}

export async function activeModel() {
  const db = supa();
  if (!db) return null;
  const rows = (await db.get("ml_models?select=model,metrics,created_at,trained_by&active=eq.true&order=created_at.desc&limit=1").catch(() => [])) || [];
  return rows[0] || null;
}
