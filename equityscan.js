#!/usr/bin/env node
"use strict";
/**
 * EquityScan — single-file app.
 *
 * Runs the full backend (real NSE data via stock-nse-india, cached and
 * budget-limited) AND serves the frontend, from one file.
 *
 *   npm install express cors stock-nse-india
 *   node equityscan.js
 *   open http://localhost:3000
 *
 * Everything below is organized the same way the multi-file version was
 * (config / cache / budget / provider / normalize / services / routes) —
 * just inlined into one process so there's a single file to run. See
 * README.md in this bundle for the full write-up of the caching and
 * daily-budget strategy.
 */

const fs = require("fs");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { NseIndia } = require("stock-nse-india");

/* ============================================================
   CONFIG
   ============================================================ */
function num(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const config = {
  port: num("PORT", 3000),
  frontendOrigin: process.env.FRONTEND_ORIGIN || "*",
  dailyCallBudget: num("DAILY_CALL_BUDGET", 50),
  quoteCacheTtl: num("QUOTE_CACHE_TTL", 5 * 60 * 1000),
  marketStatusCacheTtl: num("MARKET_STATUS_CACHE_TTL", 60 * 1000),
  requestTimeout: num("REQUEST_TIMEOUT", 10000),
  maxConcurrency: num("MAX_CONCURRENCY", 4),
  maxRetries: num("MAX_RETRIES", 2),
  refreshIntervalMs: num("REFRESH_INTERVAL_MS", 15 * 60 * 1000),

  // AI assistant (Groq) — optional. Feature simply reports "not configured"
  // if GROQ_API_KEY isn't set; nothing else in the app depends on it.
  groqApiKey: process.env.GROQ_API_KEY || null,
  // llama-3.3-70b-versatile was deprecated by Groq and decommissioned for
  // free/developer-tier accounts as of August 2026 — using its recommended
  // replacement instead. Override via GROQ_MODEL env var if Groq's lineup
  // changes again (it does, often), no code change needed.
  groqModel: process.env.GROQ_MODEL || "openai/gpt-oss-120b",
  groqDailyBudget: num("GROQ_DAILY_BUDGET", 500),
  groqRequestTimeout: num("GROQ_REQUEST_TIMEOUT", 15000),
  explainCacheTtl: num("EXPLAIN_CACHE_TTL", 10 * 60 * 1000),
  chatDedupeTtl: num("CHAT_DEDUPE_TTL", 60 * 1000),

  universe: [
    "TCS", "RELIANCE", "HDFCBANK", "INFY", "ICICIBANK", "BHARTIARTL", "SBIN",
    "ITC", "LT", "KOTAKBANK", "HINDUNILVR", "AXISBANK", "BAJFINANCE", "MARUTI",
    "ASIANPAINT", "WIPRO", "TITAN", "SUNPHARMA", "NTPC", "ADANIENT",
    "ULTRACEMCO", "POWERGRID", "NESTLEIND", "TATAMOTORS", "JSWSTEEL",
  ],
};

/* ============================================================
   ERRORS
   ============================================================ */
class ApiError extends Error {
  constructor(code, message, httpStatus) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus || 500;
  }
  toJSON() {
    return { success: false, error: { code: this.code, message: this.message } };
  }
}
const Errors = {
  invalidSymbol: (sym) => new ApiError("INVALID_SYMBOL", `"${sym}" is not a valid NSE symbol.`, 400),
  invalidParameters: (msg) => new ApiError("INVALID_PARAMETERS", msg, 400),
  notFound: (msg) => new ApiError("NOT_FOUND", msg || "Resource not found.", 404),
  rateLimited: (msg) => new ApiError("RATE_LIMITED", msg || "Upstream rate limit reached. Try again shortly.", 429),
  budgetExhausted: () => new ApiError("RATE_LIMITED", "Daily upstream call budget is exhausted; serving cached data only until reset.", 429),
  providerForbidden: () => new ApiError("PROVIDER_FORBIDDEN", "NSE rejected the upstream request.", 502),
  providerUnavailable: (msg) => new ApiError("PROVIDER_UNAVAILABLE", msg || "Market data service is temporarily unavailable.", 503),
  timeout: () => new ApiError("TIMEOUT", "Upstream request timed out.", 504),
  invalidProviderResponse: () => new ApiError("INVALID_PROVIDER_RESPONSE", "Upstream returned an unexpected response shape.", 502),
  internal: (msg) => new ApiError("INTERNAL_ERROR", msg || "Internal server error.", 500),
  aiNotConfigured: () => new ApiError("AI_NOT_CONFIGURED", "GROQ_API_KEY is not set on the server, so the AI assistant is unavailable.", 503),
  aiBudgetExhausted: () => new ApiError("RATE_LIMITED", "Daily AI call budget is exhausted; try again after reset.", 429),
  aiUnavailable: (msg) => new ApiError("PROVIDER_UNAVAILABLE", msg || "The AI assistant is temporarily unavailable.", 503),
};

/* ============================================================
   VALIDATION
   ============================================================ */
const SYMBOL_RE = /^[A-Z0-9&\-]{1,20}$/;
function cleanSymbol(raw) {
  if (typeof raw !== "string") throw Errors.invalidSymbol(String(raw));
  const sym = raw.trim().toUpperCase();
  if (!SYMBOL_RE.test(sym)) throw Errors.invalidSymbol(raw);
  return sym;
}
function cleanNumber(raw, { name, fallback, min = 0, max = Number.MAX_SAFE_INTEGER }) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw Errors.invalidParameters(`"${name}" must be a finite number.`);
  if (n < min || n > max) throw Errors.invalidParameters(`"${name}" must be between ${min} and ${max}.`);
  return n;
}

/* ============================================================
   CACHE (TTL + in-flight dedup)
   ============================================================ */
class CacheService {
  constructor() { this.store = new Map(); this.inFlight = new Map(); }
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) { this.store.delete(key); return undefined; }
    return entry.value;
  }
  getStale(key) { const entry = this.store.get(key); return entry ? entry.value : undefined; }
  set(key, value, ttlMs) { this.store.set(key, { value, expiresAt: Date.now() + ttlMs }); return value; }
  async dedupe(key, fn) {
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const p = Promise.resolve().then(fn).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }
}
const cache = new CacheService();

/* ============================================================
   DAILY CALL BUDGET (persisted, resets at 00:00 IST)
   ============================================================ */
function istDateKey(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}
// Generic persisted daily-call budget — used separately for NSE calls and
// for Groq AI calls, so exhausting one never affects the other.
class BudgetService {
  constructor(stateFileName, limit) {
    this.stateFile = path.join(__dirname, stateFileName);
    this.limit = limit;
    this.load();
  }
  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (parsed.date === istDateKey()) { this.date = parsed.date; this.used = parsed.used; return; }
    } catch (e) { /* no state file yet, or corrupt — start fresh */ }
    this.date = istDateKey(); this.used = 0; this.persist();
  }
  persist() {
    try { fs.writeFileSync(this.stateFile, JSON.stringify({ date: this.date, used: this.used })); }
    catch (e) { console.error("[EquityScan] failed to persist budget state:", e.message); }
  }
  rolloverIfNeeded() {
    const today = istDateKey();
    if (today !== this.date) { this.date = today; this.used = 0; this.persist(); }
  }
  remaining() { this.rolloverIfNeeded(); return Math.max(0, this.limit - this.used); }
  canSpend(n = 1) { return this.remaining() >= n; }
  spend(n = 1) { this.rolloverIfNeeded(); this.used += n; this.persist(); return this.remaining(); }
  status() { this.rolloverIfNeeded(); return { date: this.date, limit: this.limit, used: this.used, remaining: this.remaining() }; }
}
const budget = new BudgetService(".budget-state.json", config.dailyCallBudget);
const groqBudget = new BudgetService(".groq-budget-state.json", config.groqDailyBudget);

/* ============================================================
   PROVIDER ADAPTER — the only place that talks to NSE
   ============================================================ */
const nse = new NseIndia();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(Errors.timeout()), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
function classifyHttpError(err) {
  const status = err?.response?.status || err?.status;
  if (status === 403) return Errors.providerForbidden();
  if (status === 429) return Errors.rateLimited("NSE rate-limited this request.");
  if (status === 404) return Errors.notFound("Symbol not found on NSE.");
  if (status >= 500) return Errors.providerUnavailable(`NSE returned ${status}.`);
  return Errors.providerUnavailable(err?.message);
}
async function withRetry(fn, { maxRetries, label }) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await withTimeout(fn(), config.requestTimeout);
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      if (status === 403) throw classifyHttpError(err);
      if (err && err.code === "TIMEOUT" && attempt === maxRetries) throw err;
      if (attempt < maxRetries) {
        const backoff = 250 * Math.pow(2, attempt);
        console.warn(`[EquityScan] ${label} attempt ${attempt + 1} failed (${status || err.code || err.message}); retrying in ${backoff}ms`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
    }
  }
  if (lastErr && lastErr.code) throw lastErr;
  throw classifyHttpError(lastErr);
}
async function providerGetEquity(symbol) {
  return withRetry(() => nse.getEquityDetails(symbol), { maxRetries: config.maxRetries, label: `getEquityDetails(${symbol})` });
}
async function providerGetMarketStatus() {
  return withRetry(() => nse.getMarketStatus(), { maxRetries: config.maxRetries, label: "getMarketStatus" });
}
async function providerGetAllSymbols() {
  try { return await withRetry(() => nse.getAllStockSymbols(), { maxRetries: 1, label: "getAllStockSymbols" }); }
  catch (e) { return null; }
}

/* ============================================================
   GROQ CLIENT — the only place that talks to Groq's API.
   Uses the global fetch available in Node 18+. Grounded, short,
   no-advice system framing lives in the routes that call this.
   ============================================================ */
async function callGroq(messages, { maxTokens = 500, temperature = 0.3 } = {}) {
  if (!config.groqApiKey) throw Errors.aiNotConfigured();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), config.groqRequestTimeout);
  let res;
  try {
    res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.groqApiKey}`,
      },
      body: JSON.stringify({
        model: config.groqModel,
        messages,
        max_tokens: maxTokens,
        temperature,
      }),
      signal: ctrl.signal,
    });
  } catch (err) {
    if (err.name === "AbortError") throw Errors.timeout();
    throw Errors.aiUnavailable(err.message);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) throw Errors.aiUnavailable("Groq rejected the API key (401) — check GROQ_API_KEY on the server.");
  if (res.status === 429) throw Errors.aiBudgetExhausted();
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Errors.aiUnavailable(`Groq returned ${res.status}: ${text.slice(0, 200)}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw Errors.invalidProviderResponse();
  return content.trim();
}

/* ============================================================
   NORMALIZATION — map raw NSE shape to EquityScan's stable contract.
   Only fields the provider actually returns are mapped; market cap is
   not reliably available from NSE's free equity endpoint, so it's
   always null rather than guessed. See README "Data Integrity".
   ============================================================ */
function n(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function normalizeEquity(symbol, raw) {
  if (!raw || typeof raw !== "object") return null;
  const info = raw.info || {};
  const priceInfo = raw.priceInfo || {};
  const weekHighLow = priceInfo.weekHighLow || {};
  const securityInfo = raw.securityInfo || {};

  const currentPrice = n(priceInfo.lastPrice);
  const week52High = n(weekHighLow.max);
  const marketCap = null; // never fabricated — see comment above
  const volume = n(priceInfo.totalTradedVolume ?? securityInfo.totalTradedVolume);

  const required = [currentPrice, week52High, marketCap];
  const missing = required.filter((v) => v === null || v === undefined).length;
  const dataStatus = missing === 0 ? "COMPLETE" : missing === required.length ? "UNAVAILABLE" : "PARTIAL";

  return {
    symbol,
    companyName: info.companyName || null,
    exchange: "NSE",
    sector: info.industry || null,
    currentPrice,
    previousClose: n(priceInfo.previousClose),
    change: n(priceInfo.change),
    percentChange: n(priceInfo.pChange),
    open: n(priceInfo.open),
    dayHigh: priceInfo.intraDayHighLow ? n(priceInfo.intraDayHighLow.max) : null,
    dayLow: priceInfo.intraDayHighLow ? n(priceInfo.intraDayHighLow.min) : null,
    week52High,
    week52Low: n(weekHighLow.min),
    marketCap,
    volume,
    lastUpdated: priceInfo.lastUpdateTime || null,
    dataStatus,
  };
}

/* ============================================================
   CONCURRENCY-LIMITED BATCH RUNNER
   ============================================================ */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  async function runOne() {
    while (cursor < items.length) {
      const idx = cursor++;
      try { results[idx] = { ok: true, value: await worker(items[idx], idx) }; }
      catch (err) { results[idx] = { ok: false, error: err }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

/* ============================================================
   STOCK SERVICE — cache-first, budget-aware, deduplicated
   ============================================================ */
const keyFor = (symbol) => `equity:${symbol}`;
async function getNormalizedEquity(symbol) {
  const key = keyFor(symbol);
  const fresh = cache.get(key);
  if (fresh) return { data: fresh, source: "cache" };

  return cache.dedupe(key, async () => {
    const freshAfterWait = cache.get(key);
    if (freshAfterWait) return { data: freshAfterWait, source: "cache" };

    if (!budget.canSpend(1)) {
      const stale = cache.getStale(key);
      if (stale) return { data: stale, source: "stale-cache-budget-exhausted" };
      throw Errors.budgetExhausted();
    }
    const raw = await providerGetEquity(symbol);
    budget.spend(1);
    const normalized = normalizeEquity(symbol, raw);
    if (!normalized) throw Errors.invalidProviderResponse();
    cache.set(key, normalized, config.quoteCacheTtl);
    return { data: normalized, source: "provider" };
  });
}
async function getRawEquity(symbol) {
  const key = `raw:${symbol}`;
  const fresh = cache.get(key);
  if (fresh) return { data: fresh, source: "cache" };

  return cache.dedupe(key, async () => {
    const freshAfterWait = cache.get(key);
    if (freshAfterWait) return { data: freshAfterWait, source: "cache" };

    if (!budget.canSpend(1)) {
      const stale = cache.getStale(key);
      if (stale) return { data: stale, source: "stale-cache-budget-exhausted" };
      throw Errors.budgetExhausted();
    }
    const raw = await providerGetEquity(symbol);
    budget.spend(1);
    cache.set(key, raw, config.quoteCacheTtl);
    return { data: raw, source: "provider" };
  });
}

/* ============================================================
   MARKET SERVICE
   ============================================================ */
const MARKET_KEY = "market:status";
async function getMarketStatus() {
  const fresh = cache.get(MARKET_KEY);
  if (fresh) return { data: fresh, source: "cache" };

  return cache.dedupe(MARKET_KEY, async () => {
    const freshAfterWait = cache.get(MARKET_KEY);
    if (freshAfterWait) return { data: freshAfterWait, source: "cache" };

    if (!budget.canSpend(1)) {
      const stale = cache.getStale(MARKET_KEY);
      if (stale) return { data: stale, source: "stale-cache-budget-exhausted" };
      return { data: { market: "NSE", status: "UNKNOWN", tradeDate: null, lastUpdated: null }, source: "unavailable" };
    }
    try {
      const raw = await providerGetMarketStatus();
      budget.spend(1);
      const marketBlock = Array.isArray(raw?.marketState) ? (raw.marketState.find((m) => m.market === "Capital Market") || raw.marketState[0]) : null;
      const normalized = {
        market: "NSE",
        status: marketBlock?.marketStatus ? (marketBlock.marketStatus.toUpperCase().includes("OPEN") ? "OPEN" : "CLOSED") : "UNKNOWN",
        tradeDate: marketBlock?.tradeDate || null,
        lastUpdated: new Date().toISOString(),
      };
      cache.set(MARKET_KEY, normalized, config.marketStatusCacheTtl);
      return { data: normalized, source: "provider" };
    } catch (err) {
      const stale = cache.getStale(MARKET_KEY);
      if (stale) return { data: stale, source: "stale-cache-provider-error" };
      throw err && err.code ? err : Errors.providerUnavailable();
    }
  });
}

/* ============================================================
   SCREENER SERVICE + background pre-warmer
   ============================================================ */
function evaluate(equity, marketCapMin, highPercentMin) {
  const { currentPrice, week52High, marketCap } = equity;
  const missing = currentPrice === null || week52High === null || marketCap === null;
  if (missing) {
    return {
      symbol: equity.symbol, companyName: equity.companyName, currentPrice,
      change: equity.change, percentChange: equity.percentChange, week52High,
      highPercent: null, marketCap, status: "DATA_UNAVAILABLE",
    };
  }
  const highPercent = (currentPrice / week52High) * 100;
  const passes = marketCap >= marketCapMin && highPercent >= highPercentMin;
  return {
    symbol: equity.symbol, companyName: equity.companyName, currentPrice,
    change: equity.change, percentChange: equity.percentChange, week52High,
    highPercent: Number(highPercent.toFixed(2)), marketCap, status: passes ? "PASS" : "FAIL",
  };
}
async function runScreener({ marketCapMin, highPercentMin, symbols }) {
  const universe = symbols && symbols.length ? symbols : config.universe;
  const outcomes = await mapWithConcurrency(universe, config.maxConcurrency, async (symbol) => {
    const { data } = await getNormalizedEquity(symbol);
    return data;
  });
  const results = [];
  let passed = 0, failed = 0, dataUnavailable = 0;
  outcomes.forEach((outcome, i) => {
    if (!outcome.ok) {
      results.push({ symbol: universe[i], companyName: null, currentPrice: null, change: null, percentChange: null, week52High: null, highPercent: null, marketCap: null, status: "DATA_UNAVAILABLE" });
      dataUnavailable++; return;
    }
    const evaluated = evaluate(outcome.value, marketCapMin, highPercentMin);
    if (evaluated.status === "PASS") passed++; else if (evaluated.status === "FAIL") failed++; else dataUnavailable++;
    results.push(evaluated);
  });
  return { criteria: { marketCapMin, highPercentMin }, summary: { scanned: universe.length, passed, failed, dataUnavailable }, results };
}
let refreshCursor = 0;
function startBackgroundRefresh() {
  const BATCH_SIZE = Math.max(1, Math.min(config.maxConcurrency, 3));
  setInterval(async () => {
    const batch = [];
    for (let i = 0; i < BATCH_SIZE; i++) { batch.push(config.universe[refreshCursor % config.universe.length]); refreshCursor++; }
    for (const symbol of batch) {
      try { await getNormalizedEquity(symbol); } catch (e) { /* budget exhausted or upstream error — skip silently */ }
    }
  }, config.refreshIntervalMs).unref();
}

/* ============================================================
   EXPRESS APP
   ============================================================ */
const app = express();
app.use(cors({ origin: config.frontendOrigin }));
app.use(express.json());
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => console.log(`[EquityScan] ${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - start}ms)`));
  next();
});

function errorMiddleware(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof ApiError) { console.error(`[EquityScan] ${err.code}: ${err.message}`); return res.status(err.httpStatus).json(err.toJSON()); }
  console.error("[EquityScan] unhandled error:", err);
  return res.status(500).json(Errors.internal().toJSON());
}

// --- API routes ---
app.get("/api/health", (req, res) => {
  res.json({ success: true, service: "EquityScan Backend", status: "healthy", provider: "stock-nse-india", timestamp: new Date().toISOString() });
});

app.get("/api/stock/:symbol", async (req, res, next) => {
  try { const symbol = cleanSymbol(req.params.symbol); const { data } = await getNormalizedEquity(symbol); res.json({ success: true, data }); }
  catch (err) { next(err); }
});

app.get("/api/equity/:symbol", async (req, res, next) => {
  try { const symbol = cleanSymbol(req.params.symbol); const { data } = await getRawEquity(symbol); res.json(data); }
  catch (err) { next(err); }
});

app.get("/api/screener", async (req, res, next) => {
  try {
    const marketCapMin = cleanNumber(req.query.marketCapMin, { name: "marketCapMin", fallback: 100, min: 0, max: 100_000_000 });
    const highPercentMin = cleanNumber(req.query.highPercentMin, { name: "highPercentMin", fallback: 80, min: 0, max: 100 });
    const result = await runScreener({ marketCapMin, highPercentMin });
    res.json({ success: true, ...result });
  } catch (err) { next(err); }
});

app.get("/api/market/status", async (req, res, next) => {
  try { const { data } = await getMarketStatus(); res.json({ success: true, ...data }); }
  catch (err) { next(err); }
});

app.get("/api/symbols", async (req, res, next) => {
  try {
    const all = await providerGetAllSymbols();
    const symbols = Array.isArray(all) && all.length ? all : config.universe;
    res.json({ success: true, count: symbols.length, symbols });
  } catch (err) { next(err); }
});

app.get("/api/provider/status", (req, res) => {
  res.json({ provider: "stock-nse-india", status: "available", cacheEnabled: true, dailyBudget: budget.status() });
});

/* ============================================================
   AI ASSISTANT (Groq) — explain a stock, and free-form chat.
   Both are grounded only in data this app actually fetched from
   NSE (or whatever the frontend passes as context), and both
   explicitly decline to give buy/sell advice. Neither endpoint
   fabricates news or "why" behind a move unless it's a plain
   inference from the numbers themselves.
   ============================================================ */
app.get("/api/ai/status", (req, res) => {
  res.json({
    configured: !!config.groqApiKey,
    model: config.groqModel,
    dailyBudget: groqBudget.status(),
  });
});

const EXPLAIN_SYSTEM_PROMPT = `You are EquityScan's data explainer. You are given a single JSON object
describing one NSE-listed stock's current quote data. Write a short, plain-English
explanation (3-5 sentences) of what the numbers show: today's price move, where the
price sits relative to its 52-week range, and anything else notable in the given
fields. Rules:
- Only use the numbers given to you. Never invent a reason (news, earnings, sector
  trend) for a price move unless it's a direct, obvious inference from the numbers
  themselves (e.g. "near its 52-week low").
- If a field is null, say that data point isn't available rather than guessing.
- Do not give investment advice, price targets, or a buy/sell/hold recommendation.
- Plain sentences, no markdown headers or bullet lists, no disclaimers beyond a
  brief closing note that this isn't financial advice.`;

app.get("/api/explain/:symbol", async (req, res, next) => {
  try {
    const symbol = cleanSymbol(req.params.symbol);
    const cacheKey = `explain:${symbol}`;

    const fresh = cache.get(cacheKey);
    if (fresh) return res.json({ success: true, data: fresh, cached: true });

    const result = await cache.dedupe(cacheKey, async () => {
      const freshAfterWait = cache.get(cacheKey);
      if (freshAfterWait) return freshAfterWait;

      const { data: equity } = await getNormalizedEquity(symbol);

      if (!groqBudget.canSpend(1)) {
        const stale = cache.getStale(cacheKey);
        if (stale) return stale;
        throw Errors.aiBudgetExhausted();
      }

      const explanation = await callGroq(
        [
          { role: "system", content: EXPLAIN_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify(equity) },
        ],
        { maxTokens: 260, temperature: 0.3 }
      );
      groqBudget.spend(1);

      const payload = { symbol, explanation, basedOn: equity, generatedAt: new Date().toISOString() };
      cache.set(cacheKey, payload, config.explainCacheTtl);
      return payload;
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

const CHAT_SYSTEM_PROMPT = `You are the EquityScan Assistant, built into an NSE stock-market dashboard.
You answer questions using ONLY the JSON "context" data provided with each message
(current stock quotes, watchlist, market breadth, etc. — whatever the app included).
Rules:
- Do not claim knowledge of news, earnings calls, or events not present in the
  context. If something isn't in the context, say you don't have that data rather
  than guessing.
- Never give investment advice, price targets, or a buy/sell/hold recommendation.
  You can describe what the numbers show; you cannot tell the user what to do
  with their money. If asked directly, decline briefly and explain why.
- Keep answers concise — a few sentences unless the question genuinely needs more.
- Plain text, no markdown headers.`;

function truncateJSON(obj, maxChars) {
  let str = JSON.stringify(obj ?? {});
  if (str.length > maxChars) str = str.slice(0, maxChars) + "...(truncated)";
  return str;
}

app.post("/api/chat", async (req, res, next) => {
  try {
    const { question, context, history } = req.body || {};
    if (typeof question !== "string" || !question.trim()) {
      throw Errors.invalidParameters('"question" is required and must be a non-empty string.');
    }
    if (question.length > 2000) throw Errors.invalidParameters('"question" is too long (max 2000 characters).');

    const safeHistory = Array.isArray(history)
      ? history.slice(-6).filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }))
      : [];

    const contextStr = truncateJSON(context, 6000);
    const dedupeKey = `chat:${question.trim()}:${contextStr}`;

    const cachedAnswer = cache.get(dedupeKey);
    if (cachedAnswer) return res.json({ success: true, data: cachedAnswer, cached: true });

    const result = await cache.dedupe(dedupeKey, async () => {
      const freshAfterWait = cache.get(dedupeKey);
      if (freshAfterWait) return freshAfterWait;

      if (!groqBudget.canSpend(1)) throw Errors.aiBudgetExhausted();

      const messages = [
        { role: "system", content: CHAT_SYSTEM_PROMPT },
        { role: "system", content: `Context data (JSON):\n${contextStr}` },
        ...safeHistory,
        { role: "user", content: question.trim() },
      ];

      const answer = await callGroq(messages, { maxTokens: 400, temperature: 0.4 });
      groqBudget.spend(1);

      const payload = { answer, generatedAt: new Date().toISOString() };
      cache.set(dedupeKey, payload, config.chatDedupeTtl);
      return payload;
    });

    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
});

// --- Frontend (embedded, base64-decoded at startup) ---
const FRONTEND_B64_CHUNKS = [
  "PCFET0NUWVBFIGh0bWw+CjxodG1sIGxhbmc9ImVuIj4KPGhlYWQ+CjxtZXRhIGNoYXJzZXQ9IlVURi04Ij4KPG1ldGEgbmFtZT0idmlld3BvcnQiIGNvbnRlbnQ9IndpZHRoPWRldmljZS13aWR0aCwgaW5pdGlhbC1zY2FsZT0xLjAsIHZpZXdwb3J0LWZpdD1jb3Zl",
  "ciI+Cjx0aXRsZT5FcXVpdHlTY2FuIOKAlCBTdG9jayBJbnRlbGxpZ2VuY2U8L3RpdGxlPgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8vZm9udHMuZ29vZ2xlYXBpcy5jb20iPgo8bGluayByZWw9InByZWNvbm5lY3QiIGhyZWY9Imh0dHBzOi8v",
  "Zm9udHMuZ3N0YXRpYy5jb20iIGNyb3Nzb3JpZ2luPgo8bGluayBocmVmPSJodHRwczovL2ZvbnRzLmdvb2dsZWFwaXMuY29tL2NzczI/ZmFtaWx5PU1hbnJvcGU6d2dodEA0MDA7NTAwOzYwMDs3MDA7ODAwJmZhbWlseT1KZXRCcmFpbnMrTW9ubzp3Z2h0QDQwMDs1",
  "MDA7NjAwOzcwMCZkaXNwbGF5PXN3YXAiIHJlbD0ic3R5bGVzaGVldCI+CjxzdHlsZT4KLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFRPS0VOUwogICA9PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KOnJvb3R7CiAgLS1iZy12b2lkOiMwNTA2MEI7CiAgLS1iZy1iYXNlOiMwODBBMTM7CiAgLS1iZy1zdXJmYWNlOiMwRDExMjA7CiAgLS1iZy1lbGV2YXRlZDojMTMxODI5OwogIC0tYmctZWxl",
  "dmF0ZWQtMjojMTcxRDMyOwogIC0tYm9yZGVyLWhhaXI6cmdiYSgxNTgsMTcxLDIxNCwwLjEwKTsKICAtLWJvcmRlci1zb2Z0OnJnYmEoMTU4LDE3MSwyMTQsMC4xNik7CiAgLS1ib3JkZXItc3Ryb25nOnJnYmEoMTU4LDE3MSwyMTQsMC4yNik7CgogIC0taW5kaWdv",
  "LTkwMDojMEIwRTFFOwogIC0taW5kaWdvLTcwMDojMUEyMTQwOwogIC0tYmx1ZTojNEM3REZGOwogIC0tYmx1ZS1zb2Z0OiM3REEwRkY7CiAgLS12aW9sZXQ6IzhCNkJGMDsKICAtLXZpb2xldC1zb2Z0OiNBOThDRkY7CiAgLS1jeWFuOiMzMUQ1RUU7CgogIC0tcG9z",
  "OiMzM0Q2QTY7CiAgLS1wb3Mtc29mdDojOEZGMEQ0OwogIC0tcG9zLWJnOnJnYmEoNTEsMjE0LDE2NiwwLjEwKTsKICAtLW5lZzojRkI2QjZCOwogIC0tbmVnLXNvZnQ6I0ZGOUI5QjsKICAtLW5lZy1iZzpyZ2JhKDI1MSwxMDcsMTA3LDAuMTApOwoKICAtLXRleHQt",
  "aGk6I0YzRjVGQzsKICAtLXRleHQtbWlkOiNBRUI2RDQ7CiAgLS10ZXh0LWxvOiM2QjczOTg7CiAgLS10ZXh0LWZhaW50OiM0NTRDNkU7CgogIC0tcmFkaXVzLXM6OHB4OwogIC0tcmFkaXVzLW06MTJweDsKICAtLXJhZGl1cy1sOjE4cHg7CiAgLS1yYWRpdXMteGw6",
  "MjZweDsKCiAgLS1mb250LXVpOidNYW5yb3BlJywtYXBwbGUtc3lzdGVtLEJsaW5rTWFjU3lzdGVtRm9udCwnU2Vnb2UgVUknLHNhbnMtc2VyaWY7CiAgLS1mb250LW51bTonSmV0QnJhaW5zIE1vbm8nLCdTRiBNb25vJyxDb25zb2xhcyxtb25vc3BhY2U7CgogIC0t",
  "ZWFzZS1vdXQ6Y3ViaWMtYmV6aWVyKC4xNiwxLC4zLDEpOwogIC0tZWFzZS1zcHJpbmc6Y3ViaWMtYmV6aWVyKC4zNCwxLjU2LC42NCwxKTsKCiAgY29sb3Itc2NoZW1lOiBkYXJrOwp9CgpAbWVkaWEgKHByZWZlcnMtY29sb3Itc2NoZW1lOiBsaWdodCl7CiAgOnJv",
  "b3Q6bm90KFtkYXRhLXRoZW1lPSJkYXJrIl0pewogICAgLS1iZy12b2lkOiNGM0Y0Rjk7IC0tYmctYmFzZTojRURFRkY2OyAtLWJnLXN1cmZhY2U6I0ZGRkZGRjsgLS1iZy1lbGV2YXRlZDojRkZGRkZGOyAtLWJnLWVsZXZhdGVkLTI6I0Y2RjdGQzsKICAgIC0tYm9y",
  "ZGVyLWhhaXI6cmdiYSgzMCwzNSw3MCwwLjA4KTsgLS1ib3JkZXItc29mdDpyZ2JhKDMwLDM1LDcwLDAuMTMpOyAtLWJvcmRlci1zdHJvbmc6cmdiYSgzMCwzNSw3MCwwLjIyKTsKICAgIC0tdGV4dC1oaTojMTIxNDJBOyAtLXRleHQtbWlkOiM0QzUxNzA7IC0tdGV4",
  "dC1sbzojODY4Q0FEOyAtLXRleHQtZmFpbnQ6I0I3QkJENDsKICAgIGNvbG9yLXNjaGVtZTogbGlnaHQ7CiAgfQp9Cjpyb290W2RhdGEtdGhlbWU9ImRhcmsiXXsKICAtLWJnLXZvaWQ6IzA1MDYwQjsgLS1iZy1iYXNlOiMwODBBMTM7IC0tYmctc3VyZmFjZTojMEQx",
  "MTIwOyAtLWJnLWVsZXZhdGVkOiMxMzE4Mjk7IC0tYmctZWxldmF0ZWQtMjojMTcxRDMyOwogIC0tdGV4dC1oaTojRjNGNUZDOyAtLXRleHQtbWlkOiNBRUI2RDQ7IC0tdGV4dC1sbzojNkI3Mzk4OyAtLXRleHQtZmFpbnQ6IzQ1NEM2RTsKICBjb2xvci1zY2hlbWU6",
  "IGRhcms7Cn0KCiosKjo6YmVmb3JlLCo6OmFmdGVye2JveC1zaXppbmc6Ym9yZGVyLWJveDt9Cmh0bWwsYm9keXtoZWlnaHQ6MTAwJTt9CmJvZHl7CiAgbWFyZ2luOjA7CiAgYmFja2dyb3VuZDp2YXIoLS1iZy12b2lkKTsKICBjb2xvcjp2YXIoLS10ZXh0LWhpKTsK",
  "ICBmb250LWZhbWlseTp2YXIoLS1mb250LXVpKTsKICAtd2Via2l0LWZvbnQtc21vb3RoaW5nOmFudGlhbGlhc2VkOwogIG92ZXJmbG93LXg6aGlkZGVuOwogIG1pbi1oZWlnaHQ6MTAwdmg7Cn0KOjpzZWxlY3Rpb257YmFja2dyb3VuZDpyZ2JhKDc2LDEyNSwyNTUs",
  "MC4zNSk7Y29sb3I6I2ZmZjt9CmF7Y29sb3I6aW5oZXJpdDt0ZXh0LWRlY29yYXRpb246bm9uZTt9CmJ1dHRvbntmb250LWZhbWlseTppbmhlcml0O30KOjotd2Via2l0LXNjcm9sbGJhcnt3aWR0aDoxMHB4O2hlaWdodDoxMHB4O30KOjotd2Via2l0LXNjcm9sbGJh",
  "ci10cmFja3tiYWNrZ3JvdW5kOnRyYW5zcGFyZW50O30KOjotd2Via2l0LXNjcm9sbGJhci10aHVtYntiYWNrZ3JvdW5kOnZhcigtLWJvcmRlci1zdHJvbmcpO2JvcmRlci1yYWRpdXM6OHB4O30KCi50YWJ1bGFye2ZvbnQtdmFyaWFudC1udW1lcmljOnRhYnVsYXIt",
  "bnVtcztmb250LWZlYXR1cmUtc2V0dGluZ3M6InRudW0iIDE7fQoubW9ub3tmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7fQoKQG1lZGlhIChwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpewogICosKjo6YmVmb3JlLCo6OmFmdGVye2FuaW1hdGlvbi1k",
  "dXJhdGlvbjowLjAwMW1zICFpbXBvcnRhbnQ7YW5pbWF0aW9uLWl0ZXJhdGlvbi1jb3VudDoxICFpbXBvcnRhbnQ7dHJhbnNpdGlvbi1kdXJhdGlvbjowLjAwMW1zICFpbXBvcnRhbnQ7fQp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT0KICAgQU1CSUVOVCBCQUNLR1JPVU5ECiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouYW1iaWVudHsKICBwb3NpdGlvbjpmaXhlZDtpbnNldDowO3ot",
  "aW5kZXg6MDtwb2ludGVyLWV2ZW50czpub25lO292ZXJmbG93OmhpZGRlbjsKfQouYW1iaWVudDo6YmVmb3JlewogIGNvbnRlbnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6LTIwJTsKICBiYWNrZ3JvdW5kOgogICAgcmFkaWFsLWdyYWRpZW50KDQ4JSAzOCUg",
  "YXQgMTglIDglLCByZ2JhKDc2LDEyNSwyNTUsMC4xNiksIHRyYW5zcGFyZW50IDYwJSksCiAgICByYWRpYWwtZ3JhZGllbnQoNDAlIDM0JSBhdCA4NiUgMTglLCByZ2JhKDEzOSwxMDcsMjQwLDAuMTQpLCB0cmFuc3BhcmVudCA2MCUpLAogICAgcmFkaWFsLWdyYWRp",
  "ZW50KDUwJSA0MCUgYXQgNTAlIDEwMCUsIHJnYmEoNDksMjEzLDIzOCwwLjA2KSwgdHJhbnNwYXJlbnQgNjAlKTsKICBhbmltYXRpb246ZHJpZnRHbG93IDI2cyBlYXNlLWluLW91dCBpbmZpbml0ZSBhbHRlcm5hdGU7Cn0KLmFtYmllbnQ6OmFmdGVyewogIGNvbnRl",
  "bnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6LTMwJTsKICBiYWNrZ3JvdW5kOmNvbmljLWdyYWRpZW50KGZyb20gMGRlZyBhdCA1MCUgMzAlLCByZ2JhKDc2LDEyNSwyNTUsMC4wNSksIHJnYmEoMTM5LDEwNywyNDAsMC4wNSksIHJnYmEoNDksMjEzLDIzOCww",
  "LjA0KSwgcmdiYSg3NiwxMjUsMjU1LDAuMDUpKTsKICBhbmltYXRpb246cm90YXRlR2xvdyA2MHMgbGluZWFyIGluZmluaXRlOwogIG9wYWNpdHk6MC42Owp9CkBrZXlmcmFtZXMgZHJpZnRHbG93ewogIDAle3RyYW5zZm9ybTp0cmFuc2xhdGUzZCgwLDAsMCkgc2Nh",
  "bGUoMSk7fQogIDEwMCV7dHJhbnNmb3JtOnRyYW5zbGF0ZTNkKC0yJSwyJSwwKSBzY2FsZSgxLjA2KTt9Cn0KQGtleWZyYW1lcyByb3RhdGVHbG93ewogIDAle3RyYW5zZm9ybTpyb3RhdGUoMGRlZyk7fQogIDEwMCV7dHJhbnNmb3JtOnJvdGF0ZSgzNjBkZWcpO30K",
  "fQouYW1iaWVudC1ncmlkewogIHBvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7b3BhY2l0eTowLjM1OwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQodmFyKC0tYm9yZGVyLWhhaXIpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVh",
  "ci1ncmFkaWVudCg5MGRlZywgdmFyKC0tYm9yZGVyLWhhaXIpIDFweCwgdHJhbnNwYXJlbnQgMXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6NjRweCA2NHB4OwogIG1hc2staW1hZ2U6cmFkaWFsLWdyYWRpZW50KDcwJSA2MCUgYXQgNTAlIDIwJSwgYmxhY2ssIHRyYW5z",
  "cGFyZW50IDg1JSk7Cn0KLmFtYmllbnQtbGluZXN7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MDtvcGFjaXR5OjAuNTt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSEVBREVSCiAgID09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpoZWFkZXIudG9wYmFyewogIHBvc2l0aW9uOnN0aWNreTt0b3A6MDt6LWluZGV4OjUwOwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2Fw",
  "OjI4cHg7CiAgcGFkZGluZzowIDI4cHg7aGVpZ2h0OjY0cHg7CiAgYmFja2dyb3VuZDpyZ2JhKDgsMTAsMTksMC41NSk7CiAgYmFja2Ryb3AtZmlsdGVyOmJsdXIoMThweCkgc2F0dXJhdGUoMTQwJSk7CiAgLXdlYmtpdC1iYWNrZHJvcC1maWx0ZXI6Ymx1cigxOHB4",
  "KSBzYXR1cmF0ZSgxNDAlKTsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB0cmFuc3BhcmVudDsKICB0cmFuc2l0aW9uOmJhY2tncm91bmQgLjM1cyB2YXIoLS1lYXNlLW91dCksIGJvcmRlci1jb2xvciAuMzVzIHZhcigtLWVhc2Utb3V0KSwgYm94LXNoYWRvdyAu",
  "MzVzIHZhcigtLWVhc2Utb3V0KTsKfQpoZWFkZXIudG9wYmFyLnNjcm9sbGVkewogIGJhY2tncm91bmQ6cmdiYSg4LDEwLDE5LDAuODYpOwogIGJvcmRlci1ib3R0b20tY29sb3I6dmFyKC0tYm9yZGVyLWhhaXIpOwogIGJveC1zaGFkb3c6MCAxMnB4IDMwcHggLTE4",
  "cHggcmdiYSgwLDAsMCwwLjYpOwp9Ci5icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMXB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzotMC4wMWVtO2ZvbnQtc2l6ZToxOHB4O2ZsZXgtc2hyaW5rOjA7fQouYnJhbmQtbWFy",
  "a3sKICB3aWR0aDozMnB4O2hlaWdodDozMnB4O2JvcmRlci1yYWRpdXM6OXB4O3Bvc2l0aW9uOnJlbGF0aXZlO2ZsZXgtc2hyaW5rOjA7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTUwZGVnLHZhcigtLWluZGlnby03MDApLHZhcigtLWJnLWVsZXZhdGVk",
  "LTIpKTsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTsKICBib3gtc2hhZG93OjAgNnB4IDE4cHggLThweCByZ2JhKDc2LDEyNSwyNTUsMC41NSk7CiAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2Vu",
  "dGVyOwp9Ci5icmFuZC1tYXJrIHN2Z3t3aWR0aDoxOXB4O2hlaWdodDoxOXB4O2Rpc3BsYXk6YmxvY2s7fQouYnJhbmQtd29yZG1hcmt7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtsaW5lLWhlaWdodDoxLjE1O30KLmJyYW5kLXdvcmRtYXJrIC5l",
  "cXtjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5icmFuZC13b3JkbWFyayAuc2NhbnsKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMjBkZWcsdmFyKC0tYmx1ZS1zb2Z0KSx2YXIoLS12aW9sZXQtc29mdCkpOwogIC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOnRl",
  "eHQ7YmFja2dyb3VuZC1jbGlwOnRleHQ7Y29sb3I6dHJhbnNwYXJlbnQ7Cn0KLmJyYW5kIHNtYWxse2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6OS41cHg7bGV0dGVyLXNwYWNpbmc6MC4xZW07ZGlzcGxheTpibG9jazttYXJn",
  "aW4tdG9wOjFweDt9CgpuYXYubWFpbm5hdntkaXNwbGF5OmZsZXg7Z2FwOjRweDtmbGV4OjE7fQpuYXYubWFpbm5hdiBidXR0b257CiAgYmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLXRleHQtbWlkKTtmb250LXNpemU6MTRweDtmb250LXdl",
  "aWdodDo2MDA7CiAgcGFkZGluZzo4cHggMTRweDtib3JkZXItcmFkaXVzOjlweDtjdXJzb3I6cG9pbnRlcjtwb3NpdGlvbjpyZWxhdGl2ZTsKICB0cmFuc2l0aW9uOmNvbG9yIC4ycyB2YXIoLS1lYXNlLW91dCksIGJhY2tncm91bmQgLjJzIHZhcigtLWVhc2Utb3V0",
  "KTsKfQpuYXYubWFpbm5hdiBidXR0b246aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dC1oaSk7YmFja2dyb3VuZDp2YXIoLS1ib3JkZXItaGFpcik7fQpuYXYubWFpbm5hdiBidXR0b24uYWN0aXZle2NvbG9yOnZhcigtLXRleHQtaGkpO30KbmF2Lm1haW5uYXYgYnV0dG9u",
  "LmFjdGl2ZTo6YWZ0ZXJ7CiAgY29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjE0cHg7cmlnaHQ6MTRweDtib3R0b206MnB4O2hlaWdodDoycHg7Ym9yZGVyLXJhZGl1czoycHg7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0t",
  "Ymx1ZSksdmFyKC0tdmlvbGV0KSk7Cn0KCi5oZWFkZXItcmlnaHR7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTJweDtmbGV4LXNocmluazowO30KLm1hcmtldC1waWxsewogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjdw",
  "eDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OTlweDsKICBiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7Zm9udC13",
  "ZWlnaHQ6NjAwOwp9Ci5kb3QtbGl2ZXt3aWR0aDo2cHg7aGVpZ2h0OjZweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLXBvcyk7Ym94LXNoYWRvdzowIDAgMCAzcHggdmFyKC0tcG9zLWJnKTthbmltYXRpb246cHVsc2VEb3QgMnMgZWFzZS1pbi1v",
  "dXQgaW5maW5pdGU7fQpAa2V5ZnJhbWVzIHB1bHNlRG90ezAlLDEwMCV7b3BhY2l0eToxO301MCV7b3BhY2l0eTouNDU7fX0KCi5pY29uLWJ0bnsKICB3aWR0aDozNnB4O2hlaWdodDozNnB4O2JvcmRlci1yYWRpdXM6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigt",
  "LWJvcmRlci1oYWlyKTtiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkKTsKICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6dmFyKC0tdGV4dC1taWQpO2N1cnNvcjpwb2ludGVyOwogIHRyYW5zaXRp",
  "b246YWxsIC4xOHMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5pY29uLWJ0bjpob3Zlcntjb2xvcjp2YXIoLS10ZXh0LWhpKTtib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyLXNvZnQpO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpO30KLmljb24tYnRuIHN2Z3t3aWR0aDox",
  "NnB4O2hlaWdodDoxNnB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBMQVlPVVQKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09ICovCm1haW57cG9zaXRpb246cmVsYXRpdmU7ei1pbmRleDoxO21heC13aWR0aDoxMzIwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjM2cHggMjhweCAxMjBweDt9Ci52aWV3e2FuaW1hdGlvbjp2aWV3SW4gLjQ4cyB2YXIoLS1lYXNlLW91dCk7fQpAa2V5",
  "ZnJhbWVzIHZpZXdJbntmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgxMHB4KSBzY2FsZSgwLjk5KTtmaWx0ZXI6Ymx1cig0cHgpO310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCkgc2NhbGUoMSk7ZmlsdGVyOmJsdXIoMCk7fX0K",
  "LnNlY3Rpb24taGVhZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6YmFzZWxpbmU7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luOjAgMCAxNnB4O30KLnNlY3Rpb24taGVhZCBoMntmb250LXNpemU6MTVweDtmb250LXdlaWdodDo3MDA7Y29sb3I6",
  "dmFyKC0tdGV4dC1oaSk7bWFyZ2luOjA7bGV0dGVyLXNwYWNpbmc6LTAuMDFlbTtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo5cHg7fQouc2VjdGlvbi1oZWFkIGgyOjpiZWZvcmV7Y29udGVudDoiIjt3aWR0aDozcHg7aGVpZ2h0OjE0cHg7Ym9y",
  "ZGVyLXJhZGl1czoycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHZhcigtLWJsdWUpLHZhcigtLXZpb2xldCkpO2ZsZXgtc2hyaW5rOjA7fQouc2VjdGlvbi1oZWFkIC5zdWJ7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEyLjVweDt9",
  "CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgR0xBU1MgQ0FSRCBCQVNFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAq",
  "LwouZ2xhc3N7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLCB2YXIoLS1iZy1lbGV2YXRlZCksIHZhcigtLWJnLXN1cmZhY2UpKTsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTsKICBib3JkZXItcmFkaXVzOnZhcigtLXJh",
  "ZGl1cy1sKTsKICBwb3NpdGlvbjpyZWxhdGl2ZTsKfQouZ2xhc3M6OmJlZm9yZXsKICBjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7Ym9yZGVyLXJhZGl1czppbmhlcml0O3BhZGRpbmc6MXB4O3BvaW50ZXItZXZlbnRzOm5vbmU7CiAgYmFja2dy",
  "b3VuZDpsaW5lYXItZ3JhZGllbnQoMTYwZGVnLCByZ2JhKDI1NSwyNTUsMjU1LDAuMDYpLCB0cmFuc3BhcmVudCA0MCUpOwogIC13ZWJraXQtbWFzazpsaW5lYXItZ3JhZGllbnQoIzAwMCAwIDApIGNvbnRlbnQtYm94LCBsaW5lYXItZ3JhZGllbnQoIzAwMCAwIDAp",
  "OwogIC13ZWJraXQtbWFzay1jb21wb3NpdGU6eG9yO21hc2stY29tcG9zaXRlOmV4Y2x1ZGU7Cn0KLmdsYXNzOjphZnRlcnsKICBjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO3RvcDowO2xlZnQ6MTIlO3JpZ2h0OjEyJTtoZWlnaHQ6MXB4O3BvaW50ZXItZXZl",
  "bnRzOm5vbmU7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsIHRyYW5zcGFyZW50LCByZ2JhKDEyNCwxNTAsMjU1LDAuMzUpLCByZ2JhKDE2OCwxNDAsMjU1LDAuMzUpLCB0cmFuc3BhcmVudCk7CiAgb3BhY2l0eTowLjU7dHJhbnNpdGlvbjpvcGFj",
  "aXR5IC4yNXMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5pbmRleC1jYXJkOmhvdmVyOjphZnRlciwgLnRyZW5kaW5nLWNhcmQ6aG92ZXI6OmFmdGVyLCAud2F0Y2gtY2FyZDpob3Zlcjo6YWZ0ZXIsIC5zdG9jay1jYXJkOmhvdmVyOjphZnRlcntvcGFjaXR5OjE7fQoKLyog",
  "TGlnaHQtc3dlZXAgc2hpbW1lciBvbiBob3ZlciBmb3IgdGhlIHByaW1hcnkgaW50ZXJhY3RpdmUgY2FyZHMgKi8KLmluZGV4LWNhcmQsIC50cmVuZGluZy1jYXJkLCAud2F0Y2gtY2FyZHtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47fQouaW5kZXgt",
  "Y2FyZCAuc3dlZXAsIC50cmVuZGluZy1jYXJkIC5zd2VlcCwgLndhdGNoLWNhcmQgLnN3ZWVwewogIGNvbnRlbnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7dG9wOjA7bGVmdDotNjAlO3dpZHRoOjQwJTtoZWlnaHQ6MTAwJTtwb2ludGVyLWV2ZW50czpub25lOwogIGJh",
  "Y2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEwMGRlZywgdHJhbnNwYXJlbnQsIHJnYmEoMjU1LDI1NSwyNTUsMC4wNiksIHRyYW5zcGFyZW50KTsKICB0cmFuc2l0aW9uOmxlZnQgLjdzIHZhcigtLWVhc2Utb3V0KTsKfQouaW5kZXgtY2FyZDpob3ZlciAuc3dlZXAs",
  "IC50cmVuZGluZy1jYXJkOmhvdmVyIC5zd2VlcCwgLndhdGNoLWNhcmQ6aG92ZXIgLnN3ZWVwe2xlZnQ6MTIwJTt9CmJ1dHRvbiwgLmluZGV4LWNhcmQsIC50cmVuZGluZy1jYXJkLCAud2F0Y2gtY2FyZCwgLnN0b2NrLWNhcmQsIHRyW2RhdGEtdGlja2VyXSwgLnRv",
  "Z2dsZS1idG4sIC5yYW5nZS10YWJzIGJ1dHRvbiwgLmZpbHRlci1jaGlwewogIC13ZWJraXQtdGFwLWhpZ2hsaWdodC1jb2xvcjp0cmFuc3BhcmVudDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09CiAgIEhFUk8gLyBJTkRJQ0VTCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouaGVyby1yb3d7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpO2dh",
  "cDoxNHB4O21hcmdpbi1ib3R0b206MzRweDt9Ci5pbmRleC1jYXJkewogIHBhZGRpbmc6MjBweCAyMnB4O292ZXJmbG93OmhpZGRlbjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMjVzIHZhcigtLWVhc2Utb3V0KSwgYm9yZGVyLWNvbG9yIC4yNXMgdmFyKC0tZWFzZS1v",
  "dXQpOwp9Ci5pbmRleC1jYXJkOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjp2YXIoLS1ib3JkZXItc29mdCk7fQouaW5kZXgtY2FyZCAucm93MXtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxp",
  "Z24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE0cHg7fQouaW5kZXgtbmFtZXtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7bGV0dGVyLXNwYWNpbmc6MC4wMWVtO30KLmluZGV4LWZ1bGx7Zm9udC1z",
  "aXplOjEwLjVweDtjb2xvcjp2YXIoLS10ZXh0LWZhaW50KTttYXJnaW4tdG9wOjJweDt9Ci5pbmRleC1iYWRnZXtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7cGFkZGluZzozcHggOHB4O2JvcmRlci1yYWRpdXM6N3B4O2Rpc3BsYXk6ZmxleDthbGlnbi1p",
  "dGVtczpjZW50ZXI7Z2FwOjRweDt9Ci5pbmRleC1iYWRnZS5wb3N7Y29sb3I6dmFyKC0tcG9zKTtiYWNrZ3JvdW5kOnZhcigtLXBvcy1iZyk7fQouaW5kZXgtYmFkZ2UubmVne2NvbG9yOnZhcigtLW5lZyk7YmFja2dyb3VuZDp2YXIoLS1uZWctYmcpO30KLmluZGV4",
  "LXZhbHVle2ZvbnQtc2l6ZToyOHB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzotMC4wMmVtO30KLmluZGV4LXZhbHVlLWdyYWRpZW50e2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE2MGRlZyx2YXIoLS10ZXh0LWhpKSx2YXIoLS10ZXh0LW1pZCkp",
  "Oy13ZWJraXQtYmFja2dyb3VuZC1jbGlwOnRleHQ7YmFja2dyb3VuZC1jbGlwOnRleHQ7Y29sb3I6dHJhbnNwYXJlbnQ7fQouaW5kZXgtY2hhbmdle2ZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0OjYwMDttYXJnaW4tdG9wOjRweDt9Ci5pbmRleC1jaGFuZ2UucG9z",
  "e2NvbG9yOnZhcigtLXBvcy1zb2Z0KTt9Ci5pbmRleC1jaGFuZ2UubmVne2NvbG9yOnZhcigtLW5lZy1zb2Z0KTt9Ci5pbmRleC1zcGFya3ttYXJnaW4tdG9wOjE0cHg7aGVpZ2h0OjM2cHg7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNFQVJDSAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLnNlYXJjaC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO21hcmdpbi1ib3R0b206Mzhw",
  "eDt9Ci5zZWFyY2gtYm94ewogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjEwcHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMtbSk7CiAgYmFja2dyb3VuZDpyZ2JhKDE5LDI0LDQxLDAuNzUpO2JhY2tkcm9w",
  "LWZpbHRlcjpibHVyKDEycHgpOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4yMnMgdmFyKC0tZWFzZS1vdXQpLCBib3gtc2hhZG93IC4yMnMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5zZWFyY2gt",
  "Ym94LmZvY3VzZWR7CiAgYm9yZGVyLWNvbG9yOnJnYmEoMTI0LDE1MCwyNTUsMC41NSk7CiAgYm94LXNoYWRvdzowIDAgMCA0cHggcmdiYSg3NiwxMjUsMjU1LDAuMTApLCAwIDE4cHggNDBweCAtMjBweCByZ2JhKDc2LDEyNSwyNTUsMC4zNSk7Cn0KLnNlYXJjaC1i",
  "b3ggc3Zne3dpZHRoOjE3cHg7aGVpZ2h0OjE3cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7ZmxleC1zaHJpbms6MDt9Ci5zZWFyY2gtYm94IGlucHV0ewogIGZsZXg6MTtiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7b3V0bGluZTpub25lO2NvbG9yOnZhcigtLXRl",
  "eHQtaGkpO2ZvbnQtc2l6ZToxNC41cHg7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC11aSk7Cn0KLnNlYXJjaC1ib3ggaW5wdXQ6OnBsYWNlaG9sZGVye2NvbG9yOnZhcigtLXRleHQtbG8pO30Ka2JkLmtzaG9ydGN1dHsKICBmb250LWZhbWlseTp2YXIoLS1mb250LW51",
  "bSk7Zm9udC1zaXplOjExcHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7CiAgcGFkZGluZzoycHggN3B4O2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7Cn0KLnNlYXJjaC1k",
  "cm9wewogIHBvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDtyaWdodDowO3RvcDpjYWxjKDEwMCUgKyA4cHgpO3otaW5kZXg6NDA7CiAgYm9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMtbSk7b3ZlcmZsb3c6aGlkZGVuOwogIGJhY2tncm91bmQ6dmFyKC0tYmctZWxldmF0",
  "ZWQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIGJveC1zaGFkb3c6MCAyNHB4IDYwcHggLTIycHggcmdiYSgwLDAsMCwwLjY1KTsKICBtYXgtaGVpZ2h0OjM0MHB4O292ZXJmbG93LXk6YXV0bzsKfQouc2VhcmNoLXJvd3sKICBkaXNwbGF5",
  "OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO3BhZGRpbmc6MTFweCAxNnB4O2N1cnNvcjpwb2ludGVyOwogIGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTsKICBhbmltYXRpb246cm93",
  "SW4gLjI4cyB2YXIoLS1lYXNlLW91dCkgYm90aDsKICB0cmFuc2l0aW9uOmJhY2tncm91bmQgLjE1czsKfQouc2VhcmNoLXJvdzpob3ZlcntiYWNrZ3JvdW5kOnZhcigtLWJvcmRlci1oYWlyKTt9Ci5zZWFyY2gtcm93Omxhc3QtY2hpbGR7Ym9yZGVyLWJvdHRvbTpu",
  "b25lO30KQGtleWZyYW1lcyByb3dJbntmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtNHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDApO319Ci5zci1sZWZ0e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2Fw",
  "OjExcHg7fQouc3ItdGlja2VyewogIHdpZHRoOjM2cHg7aGVpZ2h0OjM2cHg7Ym9yZGVyLXJhZGl1czo5cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyOwogIGZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0Ojgw",
  "MDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTUwZGVnLHZhcigtLWluZGlnby03MDApLHZhcigtLWJnLWVsZXZhdGVkLTIpKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtjb2xvcjp2",
  "YXIoLS1ibHVlLXNvZnQpOwp9Ci5zci1uYW1le2ZvbnQtc2l6ZToxMy41cHg7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLXRleHQtaGkpO30KLnNyLW1ldGF7Zm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS10ZXh0LWxvKTt9Ci5zci1wcmljZXtmb250LXNp",
  "emU6MTMuNXB4O2ZvbnQtd2VpZ2h0OjcwMDt9Ci5zZWFyY2gtZW1wdHl7cGFkZGluZzoyNnB4IDE2cHg7dGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEzcHg7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNDUkVFTkVSIEZJTFRFUlMKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5maWx0ZXJzLWJhcnsKICBkaXNwbGF5OmZsZXg7Zmxl",
  "eC13cmFwOndyYXA7Z2FwOjEwcHg7cGFkZGluZzoxNnB4O21hcmdpbi1ib3R0b206MjBweDsKfQouZmlsdGVyLWNoaXB7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6NHB4O3BhZGRpbmc6OXB4IDE0cHg7Ym9yZGVyLXJhZGl1czp2YXIo",
  "LS1yYWRpdXMtcyk7CiAgYmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTttaW4td2lkdGg6MTUwcHg7Cn0KLmZpbHRlci1jaGlwIGxhYmVse2ZvbnQtc2l6ZToxMC41cHg7Y29sb3I6dmFyKC0tdGV4dC1s",
  "byk7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOjAuMDJlbTt9Ci5maWx0ZXItY2hpcCBzZWxlY3QsIC5maWx0ZXItY2hpcCBpbnB1dFt0eXBlPXRleHRdewogIGJhY2tncm91bmQ6bm9uZTtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS10ZXh0LWhpKTtmb250",
  "LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7b3V0bGluZTpub25lO2ZvbnQtZmFtaWx5OmluaGVyaXQ7Cn0KLnJhbmdlLXNsaWRlcnstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTthcHBlYXJhbmNlOm5vbmU7d2lkdGg6MTMwcHg7aGVpZ2h0OjNweDtib3JkZXItcmFk",
  "aXVzOjNweDtiYWNrZ3JvdW5kOnZhcigtLWJvcmRlci1zb2Z0KTtvdXRsaW5lOm5vbmU7Y3Vyc29yOnBvaW50ZXI7fQoucmFuZ2Utc2xpZGVyOjotd2Via2l0LXNsaWRlci10aHVtYnstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTt3aWR0aDoxM3B4O2hlaWdodDoxM3B4",
  "O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6dmFyKC0tYmx1ZS1zb2Z0KTtib3gtc2hhZG93OjAgMCAwIDNweCByZ2JhKDc2LDEyNSwyNTUsMC4yMik7Y3Vyc29yOnBvaW50ZXI7fQoucmFuZ2UtdmFse2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NzAw",
  "O2NvbG9yOnZhcigtLWJsdWUtc29mdCk7fQoudG9nZ2xlLWdyb3Vwe2Rpc3BsYXk6ZmxleDtnYXA6NnB4O30KLnRvZ2dsZS1idG57CiAgcGFkZGluZzo1cHggMTFweDtib3JkZXItcmFkaXVzOjdweDtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo3MDA7Y3Vyc29y",
  "OnBvaW50ZXI7CiAgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7YmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7CiAgdHJhbnNpdGlvbjphbGwgLjE2cyB2YXIoLS1lYXNlLW91dCk7Cn0KLnRvZ2dsZS1idG4u",
  "YWN0aXZle2NvbG9yOiNmZmY7Ym9yZGVyLWNvbG9yOnRyYW5zcGFyZW50O2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpKTt9Ci5yZXNldC1maWx0ZXJze21hcmdpbi1sZWZ0OmF1dG87YWxpZ24tc2VsZjpj",
  "ZW50ZXI7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEyLjVweDtmb250LXdlaWdodDo3MDA7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzo4cHggNnB4O30KLnJlc2V0LWZpbHRlcnM6aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dC1oaSk7fQoKLyogPT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFRBQkxFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwoudGFibGUtd3JhcHtvdmVyZmxvdy14",
  "OmF1dG87Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMtbCk7fQp0YWJsZS5zdG9jay10YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzYwcHg7fQouc3RvY2stdGFibGUgdGhlYWQgdGh7CiAgcG9zaXRpb246c3RpY2t5",
  "O3RvcDo2NHB4O3otaW5kZXg6NTsKICB0ZXh0LWFsaWduOnJpZ2h0O2ZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjp2YXIoLS10ZXh0LWxvKTtsZXR0ZXItc3BhY2luZzowLjAyZW07CiAgcGFkZGluZzoxMnB4IDE2cHg7YmFja2dyb3VuZDpyZ2Jh",
  "KDEzLDE3LDMyLDAuOTIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEwcHgpOwogIGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTtjdXJzb3I6cG9pbnRlcjt1c2VyLXNlbGVjdDpub25lO3doaXRlLXNwYWNlOm5vd3JhcDsKfQouc3RvY2st",
  "dGFibGUgdGhlYWQgdGg6Zmlyc3QtY2hpbGQsIC5zdG9jay10YWJsZSB0aGVhZCB0aDpudGgtY2hpbGQoMil7dGV4dC1hbGlnbjpsZWZ0O30KLnN0b2NrLXRhYmxlIHRoZWFkIHRoOmhvdmVye2NvbG9yOnZhcigtLXRleHQtaGkpO30KLnN0b2NrLXRhYmxlIHRoZWFk",
  "IHRoIC5zb3J0LWluZHtvcGFjaXR5OjA7bWFyZ2luLWxlZnQ6NHB4O2ZvbnQtc2l6ZTo5cHg7dHJhbnNpdGlvbjpvcGFjaXR5IC4xNXM7fQouc3RvY2stdGFibGUgdGhlYWQgdGguc29ydGVkIC5zb3J0LWluZHtvcGFjaXR5OjE7Y29sb3I6dmFyKC0tYmx1ZS1zb2Z0",
  "KTt9Ci5zdG9jay10YWJsZSB0Ym9keSB0cnsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Y3Vyc29yOnBvaW50ZXI7CiAgdHJhbnNpdGlvbjpiYWNrZ3JvdW5kIC4xNXMgdmFyKC0tZWFzZS1vdXQpOwogIGFuaW1hdGlvbjpyb3dG",
  "YWRlIC4zcyB2YXIoLS1lYXNlLW91dCkgYm90aDsKfQouc3RvY2stdGFibGUgdGJvZHkgdHI6aG92ZXJ7YmFja2dyb3VuZDp2YXIoLS1ib3JkZXItaGFpcik7Ym94LXNoYWRvdzppbnNldCAzcHggMCAwIHZhcigtLWJsdWUtc29mdCk7fQouc3RvY2stdGFibGUgdGR7",
  "cGFkZGluZzoxM3B4IDE2cHg7dGV4dC1hbGlnbjpyaWdodDtmb250LXNpemU6MTNweDt3aGl0ZS1zcGFjZTpub3dyYXA7fQouc3RvY2stdGFibGUgdGQ6Zmlyc3QtY2hpbGQsIC5zdG9jay10YWJsZSB0ZDpudGgtY2hpbGQoMil7dGV4dC1hbGlnbjpsZWZ0O30KQGtl",
  "eWZyYW1lcyByb3dGYWRle2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTp0cmFuc2xhdGVYKC00cHgpO310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoMCk7fX0KLmNlbGwtY29tcGFueXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDox",
  "MHB4O30KLmNlbGwtdGlja2VyLWJhZGdlewogIHdpZHRoOjMwcHg7aGVpZ2h0OjMwcHg7Ym9yZGVyLXJhZGl1czo4cHg7Zm9udC1zaXplOjkuNXB4O2ZvbnQtd2VpZ2h0OjgwMDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7CiAgZGlzcGxheTpmbGV4O2FsaWdu",
  "LWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOnZhcigtLWJsdWUtc29mdCk7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTUwZGVnLHZhcigtLWluZGlnby03MDApLHZhcigtLWJnLWVsZXZhdGVkLTIpKTtib3JkZXI6MXB4IHNv",
  "bGlkIHZhcigtLWJvcmRlci1oYWlyKTtmbGV4LXNocmluazowOwp9Ci5jb21wYW55LW5hbWV7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLXRleHQtaGkpO2ZvbnQtc2l6ZToxM3B4O30KLmNvbXBhbnktc3Vie2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRl",
  "eHQtbG8pO30KLmNoYW5nZS1waWxsewogIGRpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHg7cGFkZGluZzozcHggOHB4O2JvcmRlci1yYWRpdXM6NnB4O2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTIuNXB4O2ZvbnQtZmFtaWx5",
  "OnZhcigtLWZvbnQtbnVtKTsKfQouY2hhbmdlLXBpbGwucG9ze2NvbG9yOnZhcigtLXBvcyk7YmFja2dyb3VuZDp2YXIoLS1wb3MtYmcpO30KLmNoYW5nZS1waWxsLm5lZ3tjb2xvcjp2YXIoLS1uZWcpO2JhY2tncm91bmQ6dmFyKC0tbmVnLWJnKTt9Ci5zdGFyLWJ0",
  "bntiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6dmFyKC0tdGV4dC1mYWludCk7cGFkZGluZzo0cHg7dHJhbnNpdGlvbjphbGwgLjJzIHZhcigtLWVhc2Utc3ByaW5nKTt9Ci5zdGFyLWJ0bjpob3Zlcntjb2xvcjp2YXIoLS10",
  "ZXh0LW1pZCk7dHJhbnNmb3JtOnNjYWxlKDEuMTUpO30KLnN0YXItYnRuLmFjdGl2ZXtjb2xvcjojRkZDODU3O30KLnN0YXItYnRuIHN2Z3t3aWR0aDoxNnB4O2hlaWdodDoxNnB4O30KCi8qIG1vYmlsZSBjYXJkcyAqLwouc3RvY2stY2FyZHN7ZGlzcGxheTpub25l",
  "O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6MTBweDt9Ci5zdG9jay1jYXJkewogIHBhZGRpbmc6MTRweCAxNnB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjEycHg7CiAgYW5pbWF0aW9u",
  "OnJvd0ZhZGUgLjNzIHZhcigtLWVhc2Utb3V0KSBib3RoOwp9Ci5zdG9jay1jYXJkIC5sZWZ0e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjExcHg7bWluLXdpZHRoOjA7fQouc3RvY2stY2FyZCAubmFtZS1ibG9ja3ttaW4td2lkdGg6MDt9Ci5z",
  "dG9jay1jYXJkIC5jb21wYW55LW5hbWV7ZGlzcGxheTpibG9jaztvdmVyZmxvdzpoaWRkZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpczt3aGl0ZS1zcGFjZTpub3dyYXA7bWF4LXdpZHRoOjEzMHB4O30KLnN0b2NrLWNhcmQgLnJpZ2h0e3RleHQtYWxpZ246cmlnaHQ7",
  "ZmxleC1zaHJpbms6MDt9Ci5zdG9jay1jYXJkIC5wcmljZXtmb250LXNpemU6MTQuNXB4O2ZvbnQtd2VpZ2h0OjcwMDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09CiAgIFNUT0NLIERFVEFJTAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLmRldGFpbC1oZWFke2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2Vl",
  "bjthbGlnbi1pdGVtczpmbGV4LXN0YXJ0O2ZsZXgtd3JhcDp3cmFwO2dhcDoyMHB4O21hcmdpbi1ib3R0b206MjZweDt9Ci5kZXRhaWwtdGl0bGUtcm93e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjE0cHg7fQouZGV0YWlsLXRpY2tlci1iYWRn",
  "ZXsKICB3aWR0aDo1MnB4O2hlaWdodDo1MnB4O2JvcmRlci1yYWRpdXM6MTRweDtmb250LXNpemU6MTVweDtmb250LXdlaWdodDo4MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pOwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1j",
  "b250ZW50OmNlbnRlcjtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpOwogIGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE1MGRlZyx2YXIoLS1pbmRpZ28tNzAwKSx2YXIoLS1iZy1lbGV2YXRlZC0yKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7",
  "Cn0KLmRldGFpbC1uYW1le2ZvbnQtc2l6ZToyMnB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzotMC4wMTVlbTt9Ci5kZXRhaWwtc3Vie2ZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bWFyZ2luLXRvcDoycHg7fQouZGV0YWlsLXBy",
  "aWNlLWJsb2Nre3RleHQtYWxpZ246cmlnaHQ7fQouZGV0YWlsLXByaWNle2ZvbnQtc2l6ZTozMnB4O2ZvbnQtd2VpZ2h0OjgwMDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7bGV0dGVyLXNwYWNpbmc6LTAuMDFlbTt9Ci5kZXRhaWwtY2hhbmdle2ZvbnQtc2l6",
  "ZToxNHB4O2ZvbnQtd2VpZ2h0OjcwMDttYXJnaW4tdG9wOjRweDt9CgoubWV0cmljcy1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDYsMWZyKTtnYXA6MTBweDttYXJnaW46MjRweCAwIDI4cHg7fQoubWV0cmljLWNhcmR7cGFk",
  "ZGluZzoxNHB4IDE2cHg7fQoubWV0cmljLWxhYmVse2ZvbnQtc2l6ZToxMC41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOjAuMDJlbTttYXJnaW4tYm90dG9tOjZweDt9Ci5tZXRyaWMtdmFsdWV7Zm9udC1zaXpl",
  "OjE1LjVweDtmb250LXdlaWdodDo3MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pO30KCi5jaGFydC1jYXJke3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjI4cHg7fQouY2hhcnQtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJl",
  "dHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi1ib3R0b206NnB4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxMnB4O30KLnJhbmdlLXRhYnN7ZGlzcGxheTpmbGV4O2dhcDoycHg7YmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTtwYWRkaW5nOjNweDtib3JkZXItcmFk",
  "aXVzOjlweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTt9Ci5yYW5nZS10YWJzIGJ1dHRvbnsKICBib3JkZXI6bm9uZTtiYWNrZ3JvdW5kOm5vbmU7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzAwO3Bh",
  "ZGRpbmc6NnB4IDEycHg7Ym9yZGVyLXJhZGl1czo3cHg7Y3Vyc29yOnBvaW50ZXI7CiAgdHJhbnNpdGlvbjphbGwgLjE4cyB2YXIoLS1lYXNlLW91dCk7Cn0KLnJhbmdlLXRhYnMgYnV0dG9uLmFjdGl2ZXtjb2xvcjojZmZmO2JhY2tncm91bmQ6bGluZWFyLWdyYWRp",
  "ZW50KDEzNWRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpKTt9Ci5jaGFydC1jYW52YXMtd3JhcHtwb3NpdGlvbjpyZWxhdGl2ZTtoZWlnaHQ6MjgwcHg7bWFyZ2luLXRvcDoxNHB4O30KLnZvbHVtZS13cmFwe21hcmdpbi10b3A6MTBweDt9Ci52b2x1bWUtbGFi",
  "ZWx7Zm9udC1zaXplOjEwLjVweDtjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXdlaWdodDo3MDA7bGV0dGVyLXNwYWNpbmc6MC4wMmVtO21hcmdpbi1ib3R0b206NnB4O30KI3ZvbHVtZUNoYXJ0e3dpZHRoOjEwMCU7aGVpZ2h0OjY0cHg7ZGlzcGxheTpibG9jazt9",
  "Ci5jaGFydC10b29sdGlwewogIHBvc2l0aW9uOmFic29sdXRlO3BvaW50ZXItZXZlbnRzOm5vbmU7cGFkZGluZzo4cHggMTFweDtib3JkZXItcmFkaXVzOjlweDtiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkLTIpOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0t",
  "Ym9yZGVyLXNvZnQpO2ZvbnQtc2l6ZToxMS41cHg7Ym94LXNoYWRvdzowIDE0cHggMzBweCAtMTJweCByZ2JhKDAsMCwwLDAuNik7CiAgb3BhY2l0eTowO3RyYW5zZm9ybTp0cmFuc2xhdGUoLTUwJSwtMTE1JSk7dHJhbnNpdGlvbjpvcGFjaXR5IC4xczt3aGl0ZS1z",
  "cGFjZTpub3dyYXA7ei1pbmRleDo2Owp9Ci5jaGFydC10b29sdGlwIC50dC1wcmljZXtmb250LXdlaWdodDo3MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pO2NvbG9yOnZhcigtLXRleHQtaGkpO30KLmNoYXJ0LXRvb2x0aXAgLnR0LWRhdGV7Y29sb3I6dmFy",
  "KC0tdGV4dC1sbyk7bWFyZ2luLXRvcDoycHg7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFdBVENITElTVAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT0gKi8KLndhdGNobGlzdC1ncmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTtnYXA6MTRweDt9Ci50cmVuZGluZy1yb3d7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpy",
  "ZXBlYXQoMywxZnIpO2dhcDoxNHB4O21hcmdpbi1ib3R0b206MzRweDt9Ci50cmVuZGluZy1jYXJke3BhZGRpbmc6MTZweCAxOHB4O2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246dHJhbnNmb3JtIC4ycyB2YXIoLS1lYXNlLW91dCksYm9yZGVyLWNvbG9yIC4ycyB2",
  "YXIoLS1lYXNlLW91dCk7YW5pbWF0aW9uOmNhcmRJbiAuMzhzIHZhcigtLWVhc2Utc3ByaW5nKSBib3RoO30KLnRyZW5kaW5nLWNhcmQ6aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7Ym9yZGVyLWNvbG9yOnZhcigtLWJvcmRlci1zb2Z0KTt9Ci50cmVu",
  "ZGluZy10b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjt9Ci53YXRjaC1jYXJke3BhZGRpbmc6MTZweCAxOHB4O3Bvc2l0aW9uOnJlbGF0aXZlO292ZXJmbG93OmhpZGRlbjt0cmFuc2l0aW9uOnRy",
  "YW5zZm9ybSAuMnMgdmFyKC0tZWFzZS1vdXQpO30KLndhdGNoLWNhcmQ6aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7fQoud2F0Y2gtY2FyZC5yZW1vdmluZ3thbmltYXRpb246Y2FyZE91dCAuM3MgdmFyKC0tZWFzZS1vdXQpIGZvcndhcmRzO30KQGtl",
  "eWZyYW1lcyBjYXJkT3V0e3Rve29wYWNpdHk6MDt0cmFuc2Zvcm06c2NhbGUoMC45KSB0cmFuc2xhdGVZKDZweCk7fX0KLndhdGNoLWNhcmQuZW50ZXJpbmd7YW5pbWF0aW9uOmNhcmRJbiAuMzhzIHZhcigtLWVhc2Utc3ByaW5nKSBib3RoO30KQGtleWZyYW1lcyBj",
  "YXJkSW57ZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnNjYWxlKDAuOSkgdHJhbnNsYXRlWSgxMHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTpzY2FsZSgxKSB0cmFuc2xhdGVZKDApO319Ci53YXRjaC10b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpz",
  "cGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbToxMHB4O30KLndhdGNoLWVtcHR5e3BhZGRpbmc6NjBweCAyMHB4O3RleHQtYWxpZ246Y2VudGVyO2dyaWQtY29sdW1uOjEvLTE7fQoKLyogPT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNLRUxFVE9OUwogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KQGtleWZyYW1lcyBzaGltbWVyezAle2JhY2tncm91",
  "bmQtcG9zaXRpb246LTMwMHB4IDA7fTEwMCV7YmFja2dyb3VuZC1wb3NpdGlvbjozMDBweCAwO319Ci5za2VsewogIGJvcmRlci1yYWRpdXM6OHB4OwogIGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLCB2YXIoLS1iZy1lbGV2YXRlZCkgMjUlLCB2YXIo",
  "LS1iZy1lbGV2YXRlZC0yKSA1MCUsIHZhcigtLWJnLWVsZXZhdGVkKSA3NSUpOwogIGJhY2tncm91bmQtc2l6ZTozMDBweCAxMDAlOwogIGFuaW1hdGlvbjpzaGltbWVyIDEuNXMgZWFzZS1pbi1vdXQgaW5maW5pdGU7Cn0KLnNrZWwtbGluZXtoZWlnaHQ6MTJweDtt",
  "YXJnaW4tYm90dG9tOjhweDt9Ci5za2VsLWNhcmR7aGVpZ2h0OjExMnB4O2JvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLWwpO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBFTVBUWSAv",
  "IEVSUk9SIFNUQVRFUwogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLnN0YXRlLWJveHsKICBkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2FsaWduLWl0ZW1zOmNlbnRlcjtq",
  "dXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3RleHQtYWxpZ246Y2VudGVyOwogIHBhZGRpbmc6NjRweCAyNHB4O2NvbG9yOnZhcigtLXRleHQtbWlkKTtnYXA6MTJweDsKfQouc3RhdGUtaWNvbnsKICB3aWR0aDo1MnB4O2hlaWdodDo1MnB4O2JvcmRlci1yYWRpdXM6MTRw",
  "eDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7CiAgYmFja2dyb3VuZDp2YXIoLS1iZy1lbGV2YXRlZC0yKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtjb2xvcjp2YXIoLS10ZXh0LWxvKTtt",
  "YXJnaW4tYm90dG9tOjRweDsKfQouc3RhdGUtdGl0bGV7Zm9udC1zaXplOjE0LjVweDtmb250LXdlaWdodDo3MDA7Y29sb3I6dmFyKC0tdGV4dC1oaSk7fQouc3RhdGUtc3Vie2ZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bWF4LXdpZHRoOjMy",
  "MHB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBCT1RUT00gTkFWIChtb2JpbGUpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PSAqLwouYm90dG9tLW5hdnsKICBkaXNwbGF5Om5vbmU7cG9zaXRpb246Zml4ZWQ7bGVmdDowO3JpZ2h0OjA7Ym90dG9tOjA7ei1pbmRleDo1MDsKICBiYWNrZ3JvdW5kOnJnYmEoMTAsMTMsMjMsMC45KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxOHB4KTsK",
  "ICBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7CiAgcGFkZGluZzo4cHggNnB4IGNhbGMoOHB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTsKICBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYXJvdW5kOwp9Ci5ib3R0b20tbmF2IGJ1",
  "dHRvbnsKICBiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tdGV4dC1sbyk7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjNweDsKICBmb250LXNpemU6MTBweDtmb250LXdlaWdodDo3",
  "MDA7cGFkZGluZzo2cHggMTRweDtjdXJzb3I6cG9pbnRlcjtib3JkZXItcmFkaXVzOjExcHg7CiAgdHJhbnNpdGlvbjpjb2xvciAuMThzIHZhcigtLWVhc2Utb3V0KSwgYmFja2dyb3VuZCAuMThzIHZhcigtLWVhc2Utb3V0KTsKfQouYm90dG9tLW5hdiBidXR0b24g",
  "c3Zne3dpZHRoOjE5cHg7aGVpZ2h0OjE5cHg7dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjE4cyB2YXIoLS1lYXNlLXNwcmluZyk7fQouYm90dG9tLW5hdiBidXR0b24uYWN0aXZle2NvbG9yOnZhcigtLWJsdWUtc29mdCk7YmFja2dyb3VuZDpyZ2JhKDc2LDEyNSwyNTUs",
  "MC4xMik7fQouYm90dG9tLW5hdiBidXR0b24uYWN0aXZlIHN2Z3t0cmFuc2Zvcm06dHJhbnNsYXRlWSgtMXB4KTt9CgovKiBTYXRpc2Z5aW5nIHByZXNzIGZlZWRiYWNrIOKAlCBwbGFjZWQgYWZ0ZXIgZXZlcnkgOmhvdmVyIHJ1bGUgYWJvdmUgc28gaXQKICAgd2lu",
  "cyBvbiBlcXVhbCBzcGVjaWZpY2l0eSB3aGVuIGEgcHJlc3MgaGFwcGVucyBtaWQtaG92ZXIgKG1vdXNlIHVzZXJzKS4gKi8KYnV0dG9uOmFjdGl2ZSwgLmV4cGxhaW4tYnRuOmFjdGl2ZSwgLmFpLXF1ZXJ5LWJ0bjphY3RpdmUsIC5haS1zZW5kLWJ0bjphY3RpdmUs",
  "IC5haS1mYWI6YWN0aXZlLAouaW5kZXgtY2FyZDphY3RpdmUsIC50cmVuZGluZy1jYXJkOmFjdGl2ZSwgLndhdGNoLWNhcmQ6YWN0aXZlLCAuc3RvY2stY2FyZDphY3RpdmUsCi50b2dnbGUtYnRuOmFjdGl2ZSwgLnJhbmdlLXRhYnMgYnV0dG9uOmFjdGl2ZSwgLmlj",
  "b24tYnRuOmFjdGl2ZXsKICB0cmFuc2Zvcm06c2NhbGUoMC45NikgIWltcG9ydGFudDsKICB0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMXMgdmFyKC0tZWFzZS1vdXQpICFpbXBvcnRhbnQ7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PQogICBSRVNQT05TSVZFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpAbWVkaWEgKG1heC13aWR0aDogOTgwcHgpewogIC5oZXJvLXJvd3tncmlkLXRl",
  "bXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTt9CiAgLm1ldHJpY3MtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTt9CiAgLndhdGNobGlzdC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KICAudHJlbmRp",
  "bmctcm93e2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KfQovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQUkgQVNTSVNUQU5UIOKAlCBmbG9hdGluZyBidXR0b24gKyBj",
  "aGF0IHBhbmVsLCBleHBsYWluLXN0b2NrIGNhcmQKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5haS1mYWJ7CiAgcG9zaXRpb246Zml4ZWQ7cmlnaHQ6MjJweDtib3R0b206MjJweDt6LWlu",
  "ZGV4OjYwOwogIHdpZHRoOjUycHg7aGVpZ2h0OjUycHg7Ym9yZGVyLXJhZGl1czoxNnB4O2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE1MGRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQp",
  "IDcwJSx2YXIoLS1jeWFuKSk7CiAgY29sb3I6I2ZmZjtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y3Vyc29yOnBvaW50ZXI7CiAgYm94LXNoYWRvdzowIDE0cHggMzRweCAtMTJweCByZ2JhKDc2LDEyNSwyNTUs",
  "MC41NSk7CiAgdHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzIHZhcigtLWVhc2Utc3ByaW5nKTsKICBhbmltYXRpb246ZmFiQnJlYXRoZSAzLjJzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9CkBrZXlmcmFtZXMgZmFiQnJlYXRoZXsKICAwJSwxMDAle2JveC1zaGFkb3c6",
  "MCAxNHB4IDM0cHggLTEycHggcmdiYSg3NiwxMjUsMjU1LDAuNTUpO30KICA1MCV7Ym94LXNoYWRvdzowIDE0cHggNDBweCAtOHB4IHJnYmEoMTM5LDEwNywyNDAsMC43NSk7fQp9Ci5haS1mYWI6aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCkgc2NhbGUo",
  "MS4wNik7YW5pbWF0aW9uLXBsYXktc3RhdGU6cGF1c2VkO30KLmFpLWZhYiBzdmd7d2lkdGg6MjJweDtoZWlnaHQ6MjJweDt9Ci5haS1mYWIuaGlkZGVuLCAuYWktcGFuZWwuaGlkZGVue2Rpc3BsYXk6bm9uZTt9CgouYWktcGFuZWx7CiAgcG9zaXRpb246Zml4ZWQ7",
  "cmlnaHQ6MjJweDtib3R0b206ODhweDt6LWluZGV4OjYxOwogIHdpZHRoOjM2MHB4O21heC13aWR0aDpjYWxjKDEwMHZ3IC0gMzJweCk7aGVpZ2h0Om1pbig1MjBweCwgNzB2aCk7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtib3JkZXItcmFk",
  "aXVzOnZhcigtLXJhZGl1cy1sKTtvdmVyZmxvdzpoaWRkZW47CiAgYmFja2dyb3VuZDp2YXIoLS1iZy1lbGV2YXRlZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7CiAgYm94LXNoYWRvdzowIDMwcHggNzBweCAtMjBweCByZ2JhKDAsMCwwLDAu",
  "NjUpOwogIGFuaW1hdGlvbjpwYW5lbEluIC4yOHMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5haS1wYW5lbC5oaWRkZW57ZGlzcGxheTpub25lO30KQGtleWZyYW1lcyBwYW5lbElue2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDEwcHgpIHNjYWxlKDAu",
  "OTgpO310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCkgc2NhbGUoMSk7fX0KLmFpLXBhbmVsLWhlYWR7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjEycHggMTRweDti",
  "b3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7ZmxleC1zaHJpbms6MDt9Ci5haS1hdmF0YXJ7d2lkdGg6MjhweDtoZWlnaHQ6MjhweDtib3JkZXItcmFkaXVzOjlweDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxNTBkZWcsdmFyKC0t",
  "Ymx1ZSksdmFyKC0tdmlvbGV0KSk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiNmZmY7Zm9udC1zaXplOjE0cHg7ZmxleC1zaHJpbms6MDt9Ci5haS1tZXNzYWdlc3tmbGV4OjE7b3ZlcmZsb3cteTph",
  "dXRvO3BhZGRpbmc6MTRweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDoxMHB4O30KLmFpLW1zZ3tmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyLXJhZGl1czoxMXB4O21heC13aWR0aDo4",
  "OCU7d2hpdGUtc3BhY2U6cHJlLXdyYXA7fQouYWktbXNnLmFzc2lzdGFudHtiYWNrZ3JvdW5kOnZhcigtLWJnLWJhc2UpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpO2NvbG9yOnZhcigtLXRleHQtbWlkKTthbGlnbi1zZWxmOmZsZXgtc3RhcnQ7",
  "fQouYWktbXNnLnVzZXJ7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHZhcigtLWJsdWUpLHZhcigtLXZpb2xldCkpO2NvbG9yOiNmZmY7YWxpZ24tc2VsZjpmbGV4LWVuZDt9Ci5haS1tc2cucGVuZGluZ3tjb2xvcjp2YXIoLS10ZXh0LWZhaW50KTtm",
  "b250LXN0eWxlOml0YWxpYzt9Ci5haS1tc2cuZXJyb3J7YmFja2dyb3VuZDp2YXIoLS1uZWctYmcpO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTEsMTA3LDEwNywwLjMpO2NvbG9yOnZhcigtLW5lZy1zb2Z0KTthbGlnbi1zZWxmOmZsZXgtc3RhcnQ7fQouYWktaW5w",
  "dXQtcm93e2Rpc3BsYXk6ZmxleDtnYXA6OHB4O3BhZGRpbmc6MTBweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7ZmxleC1zaHJpbms6MDt9Ci5haS1pbnB1dC1yb3cgaW5wdXR7ZmxleDoxO2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7",
  "Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6OXB4IDEycHg7Y29sb3I6dmFyKC0tdGV4dC1oaSk7Zm9udC1zaXplOjEzcHg7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC11aSk7b3V0bGluZTpub25lO30K",
  "LmFpLWlucHV0LXJvdyBpbnB1dDpmb2N1c3tib3JkZXItY29sb3I6cmdiYSgxMjQsMTUwLDI1NSwwLjUpO30KLmFpLXNlbmQtYnRue3dpZHRoOjM4cHg7aGVpZ2h0OjM4cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjpub25lO2JhY2tncm91bmQ6bGluZWFyLWdy",
  "YWRpZW50KDEzNWRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpKTtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjdXJzb3I6cG9pbnRlcjtmbGV4LXNocmluazowO30KLmFpLXNlbmQtYnRu",
  "OmRpc2FibGVke29wYWNpdHk6MC41O2N1cnNvcjpkZWZhdWx0O30KLmFpLXNlbmQtYnRuIHN2Z3t3aWR0aDoxNXB4O2hlaWdodDoxNXB4O30KCi5haS1xdWVyeS1ib3h7cGFkZGluZzoxNHB4IDE2cHg7bWFyZ2luLWJvdHRvbToxOHB4O30KLmFpLXF1ZXJ5LXJvd3tk",
  "aXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMHB4O30KLmFpLXF1ZXJ5LXJvdyBpbnB1dHsKICBmbGV4OjE7YmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtib3JkZXItcmFkaXVzOjlw",
  "eDsKICBwYWRkaW5nOjlweCAxMnB4O2NvbG9yOnZhcigtLXRleHQtaGkpO2ZvbnQtc2l6ZToxM3B4O2ZvbnQtZmFtaWx5OnZhcigtLWZvbnQtdWkpO291dGxpbmU6bm9uZTsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMThzIHZhcigtLWVhc2Utb3V0KTsKfQou",
  "YWktcXVlcnktcm93IGlucHV0OmZvY3Vze2JvcmRlci1jb2xvcjpyZ2JhKDEyNCwxNTAsMjU1LDAuNSk7fQouYWktcXVlcnktYnRuewogIHBhZGRpbmc6OXB4IDE2cHg7Ym9yZGVyLXJhZGl1czo5cHg7Ym9yZGVyOm5vbmU7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6",
  "ZToxMi41cHg7Y29sb3I6I2ZmZjtjdXJzb3I6cG9pbnRlcjsKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7ZmxleC1zaHJpbms6MDt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMTVzIHZhcigtLWVhc2Ut",
  "b3V0KTsKfQouYWktcXVlcnktYnRuOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpO30KLmFpLXF1ZXJ5LWJ0bjpkaXNhYmxlZHtvcGFjaXR5OjAuNjtjdXJzb3I6ZGVmYXVsdDt0cmFuc2Zvcm06bm9uZTt9Ci5haS1xdWVyeS1hbnN3ZXJ7bWFyZ2luLXRv",
  "cDoxMnB4O3BhZGRpbmctdG9wOjEycHg7Ym9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpO2Rpc3BsYXk6ZmxleDtnYXA6MTBweDthbGlnbi1pdGVtczpmbGV4LXN0YXJ0O2ZvbnQtc2l6ZToxM3B4O2xpbmUtaGVpZ2h0OjEuNjtjb2xvcjp2YXIo",
  "LS10ZXh0LW1pZCk7fQoKLmV4cGxhaW4tY2FyZHtwYWRkaW5nOjE4cHggMjBweDttYXJnaW4tdG9wOjE0cHg7fQouZXhwbGFpbi1oZWFke2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjlweDttYXJnaW4tYm90dG9tOjEwcHg7fQouZXhwbGFpbi10",
  "ZXh0e2ZvbnQtc2l6ZToxMy41cHg7bGluZS1oZWlnaHQ6MS42NTtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7d2hpdGUtc3BhY2U6cHJlLXdyYXA7fQouZXhwbGFpbi1idG57CiAgZGlzcGxheTppbmxpbmUtZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjdweDtwYWRk",
  "aW5nOjhweCAxNHB4O2JvcmRlci1yYWRpdXM6OXB4OwogIGJhY2tncm91bmQ6dmFyKC0tYmctZWxldmF0ZWQtMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7Y29sb3I6dmFyKC0tdGV4dC1oaSk7CiAgZm9udC1zaXplOjEyLjVweDtmb250LXdl",
  "aWdodDo3MDA7Y3Vyc29yOnBvaW50ZXI7dHJhbnNpdGlvbjphbGwgLjE4cyB2YXIoLS1lYXNlLW91dCk7Cn0KLmV4cGxhaW4tYnRuOmhvdmVye2JvcmRlci1jb2xvcjpyZ2JhKDEyNCwxNTAsMjU1LDAuNSk7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTFweCk7fQouZXhw",
  "bGFpbi1idG4gc3Zne3dpZHRoOjE0cHg7aGVpZ2h0OjE0cHg7fQouZXhwbGFpbi1idG46ZGlzYWJsZWR7b3BhY2l0eTowLjU7Y3Vyc29yOmRlZmF1bHQ7dHJhbnNmb3JtOm5vbmU7fQoKQG1lZGlhIChtYXgtd2lkdGg6IDY0MHB4KXsKICAjYmFja2VuZEJhZGdle2Rp",
  "c3BsYXk6bm9uZTt9CiAgLmFpLXBhbmVse3JpZ2h0OjEycHg7bGVmdDoxMnB4O3dpZHRoOmF1dG87Ym90dG9tOjgwcHg7fQogIC5haS1mYWJ7cmlnaHQ6MTZweDtib3R0b206NzZweDt9Cn0KQG1lZGlhIChtYXgtd2lkdGg6IDc2MHB4KXsKICBuYXYubWFpbm5hdntk",
  "aXNwbGF5Om5vbmU7fQogIGhlYWRlci50b3BiYXJ7cGFkZGluZzowIDE2cHg7aGVpZ2h0OjU4cHg7Z2FwOjE0cHg7fQogIG1haW57cGFkZGluZzoyMHB4IDE2cHggOTZweDt9CiAgLmhlcm8tcm93e2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO2dh",
  "cDoxMHB4O30KICAubWV0cmljcy1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KICAud2F0Y2hsaXN0LWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjt9CiAgLnRyZW5kaW5nLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6MWZy",
  "O30KICAudGFibGUtd3JhcHtkaXNwbGF5Om5vbmU7fQogIC5zdG9jay1jYXJkc3tkaXNwbGF5OmZsZXg7fQogIC5ib3R0b20tbmF2e2Rpc3BsYXk6ZmxleDt9CiAgLmRldGFpbC1wcmljZS1ibG9ja3t0ZXh0LWFsaWduOmxlZnQ7fQogIC5kZXRhaWwtaGVhZHtmbGV4",
  "LWRpcmVjdGlvbjpjb2x1bW47fQogIC5maWx0ZXJzLWJhcntwYWRkaW5nOjEycHg7fQogIC5maWx0ZXItY2hpcHttaW4td2lkdGg6NDQlO2ZsZXg6MTt9Cn0KPC9zdHlsZT4KPC9oZWFkPgo8Ym9keT4KCjxkaXYgY2xhc3M9ImFtYmllbnQiPgogIDxkaXYgY2xhc3M9",
  "ImFtYmllbnQtZ3JpZCI+PC9kaXY+CiAgPHN2ZyBjbGFzcz0iYW1iaWVudC1saW5lcyIgaWQ9ImFtYmllbnRMaW5lcyIgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSI+PC9zdmc+CjwvZGl2PgoKPGhlYWRlciBjbGFzcz0idG9wYmFyIiBpZD0idG9wYmFyIj4KICA8",
  "ZGl2IGNsYXNzPSJicmFuZCI+CiAgICA8ZGl2IGNsYXNzPSJicmFuZC1tYXJrIj4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiPgogICAgICAgIDxkZWZzPgogICAgICAgICAgPGxpbmVhckdyYWRpZW50IGlkPSJsb2dvR3JhZCIgeDE9",
  "IjIiIHkxPSIyMCIgeDI9IjIyIiB5Mj0iNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgogICAgICAgICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIjNEM3REZGIi8+CiAgICAgICAgICAgIDxzdG9wIG9mZnNldD0iNTUlIiBzdG9wLWNv",
  "bG9yPSIjOEI2QkYwIi8+CiAgICAgICAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iIzMxRDVFRSIvPgogICAgICAgICAgPC9saW5lYXJHcmFkaWVudD4KICAgICAgICA8L2RlZnM+CiAgICAgICAgPHJlY3QgeD0iMi41IiB5PSIxMyIgd2lkdGg9",
  "IjQiIGhlaWdodD0iOC41IiByeD0iMS4yIiBmaWxsPSJ1cmwoI2xvZ29HcmFkKSIgb3BhY2l0eT0iMC41NSIvPgogICAgICAgIDxyZWN0IHg9IjEwIiB5PSI4IiB3aWR0aD0iNCIgaGVpZ2h0PSIxMy41IiByeD0iMS4yIiBmaWxsPSJ1cmwoI2xvZ29HcmFkKSIgb3Bh",
  "Y2l0eT0iMC44Ii8+CiAgICAgICAgPHJlY3QgeD0iMTcuNSIgeT0iMi41IiB3aWR0aD0iNCIgaGVpZ2h0PSIxOSIgcng9IjEuMiIgZmlsbD0idXJsKCNsb2dvR3JhZCkiLz4KICAgICAgPC9zdmc+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImJyYW5kLXdvcmRt",
  "YXJrIj48c3Bhbj48c3BhbiBjbGFzcz0iZXEiPkVxdWl0eTwvc3Bhbj48c3BhbiBjbGFzcz0ic2NhbiI+U2Nhbjwvc3Bhbj48L3NwYW4+PHNtYWxsPk1BUktFVCBJTlRFTExJR0VOQ0U8L3NtYWxsPjwvZGl2PgogIDwvZGl2PgogIDxuYXYgY2xhc3M9Im1haW5uYXYi",
  "IGlkPSJtYWluTmF2Ij4KICAgIDxidXR0b24gZGF0YS12aWV3PSJkYXNoYm9hcmQiPkRhc2hib2FyZDwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLXZpZXc9InNjcmVlbmVyIj5TY3JlZW5lcjwvYnV0dG9uPgogICAgPGJ1dHRvbiBkYXRhLXZpZXc9Im1hcmtldHMi",
  "Pk1hcmtldHM8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS12aWV3PSJ3YXRjaGxpc3QiPldhdGNobGlzdDwvYnV0dG9uPgogIDwvbmF2PgogIDxkaXYgY2xhc3M9ImhlYWRlci1yaWdodCI+CiAgICA8ZGl2IGNsYXNzPSJtYXJrZXQtcGlsbCI+PHNwYW4gY2xhc3M9",
  "ImRvdC1saXZlIj48L3NwYW4+PHNwYW4gaWQ9Im1hcmtldFN0YXR1c1RleHQiPk1hcmtldCBPcGVuPC9zcGFuPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ibWFya2V0LXBpbGwiIGlkPSJiYWNrZW5kQmFkZ2UiIHRpdGxlPSJDaGVja2luZyBiYWNrZW5kIGNvbm5lY3Rp",
  "b27igKYiPjxzcGFuIGNsYXNzPSJkb3QtbGl2ZSI+PC9zcGFuPjxzcGFuPkNoZWNraW5n4oCmPC9zcGFuPjwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4iIGlkPSJzZWFyY2hUb2dnbGVCdG4iIHRpdGxlPSJTZWFyY2ggKC8pIj4KICAgICAgPHN2ZyB2",
  "aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNyIvPjxwYXRoIGQ9Ik0yMSAyMWwtNC4zLTQuMyIv",
  "Pjwvc3ZnPgogICAgPC9idXR0b24+CiAgICA8YnV0dG9uIGNsYXNzPSJpY29uLWJ0biIgdGl0bGU9IlNldHRpbmdzIj4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIi",
  "IHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMyIvPjxwYXRoIGQ9Ik0xOS40IDE1YTEuNjUgMS42NSAwIDAwLjMzIDEuODJsLjA2LjA2YTIgMiAwIDExLTIuODMgMi44M2wtLjA2",
  "LS4wNmExLjY1IDEuNjUgMCAwMC0xLjgyLS4zMyAxLjY1IDEuNjUgMCAwMC0xIDEuNTFWMjFhMiAyIDAgMDEtNCAwdi0uMDlBMS42NSAxLjY1IDAgMDA5IDE5LjRhMS42NSAxLjY1IDAgMDAtMS44Mi4zM2wtLjA2LjA2YTIgMiAwIDExLTIuODMtMi44M2wuMDYtLjA2",
  "QTEuNjUgMS42NSAwIDAwNC42IDE1YTEuNjUgMS42NSAwIDAwLTEuNTEtMUgzYTIgMiAwIDAxMC00aC4wOUExLjY1IDEuNjUgMCAwMDQuNiA5YTEuNjUgMS42NSAwIDAwLS4zMy0xLjgybC0uMDYtLjA2YTIgMiAwIDExMi44My0yLjgzbC4wNi4wNkExLjY1IDEuNjUg",
  "MCAwMDkgNC42YTEuNjUgMS42NSAwIDAwMS0xLjUxVjNhMiAyIDAgMDE0IDB2LjA5YTEuNjUgMS42NSAwIDAwMSAxLjUxIDEuNjUgMS42NSAwIDAwMS44Mi0uMzNsLjA2LS4wNmEyIDIgMCAxMTIuODMgMi44M2wtLjA2LjA2QTEuNjUgMS42NSAwIDAwMTkuNCA5YTEu",
  "NjUgMS42NSAwIDAwMS41MSAxSDIxYTIgMiAwIDAxMCA0aC0uMDlhMS42NSAxLjY1IDAgMDAtMS41MSAxeiIvPjwvc3ZnPgogICAgPC9idXR0b24+CiAgPC9kaXY+CjwvaGVhZGVyPgoKPG1haW4gaWQ9Im1haW5Sb290Ij48L21haW4+Cgo8bmF2IGNsYXNzPSJib3R0",
  "b20tbmF2IiBpZD0iYm90dG9tTmF2Ij4KICA8YnV0dG9uIGRhdGEtdmlldz0iZGFzaGJvYXJkIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHJlY3QgeD0iMyIgeT0iMyIg",
  "d2lkdGg9IjciIGhlaWdodD0iOSIgcng9IjEuNSIvPjxyZWN0IHg9IjE0IiB5PSIzIiB3aWR0aD0iNyIgaGVpZ2h0PSI1IiByeD0iMS41Ii8+PHJlY3QgeD0iMTQiIHk9IjEyIiB3aWR0aD0iNyIgaGVpZ2h0PSI5IiByeD0iMS41Ii8+PHJlY3QgeD0iMyIgeT0iMTYi",
  "IHdpZHRoPSI3IiBoZWlnaHQ9IjUiIHJ4PSIxLjUiLz48L3N2Zz5EYXNoYm9hcmQ8L2J1dHRvbj4KICA8YnV0dG9uIGRhdGEtdmlldz0ic2NyZWVuZXIiPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ry",
  "b2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNNCA2aDE2TTcgMTJoMTBNMTAgMThoNCIvPjwvc3ZnPlNjcmVlbmVyPC9idXR0b24+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9Im1hcmtldHMiPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1",
  "cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMyAxN2w2LTYgNCA0IDgtOCIvPjwvc3ZnPk1hcmtldHM8L2J1dHRvbj4KICA8YnV0dG9uIGRhdGEtdmlldz0id2F0Y2hsaXN0Ij48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIg",
  "c3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz5XYXRjaGxpc3Q8",
  "L2J1dHRvbj4KPC9uYXY+Cgo8YnV0dG9uIGNsYXNzPSJhaS1mYWIiIGlkPSJhaUZhYiIgdGl0bGU9IkFzayB0aGUgRXF1aXR5U2NhbiBBc3Npc3RhbnQiPgogIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIg",
  "c3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xMiA4VjRIOCIvPjxyZWN0IHg9IjQiIHk9IjgiIHdpZHRoPSIxNiIgaGVpZ2h0PSIxMiIgcng9IjIiLz48cGF0aCBkPSJNMiAxNGgy",
  "TTIwIDE0aDJNOSAxM3YyTTE1IDEzdjIiLz48L3N2Zz4KPC9idXR0b24+Cgo8ZGl2IGNsYXNzPSJhaS1wYW5lbCIgaWQ9ImFpUGFuZWwiPgogIDxkaXYgY2xhc3M9ImFpLXBhbmVsLWhlYWQiPgogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1z",
  "OmNlbnRlcjtnYXA6OXB4OyI+CiAgICAgIDxkaXYgY2xhc3M9ImFpLWF2YXRhciI+4pymPC9kaXY+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBzdHlsZT0iZm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxMy41cHg7Ij5FcXVpdHlTY2FuIEFzc2lzdGFudDwvZGl2",
  "PgogICAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMC41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7IiBpZD0iYWlTdGF0dXNMaW5lIj5DaGVja2luZ+KApjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4i",
  "IGlkPSJhaUNsb3NlQnRuIiBzdHlsZT0id2lkdGg6MzBweDtoZWlnaHQ6MzBweDsiPgogICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJv",
  "dW5kIj48cGF0aCBkPSJNMTggNkw2IDE4TTYgNmwxMiAxMiIvPjwvc3ZnPgogICAgPC9idXR0b24+CiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0iYWktbWVzc2FnZXMiIGlkPSJhaU1lc3NhZ2VzIj4KICAgIDxkaXYgY2xhc3M9ImFpLW1zZyBhc3Npc3RhbnQiPkhpIOKA",
  "lCBhc2sgbWUgYWJvdXQgYSBzdG9jaydzIG51bWJlcnMsIHlvdXIgd2F0Y2hsaXN0LCBvciB3aGF0J3MgaGFwcGVuaW5nIG9uIHRoZSBkYXNoYm9hcmQgcmlnaHQgbm93LiBJIG9ubHkga25vdyB3aGF0J3MgbG9hZGVkIGluIHRoZSBhcHAsIGFuZCBJIHdvbid0IHRl",
  "bGwgeW91IHdoYXQgdG8gYnV5IG9yIHNlbGwuPC9kaXY+CiAgPC9kaXY+CiAgPGRpdiBjbGFzcz0iYWktaW5wdXQtcm93Ij4KICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iYWlJbnB1dCIgcGxhY2Vob2xkZXI9IkFzayBhYm91dCB0aGUgZGF0YeKApiIgYXV0b2Nv",
  "bXBsZXRlPSJvZmYiPgogICAgPGJ1dHRvbiBjbGFzcz0iYWktc2VuZC1idG4iIGlkPSJhaVNlbmRCdG4iIHRpdGxlPSJTZW5kIj4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lk",
  "dGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTIyIDJMMTEgMTNNMjIgMmwtNyAyMC00LTktOS00IDIwLTd6Ii8+PC9zdmc+CiAgICA8L2J1dHRvbj4KICA8L2Rpdj4KPC9kaXY+Cgo8c2NyaXB0Pgoi",
  "dXNlIHN0cmljdCI7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFZJU0lCTEUgRVJST1IgRElBR05PU1RJQ1Mg4oCUIHNob3dzIHVuY2F1Z2h0IGVycm9ycyBvbi1zY3JlZW4gc28g",
  "dGhleQogICBjYW4gYmUgcmVhZC9yZXBvcnRlZCB3aXRob3V0IG9wZW5pbmcgYnJvd3NlciBkZXYgdG9vbHMuIFNhZmUgdG8KICAgbGVhdmUgaW47IGl0IG9ubHkgYXBwZWFycyB3aGVuIHNvbWV0aGluZyBhY3R1YWxseSB0aHJvd3MuCiAgID09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KZnVuY3Rpb24gc2hvd0Vycm9yQmFubmVyKG1zZyl7CiAgbGV0IGJhbm5lciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJlcnJCYW5uZXIiKTsKICBpZighYmFubmVy",
  "KXsKICAgIGJhbm5lciA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImRpdiIpOwogICAgYmFubmVyLmlkID0gImVyckJhbm5lciI7CiAgICBiYW5uZXIuc3R5bGUuY3NzVGV4dCA9ICJwb3NpdGlvbjpmaXhlZDtsZWZ0OjEycHg7cmlnaHQ6MTJweDtib3R0b206MTJw",
  "eDt6LWluZGV4Ojk5OTtiYWNrZ3JvdW5kOiMyYTBlMTQ7Ym9yZGVyOjFweCBzb2xpZCAjRkI2QjZCO2NvbG9yOiNGRkQ5RDk7cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2ZvbnQtc2l6ZToxMnB4O2ZvbnQtZmFtaWx5Om1vbm9zcGFjZTttYXgt",
  "aGVpZ2h0OjM1dmg7b3ZlcmZsb3c6YXV0bztib3gtc2hhZG93OjAgMjBweCA1MHB4IHJnYmEoMCwwLDAsMC41KTsiOwogICAgZG9jdW1lbnQuYm9keS5hcHBlbmRDaGlsZChiYW5uZXIpOwogIH0KICBjb25zdCBsaW5lID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgi",
  "ZGl2Iik7CiAgbGluZS5zdHlsZS5tYXJnaW5Cb3R0b20gPSAiNnB4IjsKICBsaW5lLnRleHRDb250ZW50ID0gbmV3IERhdGUoKS50b0xvY2FsZVRpbWVTdHJpbmcoKSArICIg4oCUICIgKyBtc2c7CiAgYmFubmVyLmFwcGVuZENoaWxkKGxpbmUpOwp9CndpbmRvdy5h",
  "ZGRFdmVudExpc3RlbmVyKCJlcnJvciIsIChlKT0+IHNob3dFcnJvckJhbm5lcigiSlMgZXJyb3I6ICIgKyAoZS5tZXNzYWdlfHxlKSkpOwp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigidW5oYW5kbGVkcmVqZWN0aW9uIiwgKGUpPT4gc2hvd0Vycm9yQmFubmVyKCJV",
  "bmhhbmRsZWQgcHJvbWlzZSByZWplY3Rpb246ICIgKyAoZS5yZWFzb24gJiYgZS5yZWFzb24ubWVzc2FnZSB8fCBlLnJlYXNvbikpKTsKCi8vIFNhZmUgRE9NIHRleHQgc2V0dGVyIOKAlCBzZXZlcmFsIHVwZGF0ZXMgaGVyZSBjb21lIGZyb20gZGVib3VuY2VkL2Fz",
  "eW5jCi8vIGNhbGxiYWNrcyAoc2VhcmNoIHR5cGluZywgZmlsdGVyIGNoYW5nZXMpIHRoYXQgY2FuIHJlc29sdmUgYWZ0ZXIgdGhlIHVzZXIKLy8gaGFzIGFscmVhZHkgbmF2aWdhdGVkIHRvIGEgZGlmZmVyZW50IHZpZXcsIGF0IHdoaWNoIHBvaW50IHRoZSB0YXJn",
  "ZXQKLy8gZWxlbWVudCBubyBsb25nZXIgZXhpc3RzLiBUaGlzIGp1c3Qgbm8tb3BzIGluc3RlYWQgb2YgdGhyb3dpbmcuCmZ1bmN0aW9uIHNldFRleHQoaWQsIHRleHQpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoaWQpOwogIGlmKGVsKSBl",
  "bC50ZXh0Q29udGVudCA9IHRleHQ7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSU5URUdSQVRJT04gTEFZRVIKICAgVGhpcyBmcm9udGVuZCBub3cgdGFsa3MgdG8gYSByZWFs",
  "IEVxdWl0eVNjYW4gYmFja2VuZCAoc2VlIC9iYWNrZW5kKQogICB3aGljaCBwcm94aWVzIE5TRSB2aWEgc3RvY2stbnNlLWluZGlhLCBjYWNoZWQgYW5kIGJ1ZGdldC1saW1pdGVkIHRvCiAgIH41MCB1cHN0cmVhbSBjYWxscy9kYXkuIEV2ZXJ5IEFQSS4qIG1ldGhv",
  "ZCBiZWxvdyB0cmllcyB0aGUgbGl2ZQogICBiYWNrZW5kIGZpcnN0IGFuZCBmYWxscyBiYWNrIHRvIGRldGVybWluaXN0aWMgbW9jayBkYXRhIGlmIHRoZQogICBiYWNrZW5kIGlzIHVucmVhY2hhYmxlIOKAlCB3aGljaCBpcyBleHBlY3RlZCB3aGVuIHRoaXMgcGFn",
  "ZSBpcyBvcGVuZWQKICAgYXMgYSBob3N0ZWQgcHJldmlldywgc2luY2UgYSBwdWJsaXNoZWQgcGFnZSBjYW5ub3QgcmVhY2ggYQogICBsb2NhbGhvc3Qgc2VydmVyLiBSdW4gdGhlIGJhY2tlbmQgYW5kIG9wZW4gdGhpcyBmaWxlIGxvY2FsbHkgKG5vdAogICB0aGUg",
  "cHVibGlzaGVkIHByZXZpZXcpIHRvIHNlZSByZWFsIE5TRSBxdW90ZXMgZW5kIHRvIGVuZC4KICAgVGhlIGJhY2tlbmQgaGFzIG5vIGhpc3RvcmljYWwtcHJpY2UgZW5kcG9pbnQgeWV0LCBzbyBjaGFydCBzZXJpZXMKICAgYW5kIHNwYXJrbGluZXMgc3RheSBzeW50",
  "aGV0aWMgZXZlbiBpbiBsaXZlIG1vZGUg4oCUIGV2ZXJ5dGhpbmcgZWxzZQogICAocHJpY2UsIGNoYW5nZSAlLCA1MlcgaGlnaC9sb3csIGNvbXBhbnkgbmFtZSwgbWFya2V0IHN0YXR1cykgaXMKICAgcmVhbCB3aGVuIHRoZSBiYWNrZW5kIGlzIHJlYWNoYWJsZS4K",
  "ICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCBDT05GSUcgPSB7CiAgQVBJX0JBU0U6ICh3aW5kb3cubG9jYXRpb24ucHJvdG9jb2wgPT09ICJmaWxlOiIgPyAiaHR0cDovL2xv",
  "Y2FsaG9zdDozMDAwIiA6IHdpbmRvdy5sb2NhdGlvbi5vcmlnaW4pICsgIi9hcGkiLAogIExJVkVfVElNRU9VVF9NUzogODAwMCwKICAvLyBSZW5kZXIncyBmcmVlIHRpZXIgc3BpbnMgdGhlIHNlcnZlciBkb3duIGFmdGVyIH4xNSBtaW4gaWRsZSwgYW5kIHdha2lu",
  "ZwogIC8vIGl0IGJhY2sgdXAgY2FuIHRha2UgMzAtNTBzLiBUaGUgaGVhbHRoIGNoZWNrIG5lZWRzIGEgbXVjaCBsb25nZXIgbGVhc2gKICAvLyB0aGFuIGEgbm9ybWFsIGRhdGEgcmVxdWVzdCwgb3IgaXQgd3JvbmdseSBjb25jbHVkZXMgImJhY2tlbmQgaXMgZG93",
  "biIKICAvLyBkdXJpbmcgZXhhY3RseSB0aGUgbW9tZW50IGl0J3MganVzdCBzbG93bHkgc3RhcnRpbmcgdXAuCiAgSEVBTFRIX1RJTUVPVVRfTVM6IDQ1MDAwLAp9OwpsZXQgbGl2ZUJhY2tlbmRBdmFpbGFibGUgPSBmYWxzZTsKY29uc3QgTU9DS19MQVRFTkNZID0g",
  "NDIwOwoKZnVuY3Rpb24gZmV0Y2hXaXRoVGltZW91dCh1cmwsIG1zKXsKICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogIGNvbnN0IGlkID0gc2V0VGltZW91dCgoKT0+Y3RybC5hYm9ydCgpLCBtcyk7CiAgcmV0dXJuIGZldGNoKHVybCwge3Np",
  "Z25hbDogY3RybC5zaWduYWx9KS5maW5hbGx5KCgpPT5jbGVhclRpbWVvdXQoaWQpKTsKfQoKYXN5bmMgZnVuY3Rpb24gY2hlY2tMaXZlQmFja2VuZCgpewogIHRyeXsKICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KENPTkZJRy5BUElfQkFTRSAr",
  "ICIvaGVhbHRoIiwgQ09ORklHLkhFQUxUSF9USU1FT1VUX01TKTsKICAgIGxpdmVCYWNrZW5kQXZhaWxhYmxlID0gISEociAmJiByLm9rKTsKICB9Y2F0Y2goZSl7CiAgICBsaXZlQmFja2VuZEF2YWlsYWJsZSA9IGZhbHNlOwogIH0KICB1cGRhdGVCYWNrZW5kQmFk",
  "Z2UoKTsKICByZXR1cm4gbGl2ZUJhY2tlbmRBdmFpbGFibGU7Cn0KCmZ1bmN0aW9uIHVwZGF0ZUJhY2tlbmRCYWRnZSgpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJhY2tlbmRCYWRnZSIpOwogIGlmKCFlbCkgcmV0dXJuOwogIGVsLmNs",
  "YXNzTGlzdC50b2dnbGUoImxpdmUiLCBsaXZlQmFja2VuZEF2YWlsYWJsZSk7CiAgZWwucXVlcnlTZWxlY3RvcigiLmRvdC1saXZlIikuc3R5bGUuYmFja2dyb3VuZCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gInZhcigtLXBvcykiIDogInZhcigtLXRleHQtZmFp",
  "bnQpIjsKICBlbC5xdWVyeVNlbGVjdG9yKCJzcGFuOmxhc3QtY2hpbGQiKS50ZXh0Q29udGVudCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gIkxpdmUgTlNFIERhdGEiIDogIkRlbW8gRGF0YSI7CiAgZWwudGl0bGUgPSBsaXZlQmFja2VuZEF2YWlsYWJsZQogICAg",
  "PyAiQ29ubmVjdGVkIHRvIHRoZSBFcXVpdHlTY2FuIGJhY2tlbmQg4oCUIHByaWNlcyBhcmUgcmVhbCBOU0UgcXVvdGVzLiIKICAgIDogIkJhY2tlbmQgbm90IHJlYWNoYWJsZSBhdCAiICsgQ09ORklHLkFQSV9CQVNFICsgIiDigJQgc2hvd2luZyBkZXRlcm1pbmlz",
  "dGljIGRlbW8gZGF0YS4iOwp9CgpmdW5jdGlvbiBtYXBCYWNrZW5kVG9Gcm9udGVuZChkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkLnN5bWJvbCk7CiAgY29uc3QgYmFzaXMgPSBkLmN1cnJlbnRQcmljZSB8fCAxMDAwOwogIGNvbnN0IHNlcmllcyA9IGdl",
  "blNlcmllcyhzZWVkLCAyMCwgMC4wMDUsIGJhc2lzKTsKICBjb25zdCBrbm93bkRlZiA9IFVOSVZFUlNFLmZpbmQodT0+dS50PT09ZC5zeW1ib2wpOwogIHJldHVybiB7CiAgICB0OiBkLnN5bWJvbCwKICAgIG5hbWU6IGQuY29tcGFueU5hbWUgfHwgKGtub3duRGVm",
  "ICYmIGtub3duRGVmLm5hbWUpIHx8IGQuc3ltYm9sLAogICAgZXhjaDogZC5leGNoYW5nZSB8fCAiTlNFIiwKICAgIC8vIFRoZSBsaXZlIGJhY2tlbmQncyBpbmR1c3RyeSBsYWJlbCBkb2Vzbid0IHJlbGlhYmx5IG1hdGNoIG91ciBmaWx0ZXIKICAgIC8vIGRyb3Bk",
  "b3duJ3Mgdm9jYWJ1bGFyeSAob3IgbWF5IGJlIG1pc3NpbmcpLCBzbyBwcmVmZXIgb3VyIGtub3duIG1hcHBpbmcKICAgIC8vIGZvciBmaWx0ZXJpbmcgcHVycG9zZXMgYW5kIG9ubHkgZmFsbCBiYWNrIHRvIHRoZSBiYWNrZW5kJ3MgcmF3IHZhbHVlLgogICAgc2Vj",
  "dG9yOiAoa25vd25EZWYgJiYga25vd25EZWYuc2VjdG9yKSB8fCBkLnNlY3RvciB8fCAi4oCUIiwKICAgIHByaWNlOiBkLmN1cnJlbnRQcmljZSwKICAgIGNoYW5nZTogZC5jaGFuZ2UsCiAgICBwY3Q6IGQucGVyY2VudENoYW5nZSwKICAgIG1hcmtldENhcDogZC5t",
  "YXJrZXRDYXAsCiAgICB2b2x1bWU6IGQudm9sdW1lLAogICAgaGlnaDUyOiBkLndlZWs1MkhpZ2gsCiAgICBsb3c1MjogZC53ZWVrNTJMb3csCiAgICBvcGVuOiBkLm9wZW4sCiAgICBkYXlIaWdoOiBkLmRheUhpZ2gsCiAgICBkYXlMb3c6IGQuZGF5TG93LAogICAg",
  "c2VyaWVzLAogICAgbGl2ZTogdHJ1ZSwKICAgIGRhdGFTdGF0dXM6IGQuZGF0YVN0YXR1cywKICB9Owp9Cgphc3luYyBmdW5jdGlvbiBsaXZlRmV0Y2hTdG9jayh0aWNrZXIpewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KGAke0NPTkZJRy5BUElf",
  "QkFTRX0vc3RvY2svJHtlbmNvZGVVUklDb21wb25lbnQodGlja2VyKX1gLCBDT05GSUcuTElWRV9USU1FT1VUX01TKTsKICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCJiYWNrZW5kIHN0YXR1cyAiK3Iuc3RhdHVzKTsKICBjb25zdCBqc29uID0gYXdhaXQgci5q",
  "c29uKCk7CiAgaWYoIWpzb24uc3VjY2VzcyB8fCAhanNvbi5kYXRhKSB0aHJvdyBuZXcgRXJyb3IoImJhY2tlbmQgcGF5bG9hZCBlcnJvciIpOwogIHJldHVybiBtYXBCYWNrZW5kVG9Gcm9udGVuZChqc29uLmRhdGEpOwp9Cgphc3luYyBmdW5jdGlvbiBsaXZlRmV0",
  "Y2hNYW55KHRpY2tlcnMpewogIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGlja2Vycy5tYXAobGl2ZUZldGNoU3RvY2spKTsKICByZXR1cm4gc2V0dGxlZC5maWx0ZXIocz0+cy5zdGF0dXM9PT0iZnVsZmlsbGVkIikubWFwKHM9PnMu",
  "dmFsdWUpOwp9Cgpjb25zdCBVTklWRVJTRSA9IFsKICB7dDoiVENTIiwgbmFtZToiVGF0YSBDb25zdWx0YW5jeSBTZXJ2aWNlcyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjM4NDJ9LAogIHt0OiJSRUxJQU5DRSIsIG5hbWU6IlJlbGlh",
  "bmNlIEluZHVzdHJpZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkVuZXJneSIsIGJhc2U6Mjk1MX0sCiAge3Q6IkhERkNCQU5LIiwgbmFtZToiSERGQyBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxNjg3fSwKICB7dDoiSU5GWSIsIG5h",
  "bWU6IkluZm9zeXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IklUIFNlcnZpY2VzIiwgYmFzZToxODQxfSwKICB7dDoiSUNJQ0lCQU5LIiwgbmFtZToiSUNJQ0kgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTI2NH0sCiAge3Q6IkJIQVJU",
  "SUFSVEwiLCBuYW1lOiJCaGFydGkgQWlydGVsIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJUZWxlY29tIiwgYmFzZToxNjk4fSwKICB7dDoiU0JJTiIsIG5hbWU6IlN0YXRlIEJhbmsgb2YgSW5kaWEiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjgy",
  "NH0sCiAge3Q6IklUQyIsIG5hbWU6IklUQyBMaW1pdGVkIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGTUNHIiwgYmFzZTo0Nzh9LAogIHt0OiJMVCIsIG5hbWU6IkxhcnNlbiAmIFRvdWJybyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSW5mcmFzdHJ1Y3R1cmUiLCBiYXNl",
  "OjM2MTJ9LAogIHt0OiJLT1RBS0JBTksiLCBuYW1lOiJLb3RhayBNYWhpbmRyYSBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxNzg5fSwKICB7dDoiSElORFVOSUxWUiIsIG5hbWU6IkhpbmR1c3RhbiBVbmlsZXZlciIsIGV4Y2g6Ik5T",
  "RSIsIHNlY3RvcjoiRk1DRyIsIGJhc2U6MjU0N30sCiAge3Q6IkFYSVNCQU5LIiwgbmFtZToiQXhpcyBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxMTQyfSwKICB7dDoiQkFKRklOQU5DRSIsIG5hbWU6IkJhamFqIEZpbmFuY2UiLCBl",
  "eGNoOiJOU0UiLCBzZWN0b3I6IkZpbmFuY2lhbCBTZXJ2aWNlcyIsIGJhc2U6NzI4NH0sCiAge3Q6Ik1BUlVUSSIsIG5hbWU6Ik1hcnV0aSBTdXp1a2kiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkF1dG9tb2JpbGUiLCBiYXNlOjEyNDgwfSwKICB7dDoiQVNJQU5QQUlO",
  "VCIsIG5hbWU6IkFzaWFuIFBhaW50cyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQ29uc3VtZXIgR29vZHMiLCBiYXNlOjI4OTR9LAogIHt0OiJXSVBSTyIsIG5hbWU6IldpcHJvIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6NTEyfSwKICB7",
  "dDoiVElUQU4iLCBuYW1lOiJUaXRhbiBDb21wYW55IiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJDb25zdW1lciBHb29kcyIsIGJhc2U6MzQyMX0sCiAge3Q6IlNVTlBIQVJNQSIsIG5hbWU6IlN1biBQaGFybWFjZXV0aWNhbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUGhh",
  "cm1hIiwgYmFzZToxNzg2fSwKICB7dDoiTlRQQyIsIG5hbWU6Ik5UUEMgTGltaXRlZCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUG93ZXIiLCBiYXNlOjM2Mn0sCiAge3Q6IkFEQU5JRU5UIiwgbmFtZToiQWRhbmkgRW50ZXJwcmlzZXMiLCBleGNoOiJOU0UiLCBzZWN0",
  "b3I6IkRpdmVyc2lmaWVkIiwgYmFzZToyOTE0fSwKICB7dDoiVUxUUkFDRU1DTyIsIG5hbWU6IlVsdHJhVGVjaCBDZW1lbnQiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkNlbWVudCIsIGJhc2U6MTEyNDB9LAogIHt0OiJQT1dFUkdSSUQiLCBuYW1lOiJQb3dlciBHcmlk",
  "IENvcnAiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBvd2VyIiwgYmFzZTozMTh9LAogIHt0OiJORVNUTEVJTkQiLCBuYW1lOiJOZXN0bGUgSW5kaWEiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ciLCBiYXNlOjIyNzh9LAogIHt0OiJUQVRBTU9UT1JTIiwgbmFtZToi",
  "VGF0YSBNb3RvcnMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkF1dG9tb2JpbGUiLCBiYXNlOjk0OH0sCiAge3Q6IkpTV1NURUVMIiwgbmFtZToiSlNXIFN0ZWVsIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJNZXRhbHMiLCBiYXNlOjEwMTJ9LApdOwoKZnVuY3Rpb24gc2Vl",
  "ZGVkUmFuZChzZWVkKXsKICBsZXQgeCA9IE1hdGguc2luKHNlZWQpICogMTAwMDA7CiAgcmV0dXJuIHggLSBNYXRoLmZsb29yKHgpOwp9CmZ1bmN0aW9uIGRheU9mWWVhcigpewogIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7CiAgcmV0dXJuIE1hdGguZmxvb3IoKG5v",
  "dyAtIG5ldyBEYXRlKG5vdy5nZXRGdWxsWWVhcigpLDAsMCkpIC8gODY0MDAwMDApOwp9CmZ1bmN0aW9uIGdlblNlcmllcyhzZWVkLCBwb2ludHMsIHZvbGF0aWxpdHksIGJhc2UpewogIGNvbnN0IGFyciA9IFtdOwogIGxldCB2ID0gYmFzZTsKICBmb3IobGV0IGk9",
  "MDtpPHBvaW50cztpKyspewogICAgY29uc3QgciA9IHNlZWRlZFJhbmQoc2VlZCAqIDk3LjcgKyBpICogMTMuMzEpIC0gMC41OwogICAgdiA9IHYgKiAoMSArIHIgKiB2b2xhdGlsaXR5KTsKICAgIGFyci5wdXNoKHYpOwogIH0KICByZXR1cm4gYXJyOwp9CmZ1bmN0",
  "aW9uIHRpY2tlclNlZWQodGlja2VyKXsKICBsZXQgaCA9IDA7CiAgZm9yKGxldCBpPTA7aTx0aWNrZXIubGVuZ3RoO2krKykgaCA9IChoKjMxICsgdGlja2VyLmNoYXJDb2RlQXQoaSkpICUgMTAwMDAwOwogIHJldHVybiBoICsgZGF5T2ZZZWFyKCk7Cn0KCmZ1bmN0",
  "aW9uIHdpdGhMYXRlbmN5KHZhbHVlKXsKICByZXR1cm4gbmV3IFByb21pc2UocmVzID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzKHZhbHVlKSwgTU9DS19MQVRFTkNZKSk7Cn0KCmNvbnN0IEFQSSA9IHsKICBhc3luYyBmZXRjaEluZGljZXMoKXsKICAgIGNvbnN0IGRl",
  "ZnMgPSBbCiAgICAgIHtjb2RlOiJOSUZUWSA1MCIsIGZ1bGw6Ik5TRSBOaWZ0eSA1MCBJbmRleCIsIGJhc2U6MjQ4MTJ9LAogICAgICB7Y29kZToiU0VOU0VYIiwgZnVsbDoiQlNFIFNlbnNleCIsIGJhc2U6ODE2NDB9LAogICAgICB7Y29kZToiTklGVFkgQkFOSyIs",
  "IGZ1bGw6Ik5TRSBCYW5rIE5pZnR5IEluZGV4IiwgYmFzZTo1MjE0MH0sCiAgICBdOwogICAgY29uc3Qgb3V0ID0gZGVmcy5tYXAoZD0+ewogICAgICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkLmNvZGUpOwogICAgICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMo",
  "c2VlZCwgMjQsIDAuMDA2LCBkLmJhc2UpOwogICAgICBjb25zdCBsYXN0ID0gc2VyaWVzW3Nlcmllcy5sZW5ndGgtMV07CiAgICAgIGNvbnN0IHByZXYgPSBkLmJhc2U7CiAgICAgIGNvbnN0IGNoZyA9IGxhc3QgLSBwcmV2OwogICAgICBjb25zdCBwY3QgPSAoY2hn",
  "L3ByZXYpKjEwMDsKICAgICAgcmV0dXJuIHsuLi5kLCB2YWx1ZTpsYXN0LCBjaGFuZ2U6Y2hnLCBwY3QsIHNlcmllc307CiAgICB9KTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShvdXQpOwogIH0sCgogIGFzeW5jIHNlYXJjaFN0b2NrcyhxdWVyeSl7CiAgICBjb25z",
  "dCBxID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7CiAgICBpZighcSkgcmV0dXJuIHdpdGhMYXRlbmN5KFtdKTsKICAgIGNvbnN0IG1hdGNoZXMgPSBVTklWRVJTRS5maWx0ZXIocyA9PiBzLnQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSB8fCBzLm5hbWUu",
  "dG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSkuc2xpY2UoMCw4KTsKICAgIGlmKGxpdmVCYWNrZW5kQXZhaWxhYmxlKXsKICAgICAgY29uc3QgbGl2ZSA9IGF3YWl0IGxpdmVGZXRjaE1hbnkobWF0Y2hlcy5tYXAobT0+bS50KSk7CiAgICAgIGlmKGxpdmUubGVuZ3Ro",
  "KSByZXR1cm4gbGl2ZTsKICAgIH0KICAgIHJldHVybiB3aXRoTGF0ZW5jeShtYXRjaGVzLm1hcChzID0+IGRlY29yYXRlU3RvY2socykpKTsKICB9LAoKICBhc3luYyBmZXRjaFNjcmVlbmVyUmVzdWx0cyhmaWx0ZXJzKXsKICAgIGxldCBsaXN0OwogICAgaWYobGl2",
  "ZUJhY2tlbmRBdmFpbGFibGUpewogICAgICBjb25zdCBsaXZlID0gYXdhaXQgbGl2ZUZldGNoTWFueShVTklWRVJTRS5tYXAocz0+cy50KSk7CiAgICAgIGxpc3QgPSBsaXZlLmxlbmd0aCA/IGxpdmUgOiBVTklWRVJTRS5tYXAocz0+ZGVjb3JhdGVTdG9jayhzKSk7",
  "CiAgICB9IGVsc2UgewogICAgICBsaXN0ID0gVU5JVkVSU0UubWFwKGRlY29yYXRlU3RvY2spOwogICAgICBhd2FpdCB3aXRoTGF0ZW5jeShudWxsKTsKICAgIH0KICAgIGlmKGZpbHRlcnMucXVlcnkpewogICAgICBjb25zdCBxID0gZmlsdGVycy5xdWVyeS50b0xv",
  "d2VyQ2FzZSgpOwogICAgICBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy50LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSl8fHMubmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTsKICAgIH0KICAgIGlmKGZpbHRlcnMuc2VjdG9yICYmIGZpbHRlcnMuc2VjdG9y",
  "ICE9PSAiQWxsIikgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMuc2VjdG9yPT09ZmlsdGVycy5zZWN0b3IpOwogICAgaWYoZmlsdGVycy5taW5QcmljZSkgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucHJpY2U+PWZpbHRlcnMubWluUHJpY2UpOwogICAgaWYoZmlsdGVy",
  "cy5tYXhQcmljZSkgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucHJpY2U8PWZpbHRlcnMubWF4UHJpY2UpOwogICAgaWYoZmlsdGVycy5kaXJlY3Rpb249PT0iZ2FpbmVycyIpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnBjdD49MCk7CiAgICBpZihmaWx0ZXJzLmRp",
  "cmVjdGlvbj09PSJsb3NlcnMiKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q8MCk7CiAgICByZXR1cm4gbGlzdDsKICB9LAoKICBhc3luYyBmZXRjaFN0b2NrKHRpY2tlcil7CiAgICBpZihsaXZlQmFja2VuZEF2YWlsYWJsZSl7CiAgICAgIHRyeXsgcmV0dXJu",
  "IGF3YWl0IGxpdmVGZXRjaFN0b2NrKHRpY2tlcik7IH0KICAgICAgY2F0Y2goZSl7IC8qIGZhbGwgdGhyb3VnaCB0byBtb2NrICovIH0KICAgIH0KICAgIGNvbnN0IGRlZiA9IFVOSVZFUlNFLmZpbmQocz0+cy50PT09dGlja2VyKTsKICAgIGlmKCFkZWYpIHJldHVy",
  "biB3aXRoTGF0ZW5jeShudWxsKTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShkZWNvcmF0ZVN0b2NrKGRlZiwgdHJ1ZSkpOwogIH0sCgogIGFzeW5jIGZldGNoU3RvY2tIaXN0b3J5KHRpY2tlciwgcmFuZ2UpewogICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQodGlj",
  "a2VyKTsKICAgIGNvbnN0IGNmZyA9IHsKICAgICAgIjFEIjp7cG9pbnRzOjc4LCB2b2w6MC4wMDE2fSwKICAgICAgIjFXIjp7cG9pbnRzOjM1LCB2b2w6MC4wMDN9LAogICAgICAiMU0iOntwb2ludHM6MjIsIHZvbDowLjAwOH0sCiAgICAgICIzTSI6e3BvaW50czo2",
  "NSwgdm9sOjAuMDA5fSwKICAgICAgIjZNIjp7cG9pbnRzOjEzMCwgdm9sOjAuMDEwfSwKICAgICAgIjFZIjp7cG9pbnRzOjI1MCwgdm9sOjAuMDEyfSwKICAgIH1bcmFuZ2VdIHx8IHtwb2ludHM6NjAsIHZvbDowLjAwOH07CiAgICBjb25zdCBkZWYgPSBVTklWRVJT",
  "RS5maW5kKHM9PnMudD09PXRpY2tlcik7CiAgICBjb25zdCBiYXNlID0gZGVmID8gZGVmLmJhc2UgKiAwLjk0IDogMTAwMDsKICAgIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkICsgcmFuZ2UubGVuZ3RoLCBjZmcucG9pbnRzLCBjZmcudm9sLCBiYXNlKTsK",
  "ICAgIHJldHVybiB3aXRoTGF0ZW5jeShzZXJpZXMpOwogIH0sCn07CgpmdW5jdGlvbiBkZWNvcmF0ZVN0b2NrKGRlZiwgZGV0YWlsZWQpewogIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKGRlZi50KTsKICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjAs",
  "IDAuMDA1LCBkZWYuYmFzZSk7CiAgY29uc3QgcHJpY2UgPSBzZXJpZXNbc2VyaWVzLmxlbmd0aC0xXTsKICBjb25zdCBwcmV2Q2xvc2UgPSBkZWYuYmFzZTsKICBjb25zdCBjaGFuZ2UgPSBwcmljZSAtIHByZXZDbG9zZTsKICBjb25zdCBwY3QgPSAoY2hhbmdlL3By",
  "ZXZDbG9zZSkqMTAwOwogIGNvbnN0IG1hcmtldENhcCA9IHByaWNlICogKHNlZWRlZFJhbmQoc2VlZCoyLjEpKjQwMDArODAwKSAqIDFlNjsKICBjb25zdCB2b2x1bWUgPSBNYXRoLnJvdW5kKHNlZWRlZFJhbmQoc2VlZCozLjMpKjhfMDAwXzAwMCArIDIwMF8wMDAp",
  "OwogIGNvbnN0IGhpZ2g1MiA9IHByaWNlICogKDEgKyBzZWVkZWRSYW5kKHNlZWQqNC40KSowLjM1ICsgMC4wNSk7CiAgY29uc3QgbG93NTIgPSBwcmljZSAqICgxIC0gc2VlZGVkUmFuZChzZWVkKjUuNSkqMC4zMCAtIDAuMDQpOwogIGNvbnN0IG91dCA9IHsKICAg",
  "IHQ6ZGVmLnQsIG5hbWU6ZGVmLm5hbWUsIGV4Y2g6ZGVmLmV4Y2gsIHNlY3RvcjpkZWYuc2VjdG9yLAogICAgcHJpY2UsIGNoYW5nZSwgcGN0LCBtYXJrZXRDYXAsIHZvbHVtZSwgaGlnaDUyLCBsb3c1Miwgc2VyaWVzLAogIH07CiAgaWYoZGV0YWlsZWQpewogICAg",
  "b3V0Lm9wZW4gPSBwcmljZSAtIGNoYW5nZSowLjY7CiAgICBvdXQuZGF5SGlnaCA9IE1hdGgubWF4KHByaWNlLCBvdXQub3BlbikgKiAoMStzZWVkZWRSYW5kKHNlZWQqNi42KSowLjAxMik7CiAgICBvdXQuZGF5TG93ID0gTWF0aC5taW4ocHJpY2UsIG91dC5vcGVu",
  "KSAqICgxLXNlZWRlZFJhbmQoc2VlZCo3LjcpKjAuMDEyKTsKICB9CiAgcmV0dXJuIG91dDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBGT1JNQVQgSEVMUEVSUwogICA9PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9uIGZtdElOUih2LCBkZWNpbWFscyl7CiAgaWYodj09PXVuZGVmaW5lZHx8dj09PW51bGx8fGlzTmFOKHYpKSByZXR1cm4gIuKAlCI7CiAg",
  "Y29uc3QgZCA9IGRlY2ltYWxzPT09dW5kZWZpbmVkPzI6ZGVjaW1hbHM7CiAgcmV0dXJuICLigrkiICsgdi50b0xvY2FsZVN0cmluZygiZW4tSU4iLCB7bWluaW11bUZyYWN0aW9uRGlnaXRzOmQsIG1heGltdW1GcmFjdGlvbkRpZ2l0czpkfSk7Cn0KZnVuY3Rpb24g",
  "Zm10Q29tcGFjdCh2KXsKICBpZih2PT09dW5kZWZpbmVkfHx2PT09bnVsbHx8aXNOYU4odikpIHJldHVybiAi4oCUIjsKICBpZih2Pj0xZTEyKSByZXR1cm4gIuKCuSIrKHYvMWUxMikudG9GaXhlZCgyKSsiVCI7CiAgaWYodj49MWU5KSByZXR1cm4gIuKCuSIrKHYv",
  "MWU5KS50b0ZpeGVkKDIpKyJCIjsKICBpZih2Pj0xZTcpIHJldHVybiAi4oK5Iisodi8xZTcpLnRvRml4ZWQoMikrIkNyIjsKICBpZih2Pj0xZTUpIHJldHVybiAi4oK5Iisodi8xZTUpLnRvRml4ZWQoMikrIkwiOwogIHJldHVybiAi4oK5Iit2LnRvRml4ZWQoMCk7",
  "Cn0KZnVuY3Rpb24gZm10Vm9sKHYpewogIGlmKHY+PTFlNykgcmV0dXJuICh2LzFlNykudG9GaXhlZCgyKSsiQ3IiOwogIGlmKHY+PTFlNSkgcmV0dXJuICh2LzFlNSkudG9GaXhlZCgyKSsiTCI7CiAgaWYodj49MWUzKSByZXR1cm4gKHYvMWUzKS50b0ZpeGVkKDEp",
  "KyJLIjsKICByZXR1cm4gU3RyaW5nKHYpOwp9CmZ1bmN0aW9uIHBjdFN0cihwKXsgcmV0dXJuIChwPj0wPyIrIjoiIikgKyBwLnRvRml4ZWQoMikgKyAiJSI7IH0KZnVuY3Rpb24gY2hnU3RyKGMpeyByZXR1cm4gKGM+PTA/IisiOiIiKSArIGZtdElOUihNYXRoLmFi",
  "cyhjKSk7IH0KZnVuY3Rpb24gZXNjYXBlSHRtbChzKXsKICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoL1smPD4iJ10vZywgbSA9PiAoeyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzM5OyJ9W21dKSk7Cn0KCi8q",
  "ID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU1RBVEUKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25z",
  "dCBzdGF0ZSA9IHsKICB2aWV3OiAiZGFzaGJvYXJkIiwKICB3YXRjaGxpc3Q6IFtdLAogIGRldGFpbFRpY2tlcjogIlRDUyIsCiAgZGV0YWlsUmFuZ2U6ICIxTSIsCiAgc2NyZWVuZXJGaWx0ZXJzOiB7cXVlcnk6IiIsIHNlY3RvcjoiQWxsIiwgbWluUHJpY2U6MCwg",
  "bWF4UHJpY2U6MTUwMDAsIGRpcmVjdGlvbjoiYWxsIn0sCiAgc2NyZWVuZXJTb3J0OiB7a2V5OiJtYXJrZXRDYXAiLCBkaXI6ImRlc2MifSwKfTsKCnRyeXsKICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCJlcXVpdHlzY2FuX3dhdGNobGlzdCIp",
  "OwogIGlmKHNhdmVkKSBzdGF0ZS53YXRjaGxpc3QgPSBKU09OLnBhcnNlKHNhdmVkKTsKfWNhdGNoKGUpe30KZnVuY3Rpb24gcGVyc2lzdFdhdGNobGlzdCgpewogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oImVxdWl0eXNjYW5fd2F0Y2hsaXN0IiwgSlNPTi5z",
  "dHJpbmdpZnkoc3RhdGUud2F0Y2hsaXN0KSk7IH1jYXRjaChlKXt9Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU1BBUktMSU5FIChpbmxpbmUgU1ZHKQogICA9PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgTlVNQkVSIENPVU5ULVVQIOKAlCB0",
  "aWNrcyBhIG51bWJlciBmcm9tIDAgKG9yIGEgZ2l2ZW4gc3RhcnQpIHVwIHRvIGl0cwogICByZWFsIHZhbHVlIHdpdGggYW4gZWFzZS1vdXQgY3VydmUuIFJlc3BlY3RzIHByZWZlcnMtcmVkdWNlZC1tb3Rpb24uCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3QgcHJlZmVyc1JlZHVjZWRNb3Rpb24gPSB3aW5kb3cubWF0Y2hNZWRpYSgnKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246IHJlZHVjZSknKS5tYXRjaGVzOwpmdW5jdGlvbiBhbmltYXRl",
  "TnVtYmVyKGVsLCB0b1ZhbHVlLCBvcHRzKXsKICBvcHRzID0gb3B0cyB8fCB7fTsKICBpZighZWwgfHwgdHlwZW9mIHRvVmFsdWUgIT09ICJudW1iZXIiIHx8ICFpc0Zpbml0ZSh0b1ZhbHVlKSkgcmV0dXJuOwogIGNvbnN0IGRlY2ltYWxzID0gb3B0cy5kZWNpbWFs",
  "cyAhPT0gdW5kZWZpbmVkID8gb3B0cy5kZWNpbWFscyA6IDI7CiAgY29uc3QgZm9ybWF0ID0gb3B0cy5mb3JtYXQgfHwgKCh2KT0+IHYudG9Mb2NhbGVTdHJpbmcoImVuLUlOIiwge21pbmltdW1GcmFjdGlvbkRpZ2l0czpkZWNpbWFscywgbWF4aW11bUZyYWN0aW9u",
  "RGlnaXRzOmRlY2ltYWxzfSkpOwogIGlmKHByZWZlcnNSZWR1Y2VkTW90aW9uKXsgZWwudGV4dENvbnRlbnQgPSBmb3JtYXQodG9WYWx1ZSk7IHJldHVybjsgfQogIGNvbnN0IGZyb21WYWx1ZSA9IG9wdHMuZnJvbSAhPT0gdW5kZWZpbmVkID8gb3B0cy5mcm9tIDog",
  "MDsKICBjb25zdCBkdXJhdGlvbiA9IG9wdHMuZHVyYXRpb24gfHwgOTAwOwogIGNvbnN0IHN0YXJ0ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgZnVuY3Rpb24gdGljayhub3cpewogICAgY29uc3QgdCA9IE1hdGgubWluKDEsIChub3ctc3RhcnQpL2R1cmF0aW9uKTsK",
  "ICAgIGNvbnN0IGVhc2VkID0gMSAtIE1hdGgucG93KDEtdCwgMyk7CiAgICBlbC50ZXh0Q29udGVudCA9IGZvcm1hdChmcm9tVmFsdWUgKyAodG9WYWx1ZS1mcm9tVmFsdWUpKmVhc2VkKTsKICAgIGlmKHQ8MSkgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHRpY2spOwog",
  "ICAgZWxzZSBlbC50ZXh0Q29udGVudCA9IGZvcm1hdCh0b1ZhbHVlKTsKICB9CiAgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHRpY2spOwp9Ci8vIFNjYW5zIGEgY29udGFpbmVyIGZvciBlbGVtZW50cyBtYXJrZWQgZGF0YS1jb3VudHVwPSI8dmFsdWU+IiBhbmQgYW5p",
  "bWF0ZXMKLy8gZWFjaCBmcm9tIDAgdXAgdG8gdGhhdCB2YWx1ZS4gVXNlZCBhbnl3aGVyZSBtYXJrdXAgaXMgZ2VuZXJhdGVkIGFzIGEKLy8gdGVtcGxhdGUgc3RyaW5nIChzbyB0aGUgdGFyZ2V0IHRleHQgY2FuJ3QgYmUgc2V0IHVudGlsIGFmdGVyIGluc2VydGlv",
  "bikuCmZ1bmN0aW9uIHJ1bkNvdW50VXBzKGNvbnRhaW5lcil7CiAgaWYoIWNvbnRhaW5lcikgcmV0dXJuOwogIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1jb3VudHVwXSIpLmZvckVhY2goZWw9PnsKICAgIGNvbnN0IHRhcmdldCA9IE51bWJlcihl",
  "bC5kYXRhc2V0LmNvdW50dXApOwogICAgY29uc3QgZGVjaW1hbHMgPSBlbC5kYXRhc2V0LmRlY2ltYWxzICE9PSB1bmRlZmluZWQgPyBOdW1iZXIoZWwuZGF0YXNldC5kZWNpbWFscykgOiAyOwogICAgYW5pbWF0ZU51bWJlcihlbCwgdGFyZ2V0LCB7ZGVjaW1hbHN9",
  "KTsKICB9KTsKfQoKZnVuY3Rpb24gc3BhcmtsaW5lU1ZHKHNlcmllcywgcG9zaXRpdmUsIHcsIGgpewogIHcgPSB3fHwxMjA7IGggPSBofHwzNjsKICBpZighc2VyaWVzIHx8IHNlcmllcy5sZW5ndGg8MikgcmV0dXJuICIiOwogIGNvbnN0IG1pbiA9IE1hdGgubWlu",
  "KC4uLnNlcmllcyksIG1heCA9IE1hdGgubWF4KC4uLnNlcmllcyk7CiAgY29uc3QgcmFuZ2UgPSAobWF4LW1pbil8fDE7CiAgY29uc3Qgc3RlcCA9IHcvKHNlcmllcy5sZW5ndGgtMSk7CiAgY29uc3QgcHRzID0gc2VyaWVzLm1hcCgodixpKT0+W2kqc3RlcCwgaCAt",
  "ICgodi1taW4pL3JhbmdlKSpoKjAuODYgLSBoKjAuMDddKTsKICBjb25zdCBwYXRoID0gcHRzLm1hcCgocCxpKT0+KGk9PT0wPyJNIjoiTCIpK3BbMF0udG9GaXhlZCgxKSsiLCIrcFsxXS50b0ZpeGVkKDEpKS5qb2luKCIgIik7CiAgY29uc3QgYXJlYVBhdGggPSBw",
  "YXRoICsgYCBMJHt3fSwke2h9IEwwLCR7aH0gWmA7CiAgY29uc3QgY29sb3IgPSBwb3NpdGl2ZSA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS1uZWcpIjsKICBjb25zdCBnaWQgPSAic2ciK01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsOSk7CiAgcmV0",
  "dXJuIGA8c3ZnIHZpZXdCb3g9IjAgMCAke3d9ICR7aH0iIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIHByZXNlcnZlQXNwZWN0UmF0aW89Im5vbmUiPgogICAgPGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSIke2dpZH0iIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHky",
  "PSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iJHtjb2xvcn0iIHN0b3Atb3BhY2l0eT0iMC4zNSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiR7Y29sb3J9IiBzdG9wLW9wYWNpdHk9IjAiLz4KICAgIDwvbGlu",
  "ZWFyR3JhZGllbnQ+PC9kZWZzPgogICAgPHBhdGggZD0iJHthcmVhUGF0aH0iIGZpbGw9InVybCgjJHtnaWR9KSIgc3Ryb2tlPSJub25lIi8+CiAgICA8cGF0aCBkPSIke3BhdGh9IiBmaWxsPSJub25lIiBzdHJva2U9IiR7Y29sb3J9IiBzdHJva2Utd2lkdGg9IjEu",
  "NiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIi8+CiAgPC9zdmc+YDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBBTUJJRU5UIERFQ09S",
  "QVRJVkUgTElORVMgKGRyYXduIG9uY2UpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KKGZ1bmN0aW9uIGRyYXdBbWJpZW50TGluZXMoKXsKICBjb25zdCBzdmcgPSBkb2N1bWVudC5n",
  "ZXRFbGVtZW50QnlJZCgiYW1iaWVudExpbmVzIik7CiAgY29uc3QgdyA9IDE0MDAsIGggPSA4MDA7CiAgc3ZnLnNldEF0dHJpYnV0ZSgidmlld0JveCIsIGAwIDAgJHt3fSAke2h9YCk7CiAgbGV0IGh0bWwgPSAiIjsKICBmb3IobGV0IGk9MDtpPDM7aSsrKXsKICAg",
  "IGNvbnN0IHNlZWQgPSBpKjE3KzM7CiAgICBjb25zdCBwdHMgPSBbXTsKICAgIGNvbnN0IG4gPSAxMjsKICAgIGZvcihsZXQgaj0wO2o8PW47aisrKXsKICAgICAgY29uc3QgeCA9IChqL24pKnc7CiAgICAgIGNvbnN0IHkgPSBoKjAuMjUgKyBpKjEzMCArIChzZWVk",
  "ZWRSYW5kKHNlZWQraiktMC41KSo5MDsKICAgICAgcHRzLnB1c2goW3gseV0pOwogICAgfQogICAgY29uc3QgcGF0aCA9IHB0cy5tYXAoKHAsaWR4KT0+KGlkeD09PTA/Ik0iOiJMIikrcFswXS50b0ZpeGVkKDApKyIsIitwWzFdLnRvRml4ZWQoMCkpLmpvaW4oIiAi",
  "KTsKICAgIGNvbnN0IGNvbG9ycyA9IFsiIzRDN0RGRiIsIiM4QjZCRjAiLCIjMzFENUVFIl07CiAgICBodG1sICs9IGA8cGF0aCBkPSIke3BhdGh9IiBmaWxsPSJub25lIiBzdHJva2U9IiR7Y29sb3JzW2klM119IiBzdHJva2Utd2lkdGg9IjEiIG9wYWNpdHk9IjAu",
  "MTAiLz5gOwogIH0KICBzdmcuaW5uZXJIVE1MID0gaHRtbDsKfSkoKTsKCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSEVBREVSIEJFSEFWSU9SCiAgID09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3QgdG9wYmFyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRvcGJhciIpOwp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigic2Nyb2xsIiwgKCk9PnsKICB0b3BiYXIu",
  "Y2xhc3NMaXN0LnRvZ2dsZSgic2Nyb2xsZWQiLCB3aW5kb3cuc2Nyb2xsWSA+IDgpOwp9KTsKCmZ1bmN0aW9uIHNldEFjdGl2ZU5hdih2aWV3KXsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIjbWFpbk5hdiBidXR0b24sICNib3R0b21OYXYgYnV0dG9uIiku",
  "Zm9yRWFjaChiPT57CiAgICBiLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGIuZGF0YXNldC52aWV3PT09dmlldyk7CiAgfSk7Cn0KZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1haW5OYXYiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGU9PnsKICBjb25z",
  "dCBidG4gPSBlLnRhcmdldC5jbG9zZXN0KCJidXR0b25bZGF0YS12aWV3XSIpOwogIGlmKGJ0bikgbmF2aWdhdGUoYnRuLmRhdGFzZXQudmlldyk7Cn0pOwpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYm90dG9tTmF2IikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2si",
  "LCBlPT57CiAgY29uc3QgYnRuID0gZS50YXJnZXQuY2xvc2VzdCgiYnV0dG9uW2RhdGEtdmlld10iKTsKICBpZihidG4pIG5hdmlnYXRlKGJ0bi5kYXRhc2V0LnZpZXcpOwp9KTsKCmZ1bmN0aW9uIG5hdmlnYXRlKHZpZXcsIHRpY2tlcil7CiAgc3RhdGUudmlldyA9",
  "IHZpZXc7CiAgaWYodGlja2VyKSBzdGF0ZS5kZXRhaWxUaWNrZXIgPSB0aWNrZXI7CiAgc2V0QWN0aXZlTmF2KHZpZXcgPT09ICJkZXRhaWwiID8gIm1hcmtldHMiIDogdmlldyk7CiAgd2luZG93LnNjcm9sbFRvKHt0b3A6MCwgYmVoYXZpb3I6IHdpbmRvdy5tYXRj",
  "aE1lZGlhKCcocHJlZmVycy1yZWR1Y2VkLW1vdGlvbjogcmVkdWNlKScpLm1hdGNoZXMgPyAiYXV0byIgOiAic21vb3RoIn0pOwogIHJlbmRlcigpOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09CiAgIE1BUktFVCBTVEFUVVMgKElTVCBidXNpbmVzcyBob3VycywgcHVyZWx5IHByZXNlbnRhdGlvbmFsKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCihmdW5jdGlvbiBt",
  "YXJrZXRTdGF0dXMoKXsKICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpOwogIGNvbnN0IGlzdEhvdXIgPSAobm93LmdldFVUQ0hvdXJzKCkrNSklMjQgKyAobm93LmdldFVUQ01pbnV0ZXMoKSszMD49NjA/MTowKTsKICBjb25zdCBtaW5zID0gKG5vdy5nZXRVVENNaW51",
  "dGVzKCkrMzApJTYwOwogIGNvbnN0IHRvdGFsTWluID0gKChub3cuZ2V0VVRDSG91cnMoKSs1KSUyNCkqNjAgKyBtaW5zOwogIGNvbnN0IG9wZW4gPSB0b3RhbE1pbiA+PSA1NTUgJiYgdG90YWxNaW4gPD0gOTMwOyAvLyA5OjE1IC0gMTU6MzAgSVNUCiAgc2V0VGV4",
  "dCgibWFya2V0U3RhdHVzVGV4dCIsIG9wZW4gPyAiTWFya2V0IE9wZW4iIDogIk1hcmtldCBDbG9zZWQiKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCIuZG90LWxpdmUiKS5zdHlsZS5iYWNrZ3JvdW5kID0gb3BlbiA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS10",
  "ZXh0LWZhaW50KSI7Cn0pKCk7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFJFTkRFUjogUk9PVAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IHJvb3QgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFpblJvb3QiKTsKCmZ1bmN0aW9uIHJlbmRlcigpewogIGlmKHN0YXRlLnZpZXcgPT09ICJkYXNoYm9hcmQiKSByZW5kZXJEYXNoYm9hcmQoKTsKICBl",
  "bHNlIGlmKHN0YXRlLnZpZXcgPT09ICJzY3JlZW5lciIpIHJlbmRlclNjcmVlbmVyKCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAibWFya2V0cyIpIHJlbmRlck1hcmtldHMoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJ3YXRjaGxpc3QiKSByZW5kZXJX",
  "YXRjaGxpc3QoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJkZXRhaWwiKSByZW5kZXJEZXRhaWwoKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBEQVNIQk9BUkQgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmQoKXsK",
  "ICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciIGlkPSJkYXNoVmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPk1hcmtldCBPdmVydmlldzwvaDI+PHNwYW4gY2xhc3M9InN1YiI+UmVhbC10aW1lIGluZGV4IHNu",
  "YXBzaG90PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoZXJvLXJvdyIgaWQ9ImluZGljZXNSb3ciPgogICAgICAgICR7c2tlbGV0b25DYXJkcygzKX0KICAgICAgPC9kaXY+CgogICAgICAke3NlYXJjaEJsb2NrKCl9CgogICAgICA8ZGl2IGNsYXNzPSJz",
  "ZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXQgQnJlYWR0aDwvaDI+PHNwYW4gY2xhc3M9InN1YiI+QWR2YW5jZXJzIHZzIGRlY2xpbmVycywgZnVsbCB1bml2ZXJzZTwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgYnJlYWR0aC1jYXJkIiBpZD0iYnJl",
  "YWR0aENhcmQiIHN0eWxlPSJwYWRkaW5nOjE4cHggMjJweDttYXJnaW4tYm90dG9tOjM0cHg7Ij4ke3NrZWxldG9uTGluZXMoMil9PC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5Ub3AgTW92ZXJzPC9oMj48c3BhbiBjbGFzcz0ic3Vi",
  "Ij5CeSBhYnNvbHV0ZSBjaGFuZ2UgdG9kYXk8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJtb3ZlcnNUYWJsZVdyYXAiPjxkaXYgc3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tlbGV0b25MaW5lcyg2KX08L2Rpdj48",
  "L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2FyZHMiIGlkPSJtb3ZlcnNDYXJkcyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIHdpcmVTZWFyY2goKTsKCiAgdHJ5ewogICAgY29uc3QgaW5kaWNlcyA9IGF3YWl0IEFQSS5mZXRjaEluZGljZXMoKTsKICAg",
  "IGNvbnN0IGluZGljZXNSb3dFbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJpbmRpY2VzUm93Iik7CiAgICBpbmRpY2VzUm93RWwuaW5uZXJIVE1MID0gaW5kaWNlcy5tYXAoaW5kZXhDYXJkSFRNTCkuam9pbigiIik7CiAgICBydW5Db3VudFVwcyhpbmRpY2Vz",
  "Um93RWwpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLmluZGV4LXNwYXJrIikuZm9yRWFjaCgoZWwsaSk9PnsKICAgICAgZWwuaW5uZXJIVE1MID0gc3BhcmtsaW5lU1ZHKGluZGljZXNbaV0uc2VyaWVzLCBpbmRpY2VzW2ldLmNoYW5nZT49MCk7CiAg",
  "ICB9KTsKICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiaW5kaWNlc1JvdyIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJNYXJrZXQgZGF0YSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4ndCByZWFjaCB0aGUg",
  "aW5kaWNlcyBmZWVkLiBQbGVhc2UgdHJ5IGFnYWluIHNob3J0bHkuIik7CiAgfQoKICB0cnl7CiAgICBjb25zdCBmdWxsID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHt9KTsKICAgIHRyeXsKICAgICAgcmVuZGVyQnJlYWR0aChmdWxsKTsKICAgIH1j",
  "YXRjaChlKXsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJyZWFkdGhDYXJkIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIkJyZWFkdGggZGF0YSB1bmF2YWlsYWJsZSIsICJDb3VsZG4ndCBjb21wdXRlIGFkdmFuY2VycyB2cyBkZWNsaW5lcnMu",
  "ICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgICAgc2hvd0Vycm9yQmFubmVyKCJyZW5kZXJCcmVhZHRoIGZhaWxlZDogIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSk7CiAgICB9CiAgICB0cnl7CiAgICAgIGNvbnN0IG1vdmVycyA9IGZ1bGwu",
  "c2xpY2UoKS5zb3J0KChhLGIpPT5NYXRoLmFicyhiLnBjdCktTWF0aC5hYnMoYS5wY3QpKS5zbGljZSgwLDgpOwogICAgICByZW5kZXJUYWJsZUludG8oIm1vdmVyc1RhYmxlV3JhcCIsICJtb3ZlcnNDYXJkcyIsIG1vdmVycywge2tleToicGN0IiwgZGlyOiJkZXNj",
  "In0sIGZhbHNlKTsKICAgIH1jYXRjaChlKXsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1vdmVyc1RhYmxlV3JhcCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gcmV0cmlldmUgbW92ZXJzIiwgIlNvbWV0aGluZyB3ZW50IHdy",
  "b25nIGxvYWRpbmcgdGhpcyBsaXN0LiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7CiAgICAgIHNob3dFcnJvckJhbm5lcigibW92ZXJzIHRhYmxlIHJlbmRlciBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogICAgfQogIH1jYXRj",
  "aChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtb3ZlcnNUYWJsZVdyYXAiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIG1vdmVycyIsICJTb21ldGhpbmcgd2VudCB3cm9uZyBsb2FkaW5nIHRoaXMgbGlzdC4g",
  "KCIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkgKyAiKSIpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJyZWFkdGhDYXJkIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIkJyZWFkdGggZGF0YSB1bmF2YWlsYWJsZSIsICJDb3VsZG4ndCBjb21wdXRl",
  "IGFkdmFuY2VycyB2cyBkZWNsaW5lcnMuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIHNob3dFcnJvckJhbm5lcigiZmV0Y2hTY3JlZW5lclJlc3VsdHMgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICB9Cn0KCmZ1bmN0",
  "aW9uIHJlbmRlckJyZWFkdGgobGlzdCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYnJlYWR0aENhcmQiKTsKICBpZighZWwgfHwgIWxpc3QubGVuZ3RoKXsgaWYoZWwpIGVsLmlubmVySFRNTCA9IGVtcHR5U3RhdGVIVE1MKCJObyBicmVh",
  "ZHRoIGRhdGEiLCAiTm8gc3RvY2tzIHdlcmUgcmV0dXJuZWQgdG8gY29tcHV0ZSB0aGlzIGZyb20uIik7IHJldHVybjsgfQogIGNvbnN0IGFkdmFuY2VycyA9IGxpc3QuZmlsdGVyKHM9PnMucGN0PjApLmxlbmd0aDsKICBjb25zdCBkZWNsaW5lcnMgPSBsaXN0LmZp",
  "bHRlcihzPT5zLnBjdDwwKS5sZW5ndGg7CiAgY29uc3QgZmxhdCA9IGxpc3QubGVuZ3RoIC0gYWR2YW5jZXJzIC0gZGVjbGluZXJzOwogIGNvbnN0IHRvdGFsID0gbGlzdC5sZW5ndGg7CiAgY29uc3QgYWR2UGN0ID0gKGFkdmFuY2Vycy90b3RhbCkqMTAwLCBkZWNQ",
  "Y3QgPSAoZGVjbGluZXJzL3RvdGFsKSoxMDAsIGZsYXRQY3QgPSAoZmxhdC90b3RhbCkqMTAwOwogIGVsLmlubmVySFRNTCA9IGAKICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpiYXNl",
  "bGluZTttYXJnaW4tYm90dG9tOjEycHg7ZmxleC13cmFwOndyYXA7Z2FwOjhweDsiPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjIwcHg7Ij4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9u",
  "dC1zaXplOjIwcHg7Y29sb3I6dmFyKC0tcG9zLXNvZnQpOyIgZGF0YS1jb3VudHVwPSIke2FkdmFuY2Vyc30iIGRhdGEtZGVjaW1hbHM9IjAiPjA8L3NwYW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPmFkdmFuY2lu",
  "Zzwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjIwcHg7Y29sb3I6dmFyKC0tbmVnLXNvZnQpOyIgZGF0YS1jb3VudHVwPSIke2RlY2xpbmVyc30iIGRhdGEtZGVjaW1hbHM9",
  "IjAiPjA8L3NwYW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPmRlY2xpbmluZzwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXpl",
  "OjIwcHg7Y29sb3I6dmFyKC0tdGV4dC1taWQpOyIgZGF0YS1jb3VudHVwPSIke2ZsYXR9IiBkYXRhLWRlY2ltYWxzPSIwIj4wPC9zcGFuPiA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEycHg7Ij51bmNoYW5nZWQ8L3NwYW4+PC9k",
  "aXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6MTEuNXB4O2NvbG9yOnZhcigtLXRleHQtZmFpbnQpOyI+b2YgJHt0b3RhbH0gdHJhY2tlZCBzdG9ja3M8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iYnJlYWR0aC1iYXIi",
  "IHN0eWxlPSJkaXNwbGF5OmZsZXg7aGVpZ2h0OjEwcHg7Ym9yZGVyLXJhZGl1czo2cHg7b3ZlcmZsb3c6aGlkZGVuO2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7Ij4KICAgICAgPGRpdiBzdHlsZT0id2lkdGg6MCU7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQo",
  "OTBkZWcsdmFyKC0tcG9zKSx2YXIoLS1wb3Mtc29mdCkpO3RyYW5zaXRpb246d2lkdGggMXMgY3ViaWMtYmV6aWVyKC4xNiwxLC4zLDEpIC4xczsiIGRhdGEtdz0iJHthZHZQY3R9Ij48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0id2lkdGg6MCU7YmFja2dyb3VuZDp2",
  "YXIoLS10ZXh0LWZhaW50KTt0cmFuc2l0aW9uOndpZHRoIDFzIGN1YmljLWJlemllciguMTYsMSwuMywxKSAuMXM7IiBkYXRhLXc9IiR7ZmxhdFBjdH0iPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDowJTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5",
  "MGRlZyx2YXIoLS1uZWctc29mdCksdmFyKC0tbmVnKSk7dHJhbnNpdGlvbjp3aWR0aCAxcyBjdWJpYy1iZXppZXIoLjE2LDEsLjMsMSkgLjFzOyIgZGF0YS13PSIke2RlY1BjdH0iPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKICBydW5Db3VudFVwcyhlbCk7CiAgcmVx",
  "dWVzdEFuaW1hdGlvbkZyYW1lKCgpPT4gcmVxdWVzdEFuaW1hdGlvbkZyYW1lKCgpPT57CiAgICBlbC5xdWVyeVNlbGVjdG9yQWxsKCIuYnJlYWR0aC1iYXIgW2RhdGEtd10iKS5mb3JFYWNoKGJhcj0+eyBiYXIuc3R5bGUud2lkdGggPSBiYXIuZGF0YXNldC53ICsg",
  "IiUiOyB9KTsKICB9KSk7Cn0KCmZ1bmN0aW9uIGluZGV4Q2FyZEhUTUwoaWR4KXsKICBjb25zdCBwb3NpdGl2ZSA9IGlkeC5jaGFuZ2UgPj0gMDsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImdsYXNzIGluZGV4LWNhcmQiPgogICAgPGRpdiBjbGFzcz0icm93MSI+",
  "CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtbmFtZSI+JHtpZHguY29kZX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJpbmRleC1mdWxsIj4ke2lkeC5mdWxsfTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaW5kZXgt",
  "YmFkZ2UgJHtwb3NpdGl2ZT8ncG9zJzonbmVnJ30iPgogICAgICAgICR7cG9zaXRpdmU/J+KWsic6J+KWvCd9ICR7cGN0U3RyKGlkeC5wY3QpfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtdmFsdWUgaW5kZXgtdmFsdWUtZ3Jh",
  "ZGllbnQgdGFidWxhciIgZGF0YS1jb3VudHVwPSIke2lkeC52YWx1ZX0iIGRhdGEtZGVjaW1hbHM9IjIiPjA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LWNoYW5nZSAke3Bvc2l0aXZlPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihpZHguY2hhbmdl",
  "KX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXNwYXJrIj48L2Rpdj4KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiBza2VsZXRvbkNhcmRzKG4pewogIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6bn0pLm1hcCgoKT0+YDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwt",
  "Y2FyZCBza2VsIj48L2Rpdj5gKS5qb2luKCIiKTsKfQpmdW5jdGlvbiBza2VsZXRvbkxpbmVzKG4pewogIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6bn0pLm1hcCgoKT0+YDxkaXYgY2xhc3M9InNrZWwgc2tlbC1saW5lIiBzdHlsZT0id2lkdGg6JHs2MCtNYXRo",
  "LnJhbmRvbSgpKjM1fSUiPjwvZGl2PmApLmpvaW4oIiIpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNFQVJDSCAtLS0tLS0tLS0tLS0tLS0tICovCmZ1bmN0aW9uIHNlYXJjaEJsb2NrKCl7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJzZWFyY2gtd3JhcCIgc3R5",
  "bGU9Im1hcmdpbi10b3A6OHB4OyI+CiAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtYm94IGdsYXNzIiBpZD0ic2VhcmNoQm94Ij4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9",
  "IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNyIvPjxwYXRoIGQ9Ik0yMSAyMWwtNC4zLTQuMyIvPjwvc3ZnPgogICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9InNlYXJjaElucHV0IiBwbGFjZWhvbGRlcj0iU2Vh",
  "cmNoIHN0b2NrcyBieSBuYW1lIG9yIHRpY2tlcuKApiIgYXV0b2NvbXBsZXRlPSJvZmYiPgogICAgICA8a2JkIGNsYXNzPSJrc2hvcnRjdXQiPi88L2tiZD4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0ic2VhcmNoLWRyb3AgZ2xhc3MiIGlkPSJzZWFyY2hEcm9w",
  "IiBzdHlsZT0iZGlzcGxheTpub25lOyI+PC9kaXY+CiAgPC9kaXY+YDsKfQoKbGV0IHNlYXJjaERlYm91bmNlOwpmdW5jdGlvbiB3aXJlU2VhcmNoKCl7CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoSW5wdXQiKTsKICBjb25z",
  "dCBib3ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoQm94Iik7CiAgY29uc3QgZHJvcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hEcm9wIik7CiAgaWYoIWlucHV0KSByZXR1cm47CgogIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIo",
  "ImtleWRvd24iLCAoZSk9PnsKICAgIGlmKGUua2V5ID09PSAiLyIgJiYgZG9jdW1lbnQuYWN0aXZlRWxlbWVudCAhPT0gaW5wdXQpewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGlucHV0LmZvY3VzKCk7CiAgICB9CiAgICBpZihlLmtleSA9PT0gIkVz",
  "Y2FwZSIpeyBpbnB1dC5ibHVyKCk7IGRyb3Auc3R5bGUuZGlzcGxheT0ibm9uZSI7IGJveC5jbGFzc0xpc3QucmVtb3ZlKCJmb2N1c2VkIik7IH0KICB9KTsKCiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiZm9jdXMiLCAoKT0+IGJveC5jbGFzc0xpc3QuYWRkKCJm",
  "b2N1c2VkIikpOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImJsdXIiLCAoKT0+IHNldFRpbWVvdXQoKCk9PnsgYm94LmNsYXNzTGlzdC5yZW1vdmUoImZvY3VzZWQiKTsgZHJvcC5zdHlsZS5kaXNwbGF5PSJub25lIjsgfSwgMTYwKSk7CgogIGlucHV0LmFkZEV2",
  "ZW50TGlzdGVuZXIoImlucHV0IiwgKCk9PnsKICAgIGNsZWFyVGltZW91dChzZWFyY2hEZWJvdW5jZSk7CiAgICBjb25zdCBxID0gaW5wdXQudmFsdWU7CiAgICBpZighcS50cmltKCkpeyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyByZXR1cm47IH0KICAgIGRy",
  "b3Auc3R5bGUuZGlzcGxheT0iYmxvY2siOwogICAgZHJvcC5pbm5lckhUTUwgPSBgPGRpdiBzdHlsZT0icGFkZGluZzoxNHB4IDE2cHg7Ij4ke3NrZWxldG9uTGluZXMoMyl9PC9kaXY+YDsKICAgIHNlYXJjaERlYm91bmNlID0gc2V0VGltZW91dChhc3luYyAoKT0+",
  "ewogICAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgQVBJLnNlYXJjaFN0b2NrcyhxKTsKICAgICAgaWYoIXJlc3VsdHMubGVuZ3RoKXsKICAgICAgICBkcm9wLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJzZWFyY2gtZW1wdHkiPk5vIHN0b2NrcyBtYXRjaCDigJwk",
  "e2VzY2FwZUh0bWwocSl94oCdPC9kaXY+YDsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgZHJvcC5pbm5lckhUTUwgPSByZXN1bHRzLm1hcCgocyxpKT0+YAogICAgICAgIDxkaXYgY2xhc3M9InNlYXJjaC1yb3ciIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6",
  "JHtpKjI4fW1zIiBkYXRhLXRpY2tlcj0iJHtzLnR9Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InNyLWxlZnQiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJzci10aWNrZXIiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAg",
  "ICAgICAgPGRpdiBjbGFzcz0ic3ItbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ic3ItbWV0YSI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2",
  "PgogICAgICAgICAgPGRpdiBjbGFzcz0ic3ItcHJpY2UgdGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIGApLmpvaW4oIiIpOwogICAgICBkcm9wLnF1ZXJ5U2VsZWN0b3JBbGwoIi5zZWFyY2gtcm93IikuZm9yRWFj",
  "aChyb3c9PnsKICAgICAgICByb3cuYWRkRXZlbnRMaXN0ZW5lcigibW91c2Vkb3duIiwgKCk9PnsKICAgICAgICAgIG5hdmlnYXRlKCJkZXRhaWwiLCByb3cuZGF0YXNldC50aWNrZXIpOwogICAgICAgIH0pOwogICAgICB9KTsKICAgIH0sIDI2MCk7CiAgfSk7Cn0K",
  "ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaFRvZ2dsZUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hJbnB1dCIpOwogIGlmKGlucHV0KSBpbnB1dC5m",
  "b2N1cygpOwogIGVsc2UgbmF2aWdhdGUoImRhc2hib2FyZCIpOwp9KTsKCi8qIC0tLS0tLS0tLS0tLS0tLS0gU0hBUkVEIFRBQkxFIFJFTkRFUiAtLS0tLS0tLS0tLS0tLS0tICovCmZ1bmN0aW9uIHJlbmRlclRhYmxlSW50byh3cmFwSWQsIGNhcmRzSWQsIGxpc3Qs",
  "IHNvcnQsIHNob3dTZWN0b3JDb2wpewogIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCh3cmFwSWQpOwogIGNvbnN0IGNhcmRzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoY2FyZHNJZCk7CiAgaWYoIWxpc3QubGVuZ3RoKXsKICAgIHdyYXAu",
  "aW5uZXJIVE1MID0gZW1wdHlTdGF0ZUhUTUwoIk5vIHN0b2NrcyBtYXRjaCB5b3VyIGZpbHRlcnMiLCAiVHJ5IHdpZGVuaW5nIHlvdXIgcHJpY2UgcmFuZ2Ugb3IgY2xlYXJpbmcgYSBmaWx0ZXIuIik7CiAgICBpZihjYXJkcykgY2FyZHMuaW5uZXJIVE1MID0gIiI7",
  "CiAgICByZXR1cm47CiAgfQogIGNvbnN0IHNvcnRlZCA9IHNvcnRTdG9ja3MobGlzdCwgc29ydCk7CgogIHdyYXAuaW5uZXJIVE1MID0gYAogICAgPHRhYmxlIGNsYXNzPSJzdG9jay10YWJsZSI+CiAgICAgIDx0aGVhZD48dHI+CiAgICAgICAgPHRoPjwvdGg+CiAg",
  "ICAgICAgPHRoIGRhdGEta2V5PSJuYW1lIj5Db21wYW55PHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9InByaWNlIj5QcmljZTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAg",
  "ICAgPHRoIGRhdGEta2V5PSJjaGFuZ2UiPkNoYW5nZTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJwY3QiPkNoYW5nZSAlPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAg",
  "ICA8dGggZGF0YS1rZXk9Im1hcmtldENhcCI+TWFya2V0IENhcDxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJ2b2x1bWUiPlZvbHVtZTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+",
  "CiAgICAgICAgPHRoIGRhdGEta2V5PSJoaWdoNTIiPjUyVyBIaWdoPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImxvdzUyIj41MlcgTG93PHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90",
  "aD4KICAgICAgPC90cj48L3RoZWFkPgogICAgICA8dGJvZHk+CiAgICAgICAgJHtzb3J0ZWQubWFwKChzLGkpPT5zdG9ja1Jvd0hUTUwocyxpKSkuam9pbigiIil9CiAgICAgIDwvdGJvZHk+CiAgICA8L3RhYmxlPgogIGA7CiAgd3JhcC5xdWVyeVNlbGVjdG9yQWxs",
  "KCJ0aFtkYXRhLWtleV0iKS5mb3JFYWNoKHRoPT57CiAgICB0aC5jbGFzc0xpc3QudG9nZ2xlKCJzb3J0ZWQiLCB0aC5kYXRhc2V0LmtleT09PXNvcnQua2V5KTsKICAgIGlmKHRoLmRhdGFzZXQua2V5PT09c29ydC5rZXkpeyBjb25zdCBpbmQgPSB0aC5xdWVyeVNl",
  "bGVjdG9yKCIuc29ydC1pbmQiKTsgaWYoaW5kKSBpbmQudGV4dENvbnRlbnQgPSBzb3J0LmRpcj09PSJkZXNjIj8i4pa+Ijoi4pa0IjsgfQogICAgdGguYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgICBjb25zdCBrZXkgPSB0aC5kYXRhc2V0Lmtl",
  "eTsKICAgICAgY29uc3QgbmV3RGlyID0gKHNvcnQua2V5PT09a2V5ICYmIHNvcnQuZGlyPT09ImRlc2MiKSA/ICJhc2MiIDogImRlc2MiOwogICAgICBjb25zdCBuZXdTb3J0ID0ge2tleSwgZGlyOm5ld0Rpcn07CiAgICAgIGlmKHdyYXBJZD09PSJzY3JlZW5lclRh",
  "YmxlV3JhcCIpIHN0YXRlLnNjcmVlbmVyU29ydCA9IG5ld1NvcnQ7CiAgICAgIHJlbmRlclRhYmxlSW50byh3cmFwSWQsIGNhcmRzSWQsIGxpc3QsIG5ld1NvcnQsIHNob3dTZWN0b3JDb2wpOwogICAgfSk7CiAgfSk7CiAgd2lyZVJvd0ludGVyYWN0aW9ucyh3cmFw",
  "KTsKCiAgaWYoY2FyZHMpewogICAgY2FyZHMuaW5uZXJIVE1MID0gc29ydGVkLm1hcCgocyxpKT0+c3RvY2tDYXJkSFRNTChzLGkpKS5qb2luKCIiKTsKICAgIHdpcmVSb3dJbnRlcmFjdGlvbnMoY2FyZHMpOwogIH0KfQoKZnVuY3Rpb24gc29ydFN0b2NrcyhsaXN0",
  "LCBzb3J0KXsKICByZXR1cm4gbGlzdC5zbGljZSgpLnNvcnQoKGEsYik9PnsKICAgIGxldCBhdj1hW3NvcnQua2V5XSwgYnY9Yltzb3J0LmtleV07CiAgICBpZihzb3J0LmtleT09PSJuYW1lIil7IGF2PWEubmFtZTsgYnY9Yi5uYW1lOyByZXR1cm4gc29ydC5kaXI9",
  "PT0iYXNjIj8gYXYubG9jYWxlQ29tcGFyZShidikgOiBidi5sb2NhbGVDb21wYXJlKGF2KTsgfQogICAgcmV0dXJuIHNvcnQuZGlyPT09ImFzYyIgPyBhdi1idiA6IGJ2LWF2OwogIH0pOwp9CgpmdW5jdGlvbiBzdG9ja1Jvd0hUTUwocyxpKXsKICBjb25zdCBwb3Mg",
  "PSBzLnBjdD49MDsKICBjb25zdCBpbldhdGNoID0gc3RhdGUud2F0Y2hsaXN0LmluY2x1ZGVzKHMudCk7CiAgcmV0dXJuIGAKICA8dHIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjJ9bXMiPgogICAgPHRkIG9uY2xpY2s9",
  "ImV2ZW50LnN0b3BQcm9wYWdhdGlvbigpIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0ic3Rhci1idG4gJHtpbldhdGNoPydhY3RpdmUnOicnfSIgZGF0YS1zdGFyPSIke3MudH0iIHRpdGxlPSIke2luV2F0Y2g/J1JlbW92ZSBmcm9tIHdhdGNobGlzdCc6J0FkZCB0byB3",
  "YXRjaGxpc3QnfSI+CiAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9IiR7aW5XYXRjaD8nY3VycmVudENvbG9yJzonbm9uZSd9IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgMTcuM2wtNi4xNiAz",
  "LjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICA8L2J1dHRvbj4KICAgIDwvdGQ+CiAgICA8dGQ+CiAgICAgIDxkaXYgY2xhc3M9ImNlbGwtY29tcGFueSI+CiAgICAg",
  "ICAgPGRpdiBjbGFzcz0iY2VsbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgICA8ZGl2",
  "IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRh",
  "YnVsYXIiPjxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8ncG9zJzonbmVnJ30iPiR7Y2hnU3RyKHMuY2hhbmdlKX08L3NwYW4+PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+PHNwYW4gY2xhc3M9ImNoYW5nZS1waWxsICR7cG9zPydwb3MnOiduZWcn",
  "fSI+JHtwY3RTdHIocy5wY3QpfTwvc3Bhbj48L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdENvbXBhY3Qocy5tYXJrZXRDYXApfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10Vm9sKHMudm9sdW1lKX08L3RkPgogICAgPHRkIGNsYXNz",
  "PSJ0YWJ1bGFyIj4ke2ZtdElOUihzLmhpZ2g1Mil9PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRJTlIocy5sb3c1Mil9PC90ZD4KICA8L3RyPmA7Cn0KCmZ1bmN0aW9uIHN0b2NrQ2FyZEhUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBjdD49MDsK",
  "ICBjb25zdCBpbldhdGNoID0gc3RhdGUud2F0Y2hsaXN0LmluY2x1ZGVzKHMudCk7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJnbGFzcyBzdG9jay1jYXJkIiBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSoyNn1tcyI+CiAg",
  "ICA8ZGl2IGNsYXNzPSJsZWZ0Ij4KICAgICAgPGRpdiBjbGFzcz0iY2VsbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im5hbWUtYmxvY2siPgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSI+JHtl",
  "c2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJpZ2h0Ij4KICAgICAgPGRpdiBjbGFzcz0i",
  "cHJpY2UgdGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICAgIDxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8ncG9zJzonbmVnJ30iIHN0eWxlPSJtYXJnaW4tdG9wOjRweDsiPiR7cGN0U3RyKHMucGN0KX08L3NwYW4+CiAgICA8L2Rpdj4K",
  "ICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiB3aXJlUm93SW50ZXJhY3Rpb25zKGNvbnRhaW5lcil7CiAgY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoInRyW2RhdGEtdGlja2VyXSwgLnN0b2NrLWNhcmRbZGF0YS10aWNrZXJdIikuZm9yRWFjaChlbD0+ewogICAgZWwu",
  "YWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+IG5hdmlnYXRlKCJkZXRhaWwiLCBlbC5kYXRhc2V0LnRpY2tlcikpOwogIH0pOwogIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1zdGFyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZl",
  "bnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTsKICAgICAgdG9nZ2xlV2F0Y2goYnRuLmRhdGFzZXQuc3Rhcik7CiAgICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiKTsKICAgICAgYnRuLnF1ZXJ5U2VsZWN0",
  "b3IoInN2ZyIpLnNldEF0dHJpYnV0ZSgiZmlsbCIsIGJ0bi5jbGFzc0xpc3QuY29udGFpbnMoImFjdGl2ZSIpID8gImN1cnJlbnRDb2xvciIgOiAibm9uZSIpOwogICAgfSk7CiAgfSk7Cn0KCmZ1bmN0aW9uIHRvZ2dsZVdhdGNoKHRpY2tlcil7CiAgY29uc3QgaWR4",
  "ID0gc3RhdGUud2F0Y2hsaXN0LmluZGV4T2YodGlja2VyKTsKICBpZihpZHg+PTApIHN0YXRlLndhdGNobGlzdC5zcGxpY2UoaWR4LDEpOwogIGVsc2Ugc3RhdGUud2F0Y2hsaXN0LnB1c2godGlja2VyKTsKICBwZXJzaXN0V2F0Y2hsaXN0KCk7Cn0KCi8qIC0tLS0t",
  "LS0tLS0tLS0tLS0gU0NSRUVORVIgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJTY3JlZW5lcigpewogIGNvbnN0IHNlY3RvcnMgPSBbIkFsbCIsIC4uLkFycmF5LmZyb20obmV3IFNldChVTklWRVJTRS5tYXAocz0+cy5zZWN0b3IpKSld",
  "OwogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPlNjcmVlbmVyPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5GaWx0ZXIgdGhlIG1hcmtldCBvbiB5b3VyIHRlcm1zPC9zcGFu",
  "PjwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iYWktcXVlcnktYm94IGdsYXNzIj4KICAgICAgICA8ZGl2IGNsYXNzPSJhaS1xdWVyeS1yb3ciPgogICAgICAgICAgPGRpdiBjbGFzcz0iYWktYXZhdGFyIiBzdHlsZT0id2lkdGg6MjRweDtoZWlnaHQ6MjRweDtmb250",
  "LXNpemU6MTJweDsiPuKcpjwvZGl2PgogICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIGlkPSJhaVF1ZXJ5SW5wdXQiIHBsYWNlaG9sZGVyPSJBc2sgaW4gcGxhaW4gRW5nbGlzaCDigJQgZS5nLiDigJx3aGljaCBJVCBzdG9ja3MgYXJlIHVwIHRvZGF54oCdIj4K",
  "ICAgICAgICAgIDxidXR0b24gY2xhc3M9ImFpLXF1ZXJ5LWJ0biIgaWQ9ImFpUXVlcnlCdG4iPkFzazwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImFpLXF1ZXJ5LWFuc3dlciIgaWQ9ImFpUXVlcnlBbnN3ZXIiIHN0eWxlPSJkaXNw",
  "bGF5Om5vbmU7Ij48L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJnbGFzcyBmaWx0ZXJzLWJhciI+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiIHN0eWxlPSJtaW4td2lkdGg6MjAwcHg7Ij4KICAgICAgICAgIDxsYWJlbD5TZWFy",
  "Y2g8L2xhYmVsPgogICAgICAgICAgPGlucHV0IHR5cGU9InRleHQiIGlkPSJmUXVlcnkiIHBsYWNlaG9sZGVyPSJUaWNrZXIgb3IgY29tcGFueeKApiIgdmFsdWU9IiR7ZXNjYXBlSHRtbChzdGF0ZS5zY3JlZW5lckZpbHRlcnMucXVlcnkpfSI+CiAgICAgICAgPC9k",
  "aXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiPgogICAgICAgICAgPGxhYmVsPlNlY3RvcjwvbGFiZWw+CiAgICAgICAgICA8c2VsZWN0IGlkPSJmU2VjdG9yIj4ke3NlY3RvcnMubWFwKHM9PmA8b3B0aW9uICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJz",
  "LnNlY3Rvcj09PXM/J3NlbGVjdGVkJzonJ30+JHtzfTwvb3B0aW9uPmApLmpvaW4oIiIpfTwvc2VsZWN0PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIj4KICAgICAgICAgIDxsYWJlbD5NYXggUHJpY2UgPHNwYW4gY2xhc3M9",
  "InJhbmdlLXZhbCIgaWQ9ImZQcmljZVZhbCI+JHtmbXRJTlIoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFByaWNlLDApfTwvc3Bhbj48L2xhYmVsPgogICAgICAgICAgPGlucHV0IHR5cGU9InJhbmdlIiBjbGFzcz0icmFuZ2Utc2xpZGVyIiBpZD0iZk1heFByaWNl",
  "IiBtaW49IjUwMCIgbWF4PSIxNTAwMCIgc3RlcD0iMjUwIiB2YWx1ZT0iJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2V9Ij4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCIgc3R5bGU9Im1pbi13aWR0aDoxOTBweDsi",
  "PgogICAgICAgICAgPGxhYmVsPkRpcmVjdGlvbjwvbGFiZWw+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUtZ3JvdXAiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUtYnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbj09PSdhbGwn",
  "PydhY3RpdmUnOicnfSIgZGF0YS1kaXI9ImFsbCI+QWxsPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuZGlyZWN0aW9uPT09J2dhaW5lcnMnPydhY3RpdmUnOicnfSIgZGF0YS1kaXI9ImdhaW5l",
  "cnMiPkdhaW5lcnM8L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nbG9zZXJzJz8nYWN0aXZlJzonJ30iIGRhdGEtZGlyPSJsb3NlcnMiPkxvc2VyczwvZGl2PgogICAgICAg",
  "ICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0icmVzZXQtZmlsdGVycyIgaWQ9InJlc2V0RmlsdGVycyI+UmVzZXQgZmlsdGVyczwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyIGlk",
  "PSJzY3JlZW5lckNvdW50Ij5SZXN1bHRzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5Tb3J0ZWQgYnkgbWFya2V0IGNhcDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCBnbGFzcyIgaWQ9InNjcmVlbmVyVGFibGVXcmFwIj48ZGl2IHN0eWxl",
  "PSJwYWRkaW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoOCl9PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0b2NrLWNhcmRzIiBpZD0ic2NyZWVuZXJDYXJkcyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwoKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgi",
  "ZlF1ZXJ5IikuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLCBkZWJvdW5jZShlPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMucXVlcnkgPSBlLnRhcmdldC52YWx1ZTsgcnVuU2NyZWVuZXIoKTsKICB9LCAyNjApKTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJ",
  "ZCgiZlNlY3RvciIpLmFkZEV2ZW50TGlzdGVuZXIoImNoYW5nZSIsIGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3IgPSBlLnRhcmdldC52YWx1ZTsgcnVuU2NyZWVuZXIoKTsKICB9KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZk1heFBy",
  "aWNlIikuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLCBlPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UgPSBOdW1iZXIoZS50YXJnZXQudmFsdWUpOwogICAgc2V0VGV4dCgiZlByaWNlVmFsIiwgZm10SU5SKHN0YXRlLnNjcmVlbmVyRmlsdGVy",
  "cy5tYXhQcmljZSwwKSk7CiAgICBydW5TY3JlZW5lcigpOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRpcl0iKS5mb3JFYWNoKGJ0bj0+ewogICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgICAgc3RhdGUu",
  "c2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbiA9IGJ0bi5kYXRhc2V0LmRpcjsKICAgICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtZGlyXSIpLmZvckVhY2goYj0+Yi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLCBiPT09YnRuKSk7CiAgICAgIHJ1",
  "blNjcmVlbmVyKCk7CiAgICB9KTsKICB9KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicmVzZXRGaWx0ZXJzIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzID0ge3F1ZXJ5OiIiLCBzZWN0b3I6IkFs",
  "bCIsIG1pblByaWNlOjAsIG1heFByaWNlOjE1MDAwLCBkaXJlY3Rpb246ImFsbCJ9OwogICAgcmVuZGVyU2NyZWVuZXIoKTsKICB9KTsKCiAgd2lyZVNjcmVlbmVyQWlRdWVyeSgpOwogIHJ1blNjcmVlbmVyKCk7Cn0KCmZ1bmN0aW9uIHdpcmVTY3JlZW5lckFpUXVl",
  "cnkoKXsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVF1ZXJ5SW5wdXQiKTsKICBjb25zdCBidG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlRdWVyeUJ0biIpOwogIGNvbnN0IGFuc3dlckJveCA9IGRvY3VtZW50LmdldEVs",
  "ZW1lbnRCeUlkKCJhaVF1ZXJ5QW5zd2VyIik7CiAgaWYoIWlucHV0IHx8ICFidG4pIHJldHVybjsKCiAgYXN5bmMgZnVuY3Rpb24gYXNrKCl7CiAgICBjb25zdCBxdWVzdGlvbiA9IGlucHV0LnZhbHVlLnRyaW0oKTsKICAgIGlmKCFxdWVzdGlvbiB8fCBidG4uZGlz",
  "YWJsZWQpIHJldHVybjsKICAgIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICBjb25zdCBvcmlnaW5hbExhYmVsID0gYnRuLnRleHRDb250ZW50OwogICAgYnRuLnRleHRDb250ZW50ID0gIuKApiI7CiAgICBhbnN3ZXJCb3guc3R5bGUuZGlzcGxheSA9ICJibG9jayI7",
  "CiAgICBhbnN3ZXJCb3guaW5uZXJIVE1MID0gc2tlbGV0b25MaW5lcygyKTsKICAgIHRyeXsKICAgICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSBhd2FpdCBjaGVja0xpdmVCYWNrZW5kKCk7CiAgICAgIGlmKCFsaXZlQmFja2VuZEF2YWlsYWJsZSkgdGhyb3cg",
  "bmV3IEVycm9yKCJCYWNrZW5kIG5vdCBjb25uZWN0ZWQuIElmIGl0IHdhcyBqdXN0IGlkbGUsIHRyeSBhZ2FpbiBpbiBhIG1vbWVudC4iKTsKCiAgICAgIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7CiAgICAgIGNvbnN0IGlkID0gc2V0VGltZW91",
  "dCgoKT0+Y3RybC5hYm9ydCgpLCAyMDAwMCk7CiAgICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKENPTkZJRy5BUElfQkFTRSArICIvY2hhdCIsIHsKICAgICAgICBtZXRob2Q6ICJQT1NUIiwKICAgICAgICBoZWFkZXJzOiB7IkNvbnRlbnQtVHlwZSI6ICJhcHBs",
  "aWNhdGlvbi9qc29uIn0sCiAgICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgICAgcXVlc3Rpb24sCiAgICAgICAgICBjb250ZXh0OiBhd2FpdCBidWlsZEFpQ29udGV4dCgpLAogICAgICAgICAgaGlzdG9yeTogW10sCiAgICAgICAgfSksCiAgICAg",
  "ICAgc2lnbmFsOiBjdHJsLnNpZ25hbCwKICAgICAgfSkuZmluYWxseSgoKT0+Y2xlYXJUaW1lb3V0KGlkKSk7CgogICAgICBjb25zdCBqc29uID0gYXdhaXQgcmVzLmpzb24oKTsKICAgICAgaWYoIXJlcy5vayB8fCAhanNvbi5zdWNjZXNzKSB0aHJvdyBuZXcgRXJy",
  "b3IoKGpzb24uZXJyb3IgJiYganNvbi5lcnJvci5tZXNzYWdlKSB8fCAoIlJlcXVlc3QgZmFpbGVkICgiICsgcmVzLnN0YXR1cyArICIpIikpOwogICAgICBhbnN3ZXJCb3guaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImFpLWF2YXRhciIgc3R5bGU9IndpZHRoOjIy",
  "cHg7aGVpZ2h0OjIycHg7Zm9udC1zaXplOjExcHg7ZmxleC1zaHJpbms6MDsiPuKcpjwvZGl2PjxkaXY+JHtlc2NhcGVIdG1sKGpzb24uZGF0YS5hbnN3ZXIpfTwvZGl2PmA7CiAgICB9Y2F0Y2goZSl7CiAgICAgIGFuc3dlckJveC5pbm5lckhUTUwgPSBgPGRpdiBz",
  "dHlsZT0iY29sb3I6dmFyKC0tbmVnLXNvZnQpOyI+Q291bGRuJ3QgZ2V0IGFuIGFuc3dlcjogJHtlc2NhcGVIdG1sKGUgJiYgZS5tZXNzYWdlIHx8IFN0cmluZyhlKSl9PC9kaXY+YDsKICAgIH1maW5hbGx5ewogICAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAg",
  "ICAgYnRuLnRleHRDb250ZW50ID0gb3JpZ2luYWxMYWJlbDsKICAgIH0KICB9CgogIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGFzayk7CiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsIChlKT0+eyBpZihlLmtleSA9PT0gIkVudGVyIikg",
  "YXNrKCk7IH0pOwp9CgpmdW5jdGlvbiBkZWJvdW5jZShmbiwgbXMpewogIGxldCBoOwogIHJldHVybiAoLi4uYXJncyk9PnsgY2xlYXJUaW1lb3V0KGgpOyBoPXNldFRpbWVvdXQoKCk9PmZuKC4uLmFyZ3MpLCBtcyk7IH07Cn0KCmFzeW5jIGZ1bmN0aW9uIHJ1blNj",
  "cmVlbmVyKCl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzY3JlZW5lclRhYmxlV3JhcCIpOwogIGlmKCF3cmFwIHx8IHN0YXRlLnZpZXcgIT09ICJzY3JlZW5lciIpIHJldHVybjsgLy8gdmlldyBub3QgYWN0aXZlIOKAlCBub3RoaW5n",
  "IHRvIHVwZGF0ZQogIHdyYXAuc3R5bGUub3BhY2l0eSA9ICIwLjU1IjsKICB0cnl7CiAgICBjb25zdCByZXN1bHRzID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHN0YXRlLnNjcmVlbmVyRmlsdGVycyk7CiAgICBpZihzdGF0ZS52aWV3ICE9PSAic2Ny",
  "ZWVuZXIiKSByZXR1cm47IC8vIG5hdmlnYXRlZCBhd2F5IHdoaWxlIHRoZSBmZXRjaCB3YXMgaW4gZmxpZ2h0CiAgICBzZXRUZXh0KCJzY3JlZW5lckNvdW50IiwgYFJlc3VsdHMgKCR7cmVzdWx0cy5sZW5ndGh9KWApOwogICAgLy8gT25lLXRpbWUgZGlhZ25vc3Rp",
  "YzogaWYgYSBzZWN0b3IgZmlsdGVyIHlpZWxkcyB6ZXJvLCBzaG93IGV4YWN0bHkgd2hhdAogICAgLy8gc2VjdG9yIHZhbHVlcyBhY3R1YWxseSBleGlzdCBpbiB0aGUgbG9hZGVkIGRhdGEgc28gYSBtaXNtYXRjaCAodHlwbywKICAgIC8vIGNhc2luZywgc3RhbGUg",
  "ZmllbGQpIGlzIHZpc2libGUgaW5zdGVhZCBvZiBndWVzc2VkIGF0LgogICAgaWYocmVzdWx0cy5sZW5ndGggPT09IDAgJiYgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3RvciAmJiBzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yICE9PSAiQWxsIil7CiAgICAg",
  "IHRyeXsKICAgICAgICBjb25zdCB1bmZpbHRlcmVkID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHsuLi5zdGF0ZS5zY3JlZW5lckZpbHRlcnMsIHNlY3RvcjoiQWxsIn0pOwogICAgICAgIGNvbnN0IHNlZW5TZWN0b3JzID0gQXJyYXkuZnJvbShuZXcg",
  "U2V0KHVuZmlsdGVyZWQubWFwKHM9PnMuc2VjdG9yKSkpOwogICAgICAgIHNob3dFcnJvckJhbm5lcihgREVCVUc6IDAgcmVzdWx0cyBmb3Igc2VjdG9yICIke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3J9Ii4gJHt1bmZpbHRlcmVkLmxlbmd0aH0gc3RvY2tz",
  "IGxvYWRlZCB0b3RhbC4gU2VjdG9yIHZhbHVlcyBhY3R1YWxseSBwcmVzZW50OiAke0pTT04uc3RyaW5naWZ5KHNlZW5TZWN0b3JzKX1gKTsKICAgICAgfWNhdGNoKGUpeyAvKiBkaWFnbm9zdGljIG9ubHksIGlnbm9yZSBmYWlsdXJlcyBoZXJlICovIH0KICAgIH0K",
  "ICAgIHJlbmRlclRhYmxlSW50bygic2NyZWVuZXJUYWJsZVdyYXAiLCAic2NyZWVuZXJDYXJkcyIsIHJlc3VsdHMsIHN0YXRlLnNjcmVlbmVyU29ydCwgdHJ1ZSk7CiAgfWNhdGNoKGUpewogICAgd3JhcC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiU2NyZWVu",
  "ZXIgZGF0YSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4ndCBsb2FkIG1hdGNoaW5nIHN0b2NrcyByaWdodCBub3cuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIHNob3dFcnJvckJhbm5lcigicnVuU2NyZWVuZXIgZmFpbGVkOiAiICsgKGUg",
  "JiYgZS5tZXNzYWdlIHx8IGUpKTsKICB9CiAgd3JhcC5zdHlsZS5vcGFjaXR5ID0gIjEiOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIE1BUktFVFMgKGZ1bGwgdW5pdmVyc2UgdGFibGUgKyB0cmVuZGluZyBoaWdobGlnaHRzKSAtLS0tLS0tLS0tLS0tLS0tICovCmFz",
  "eW5jIGZ1bmN0aW9uIHJlbmRlck1hcmtldHMoKXsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXRzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5GdWxsIE5TRSB1",
  "bml2ZXJzZSBzbmFwc2hvdDwvc3Bhbj48L2Rpdj4KICAgICAgJHtzZWFyY2hCbG9jaygpfQoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+VHJlbmRpbmcgTm93PC9oMj48c3BhbiBjbGFzcz0ic3ViIj5Ub2RheSdzIGJpZ2dlc3QgbW92ZXJzLCB1",
  "cCBvciBkb3duPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0cmVuZGluZy1yb3ciIGlkPSJ0cmVuZGluZ1JvdyI+JHtza2VsZXRvbkNhcmRzKDQpfTwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIiBzdHlsZT0ibWFyZ2luLXRvcDo4",
  "cHg7Ij48aDI+QWxsIFN0b2NrczwvaDI+PHNwYW4gY2xhc3M9InN1YiI+U29ydGVkIGJ5IG1hcmtldCBjYXA8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJtYXJrZXRzVGFibGVXcmFwIj48ZGl2IHN0eWxlPSJwYWRk",
  "aW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoMTApfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdG9jay1jYXJkcyIgaWQ9Im1hcmtldHNDYXJkcyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIHdpcmVTZWFyY2goKTsKICB0cnl7CiAgICBjb25zdCBs",
  "aXN0ID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHt9KTsKICAgIHJlbmRlclRyZW5kaW5nKGxpc3QpOwogICAgcmVuZGVyVGFibGVJbnRvKCJtYXJrZXRzVGFibGVXcmFwIiwgIm1hcmtldHNDYXJkcyIsIGxpc3QsIHtrZXk6Im1hcmtldENhcCIsIGRp",
  "cjoiZGVzYyJ9LCB0cnVlKTsKICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFya2V0c1RhYmxlV3JhcCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJNYXJrZXQgZGF0YSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZSIsICJQbGVh",
  "c2UgdHJ5IGFnYWluIGluIGEgbW9tZW50LiIpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRyZW5kaW5nUm93IikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlRyZW5kaW5nIGRhdGEgdW5hdmFpbGFibGUiLCAiUGxlYXNlIHRyeSBhZ2FpbiBpbiBh",
  "IG1vbWVudC4iKTsKICB9Cn0KCmZ1bmN0aW9uIHJlbmRlclRyZW5kaW5nKGxpc3QpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRyZW5kaW5nUm93Iik7CiAgaWYoIWVsKSByZXR1cm47CiAgaWYoIWxpc3QubGVuZ3RoKXsgZWwuaW5uZXJI",
  "VE1MID0gZW1wdHlTdGF0ZUhUTUwoIk5vIHRyZW5kaW5nIGRhdGEiLCAiTm8gc3RvY2tzIHdlcmUgcmV0dXJuZWQgdG8gcmFuay4iKTsgcmV0dXJuOyB9CiAgY29uc3QgaG90ID0gbGlzdC5zbGljZSgpLnNvcnQoKGEsYik9Pk1hdGguYWJzKGIucGN0KS1NYXRoLmFi",
  "cyhhLnBjdCkpLnNsaWNlKDAsNik7CiAgZWwuaW5uZXJIVE1MID0gaG90Lm1hcCgocyxpKT0+ewogICAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgICByZXR1cm4gYAogICAgPGRpdiBjbGFzcz0iZ2xhc3MgdHJlbmRpbmctY2FyZCIgZGF0YS10aWNrZXI9IiR7cy50",
  "fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqNDB9bXMiPgogICAgICA8ZGl2IGNsYXNzPSJ0cmVuZGluZy10b3AiPgogICAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgIDxkaXYgY2xh",
  "c3M9ImluZGV4LWJhZGdlICR7cG9zPydwb3MnOiduZWcnfSI+JHtwb3M/J+KWsic6J+KWvCd9ICR7cGN0U3RyKHMucGN0KX08L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSIgc3R5bGU9Im1hcmdpbi10b3A6MTBweDsiPiR7",
  "ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjE5cHg7bWFyZ2lu",
  "LXRvcDo4cHg7Ij4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiIHN0eWxlPSJoZWlnaHQ6MjhweDttYXJnaW4tdG9wOjhweDsiPiR7c3BhcmtsaW5lU1ZHKHMuc2VyaWVzLCBwb3MpfTwvZGl2PgogICAgPC9kaXY+",
  "YDsKICB9KS5qb2luKCIiKTsKICBlbC5xdWVyeVNlbGVjdG9yQWxsKCIudHJlbmRpbmctY2FyZCIpLmZvckVhY2goY2FyZD0+ewogICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT4gbmF2aWdhdGUoImRldGFpbCIsIGNhcmQuZGF0YXNldC50aWNr",
  "ZXIpKTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBXQVRDSExJU1QgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJXYXRjaGxpc3QoKXsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8",
  "ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5XYXRjaGxpc3Q8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPiR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aH0gc3RvY2ske3N0YXRlLndhdGNobGlzdC5sZW5ndGg9PT0xPycnOidzJ30gdHJhY2tlZDwvc3Bhbj48L2Rpdj4K",
  "ICAgICAgPGRpdiBjbGFzcz0id2F0Y2hsaXN0LWdyaWQiIGlkPSJ3YXRjaEdyaWQiPiR7c2tlbGV0b25DYXJkcyhNYXRoLm1heChzdGF0ZS53YXRjaGxpc3QubGVuZ3RoLDMpKX08L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgaWYoIXN0YXRlLndhdGNobGlzdC5sZW5n",
  "dGgpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIndhdGNoR3JpZCIpLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ3YXRjaC1lbXB0eSBnbGFzcyI+JHtlbXB0eVN0YXRlSW5uZXIoIllvdXIgd2F0Y2hsaXN0IGlzIGVtcHR5IiwgIlN0YXIgYW55IHN0b2Nr",
  "IGZyb20gdGhlIGRhc2hib2FyZCwgc2NyZWVuZXIgb3IgbWFya2V0cyB2aWV3IHRvIHRyYWNrIGl0IGhlcmUuIil9PC9kaXY+YDsKICAgIHJldHVybjsKICB9CiAgdHJ5ewogICAgY29uc3Qgc3RvY2tzID0gYXdhaXQgUHJvbWlzZS5hbGwoc3RhdGUud2F0Y2hsaXN0",
  "Lm1hcCh0PT5BUEkuZmV0Y2hTdG9jayh0KSkpOwogICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ3YXRjaEdyaWQiKTsKICAgIGdyaWQuaW5uZXJIVE1MID0gc3RvY2tzLmZpbHRlcihCb29sZWFuKS5tYXAoKHMsaSk9PndhdGNoQ2FyZEhU",
  "TUwocyxpKSkuam9pbigiIik7CiAgICB3aXJlV2F0Y2hDYXJkcygpOwogIH1jYXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ3YXRjaEdyaWQiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIGxvYWQgd2F0Y2hsaXN0Iiwg",
  "IlBsZWFzZSB0cnkgYWdhaW4uIik7CiAgfQp9CgpmdW5jdGlvbiB3YXRjaENhcmRIVE1MKHMsaSl7CiAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJnbGFzcyB3YXRjaC1jYXJkIGVudGVyaW5nIiBkYXRhLXRpY2tlcj0iJHtz",
  "LnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSo0MH1tcyI+CiAgICA8ZGl2IGNsYXNzPSJ3YXRjaC10b3AiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAg",
  "PGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0b24gY2xhc3M9InN0YXItYnRuIGFjdGl2ZSIgZGF0YS11bnN0YXI9IiR7cy50fSIgdGl0bGU9IlJlbW92ZSI+CiAgICAgICAgPHN2",
  "ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9ImN1cnJlbnRDb2xvciIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcu",
  "MDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjJweDsiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAg",
  "PGRpdiBjbGFzcz0iaW5kZXgtY2hhbmdlICR7cG9zPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihzLmNoYW5nZSl9ICgke3BjdFN0cihzLnBjdCl9KTwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiPiR7c3BhcmtsaW5lU1ZHKHMuc2VyaWVz",
  "LCBwb3MpfTwvZGl2PgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHdpcmVXYXRjaENhcmRzKCl7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLndhdGNoLWNhcmQiKS5mb3JFYWNoKGNhcmQ9PnsKICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAo",
  "ZSk9PnsKICAgICAgaWYoZS50YXJnZXQuY2xvc2VzdCgiW2RhdGEtdW5zdGFyXSIpKSByZXR1cm47CiAgICAgIG5hdmlnYXRlKCJkZXRhaWwiLCBjYXJkLmRhdGFzZXQudGlja2VyKTsKICAgIH0pOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltk",
  "YXRhLXVuc3Rhcl0iKS5mb3JFYWNoKGJ0bj0+ewogICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICAgIGNvbnN0IGNhcmQgPSBidG4uY2xvc2VzdCgiLndhdGNoLWNhcmQiKTsKICAgICAg",
  "Y2FyZC5jbGFzc0xpc3QuYWRkKCJyZW1vdmluZyIpOwogICAgICB0b2dnbGVXYXRjaChidG4uZGF0YXNldC51bnN0YXIpOwogICAgICBzZXRUaW1lb3V0KCgpPT57CiAgICAgICAgaWYoIXN0YXRlLndhdGNobGlzdC5sZW5ndGgpIHJlbmRlcldhdGNobGlzdCgpOwog",
  "ICAgICAgIGVsc2UgY2FyZC5yZW1vdmUoKTsKICAgICAgICBjb25zdCBzdWJFbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5zZWN0aW9uLWhlYWQgLnN1YiIpOwogICAgICAgIGlmKHN1YkVsKSBzdWJFbC50ZXh0Q29udGVudCA9IGAke3N0YXRlLndhdGNobGlz",
  "dC5sZW5ndGh9IHN0b2NrJHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RoPT09MT8nJzoncyd9IHRyYWNrZWRgOwogICAgICB9LCAyODApOwogICAgfSk7CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gU1RPQ0sgREVUQUlMIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5",
  "bmMgZnVuY3Rpb24gcmVuZGVyRGV0YWlsKCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0idmlldyIgaWQ9ImRldGFpbFNrZWxldG9uIj4KICAgIDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwtY2FyZCBza2VsIiBzdHlsZT0iaGVpZ2h0Ojg4cHg7bWFyZ2lu",
  "LWJvdHRvbToyNHB4OyI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPiR7c2tlbGV0b25DYXJkcyg2KX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwtY2FyZCBza2VsIiBzdHlsZT0iaGVpZ2h0OjMyMHB4OyI+PC9kaXY+CiAgPC9k",
  "aXY+YDsKCiAgbGV0IHM7CiAgdHJ5eyBzID0gYXdhaXQgQVBJLmZldGNoU3RvY2soc3RhdGUuZGV0YWlsVGlja2VyKTsgfWNhdGNoKGUpeyBzID0gbnVsbDsgfQogIGlmKCFzKXsKICAgIHJvb3QuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byBy",
  "ZXRyaWV2ZSB0aGlzIHN0b2NrIiwgIlRoZSB0aWNrZXIgeW91J3JlIGxvb2tpbmcgZm9yIGlzbid0IGF2YWlsYWJsZSByaWdodCBub3cuIik7CiAgICByZXR1cm47CiAgfQogIGNvbnN0IHBvcyA9IHMucGN0ID49IDA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndh",
  "dGNobGlzdC5pbmNsdWRlcyhzLnQpOwoKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtaGVhZCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXRpdGxlLXJvdyI+CiAgICAgICAgICA8",
  "ZGl2IGNsYXNzPSJkZXRhaWwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgICAgPGRpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgICAgICA8",
  "ZGl2IGNsYXNzPSJkZXRhaWwtc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9IMK3ICR7cy5zZWN0b3J9PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dh",
  "cDoxNHB4OyI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtcHJpY2UtYmxvY2siPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtcHJpY2UgdGFidWxhciI+JHtzLnByaWNlIT1udWxsID8gYOKCuTxzcGFuIGRhdGEtY291bnR1cD0iJHtzLnByaWNl",
  "fSIgZGF0YS1kZWNpbWFscz0iMiI+MDwvc3Bhbj5gIDogIuKAlCJ9PC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1jaGFuZ2UgJHtwb3M/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKHMuY2hhbmdlKX0gKCR7cGN0U3RyKHMucGN0KX0p",
  "IHRvZGF5PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiBpZD0iZGV0YWlsU3RhciIgc3R5bGU9IndpZHRoOjQ0cHg7aGVpZ2h0OjQ0cHg7Y29sb3I6JHtpbldhdGNoPycjRkZDODU3JzondmFyKC0tdGV4dC1t",
  "aWQpJ30iPgogICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iJHtpbldhdGNoPydjdXJyZW50Q29sb3InOidub25lJ30iIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0eWxlPSJ3aWR0aDoxOXB4O2hlaWdodDox",
  "OXB4OyI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAgICA8",
  "L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+CiAgICAgICAgJHttZXRyaWNDYXJkKCJPcGVuIiwgZm10SU5SKHMub3BlbikpfQogICAgICAgICR7bWV0cmljQ2FyZCgiRGF5IEhpZ2giLCBmbXRJTlIocy5kYXlIaWdoKSl9CiAgICAgICAgJHtt",
  "ZXRyaWNDYXJkKCJEYXkgTG93IiwgZm10SU5SKHMuZGF5TG93KSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCJNYXJrZXQgQ2FwIiwgZm10Q29tcGFjdChzLm1hcmtldENhcCkpfQogICAgICAgICR7bWV0cmljQ2FyZCgiVm9sdW1lIiwgZm10Vm9sKHMudm9sdW1lKSl9",
  "CiAgICAgICAgJHttZXRyaWNDYXJkKCI1MlcgSGlnaCAvIExvdyIsIGZtdElOUihzLmhpZ2g1MiwwKSsiIC8gIitmbXRJTlIocy5sb3c1MiwwKSl9CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgY2hhcnQtY2FyZCI+CiAgICAgICAgPGRpdiBj",
  "bGFzcz0iY2hhcnQtaGVhZCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiIHN0eWxlPSJtYXJnaW46MDsiPjxoMj5QcmljZSBDaGFydDwvaDI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJyYW5nZS10YWJzIiBpZD0icmFuZ2VUYWJzIj4K",
  "ICAgICAgICAgICAgJHtbIjFEIiwiMVciLCIxTSIsIjNNIiwiNk0iLCIxWSJdLm1hcChyPT5gPGJ1dHRvbiBkYXRhLXJhbmdlPSIke3J9IiBjbGFzcz0iJHtzdGF0ZS5kZXRhaWxSYW5nZT09PXI/J2FjdGl2ZSc6Jyd9Ij4ke3J9PC9idXR0b24+YCkuam9pbigiIil9",
  "CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC1jYW52YXMtd3JhcCIgaWQ9ImNoYXJ0V3JhcCI+CiAgICAgICAgICA8Y2FudmFzIGlkPSJwcmljZUNoYXJ0Ij48L2NhbnZhcz4KICAgICAgICAgIDxkaXYgY2xh",
  "c3M9ImNoYXJ0LXRvb2x0aXAiIGlkPSJjaGFydFRvb2x0aXAiPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InZvbHVtZS13cmFwIiBpZD0idm9sdW1lV3JhcCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ2b2x1bWUtbGFiZWwiPlZvbHVt",
  "ZSA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1mYWludCk7Zm9udC13ZWlnaHQ6NjAwOyI+KHJlbGF0aXZlLCBkZXJpdmVkIGZyb20gcHJpY2UgbW92ZW1lbnQpPC9zcGFuPjwvZGl2PgogICAgICAgICAgPGNhbnZhcyBpZD0idm9sdW1lQ2hhcnQiPjwvY2Fu",
  "dmFzPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MjhweDsiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImV4cGxhaW4tYnRuIiBpZD0iZXhwbGFpbkJ0biI+CiAgICAgICAgICA8c3ZnIHZpZXdCb3g9",
  "IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgOFY0SDgiLz48cmVjdCB4PSI0IiB5PSI4IiB3",
  "aWR0aD0iMTYiIGhlaWdodD0iMTIiIHJ4PSIyIi8+PHBhdGggZD0iTTIgMTRoMk0yMCAxNGgyTTkgMTN2Mk0xNSAxM3YyIi8+PC9zdmc+CiAgICAgICAgICBFeHBsYWluIHRoaXMgc3RvY2sKICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8ZGl2IGNsYXNzPSJnbGFz",
  "cyBleHBsYWluLWNhcmQiIGlkPSJleHBsYWluQ2FyZCIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIGA7CgogIHJ1bkNvdW50VXBzKHJvb3QpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkZXRhaWxTdGFy",
  "IikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgdG9nZ2xlV2F0Y2gocy50KTsKICAgIHJlbmRlckRldGFpbCgpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJyYW5nZVRhYnMiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChl",
  "KT0+ewogICAgY29uc3QgYnRuID0gZS50YXJnZXQuY2xvc2VzdCgiYnV0dG9uW2RhdGEtcmFuZ2VdIik7CiAgICBpZighYnRuKSByZXR1cm47CiAgICBzdGF0ZS5kZXRhaWxSYW5nZSA9IGJ0bi5kYXRhc2V0LnJhbmdlOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3Rv",
  "ckFsbCgiI3JhbmdlVGFicyBidXR0b24iKS5mb3JFYWNoKGI9PmIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYj09PWJ0bikpOwogICAgbG9hZENoYXJ0KHMudCwgcy5wY3Q+PTApOwogIH0pOwogIHdpcmVFeHBsYWluQnV0dG9uKHMudCk7CgogIGxvYWRDaGFy",
  "dChzLnQsIHBvcyk7Cn0KCmZ1bmN0aW9uIG1ldHJpY0NhcmQobGFiZWwsIHZhbHVlKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImdsYXNzIG1ldHJpYy1jYXJkIj48ZGl2IGNsYXNzPSJtZXRyaWMtbGFiZWwiPiR7bGFiZWx9PC9kaXY+PGRpdiBjbGFzcz0ibWV0cmlj",
  "LXZhbHVlIHRhYnVsYXIiPiR7dmFsdWV9PC9kaXY+PC9kaXY+YDsKfQoKYXN5bmMgZnVuY3Rpb24gbG9hZENoYXJ0KHRpY2tlciwgcG9zaXRpdmUpewogIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiY2hhcnRXcmFwIik7CiAgY29uc3QgY2Fu",
  "dmFzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInByaWNlQ2hhcnQiKTsKICBpZighd3JhcCB8fCAhY2FudmFzKSByZXR1cm47CiAgY2FudmFzLnN0eWxlLm9wYWNpdHkgPSAiMC4yNSI7CiAgbGV0IHNlcmllczsKICB0cnl7CiAgICBzZXJpZXMgPSBhd2FpdCBB",
  "UEkuZmV0Y2hTdG9ja0hpc3RvcnkodGlja2VyLCBzdGF0ZS5kZXRhaWxSYW5nZSk7CiAgfWNhdGNoKGUpewogICAgd3JhcC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiQ2hhcnQgZGF0YSB1bmF2YWlsYWJsZSIsICJUaGlzIHRpbWVmcmFtZSBjb3VsZG4ndCBi",
  "ZSBsb2FkZWQuIFRyeSBhIGRpZmZlcmVudCByYW5nZS4iKTsKICAgIHJldHVybjsKICB9CiAgY2FudmFzLnN0eWxlLm9wYWNpdHkgPSAiMSI7CiAgZHJhd0NoYXJ0KGNhbnZhcywgc2VyaWVzLCBwb3NpdGl2ZSwgdGlja2VyKTsKICBkcmF3Vm9sdW1lQ2hhcnQoc2Vy",
  "aWVzLCBwb3NpdGl2ZSk7Cn0KCmZ1bmN0aW9uIGRyYXdWb2x1bWVDaGFydChzZXJpZXMsIHBvc2l0aXZlKXsKICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidm9sdW1lQ2hhcnQiKTsKICBpZighY2FudmFzKSByZXR1cm47CiAgY29uc3Qg",
  "cmVjdCA9IGNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICBjb25zdCBkcHIgPSB3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxOwogIGNhbnZhcy53aWR0aCA9IHJlY3Qud2lkdGggKiBkcHI7CiAgY2FudmFzLmhlaWdodCA9IHJlY3QuaGVpZ2h0ICog",
  "ZHByOwogIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOwogIGN0eC5zY2FsZShkcHIsZHByKTsKICBjb25zdCBXID0gcmVjdC53aWR0aCwgSCA9IHJlY3QuaGVpZ2h0OwogIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7CgogIC8vIERlcml2ZSBhIHBs",
  "YXVzaWJsZSByZWxhdGl2ZSB2b2x1bWUgcHJvZmlsZSBmcm9tIHRoZSBwcmljZSBzZXJpZXMnCiAgLy8gcG9pbnQtdG8tcG9pbnQgdm9sYXRpbGl0eSAoYmlnZ2VyIG1vdmVzIHRlbmQgdG8gY29pbmNpZGUgd2l0aCBoaWdoZXIKICAvLyB2b2x1bWUpIOKAlCBpbGx1",
  "c3RyYXRpdmUgb25seTsgdGhlIGJhY2tlbmQgaGFzIG5vIGhpc3RvcmljYWwgdm9sdW1lIGZlZWQuCiAgY29uc3QgZGVsdGFzID0gc2VyaWVzLm1hcCgodixpKT0+IGk9PT0wID8gMCA6IE1hdGguYWJzKHYtc2VyaWVzW2ktMV0pKTsKICBjb25zdCBtYXhEID0gTWF0",
  "aC5tYXgoLi4uZGVsdGFzLCAxZS02KTsKICBjb25zdCBiYXJXID0gVy9zZXJpZXMubGVuZ3RoOwogIGNvbnN0IGNvbG9yID0gcG9zaXRpdmUgPyAiIzMzRDZBNiIgOiAiI0ZCNkI2QiI7CiAgc2VyaWVzLmZvckVhY2goKHYsaSk9PnsKICAgIGNvbnN0IHNlZWQgPSB0",
  "aWNrZXJTZWVkKHN0YXRlLmRldGFpbFRpY2tlcikraSo3OwogICAgY29uc3QgaCA9IE1hdGgubWF4KDMsIChkZWx0YXNbaV0vbWF4RCkgKiBIICogMC44NSAqICgwLjU1ICsgc2VlZGVkUmFuZChzZWVkKSowLjYpKTsKICAgIGNvbnN0IHVwID0gaT09PTAgPyB0cnVl",
  "IDogc2VyaWVzW2ldID49IHNlcmllc1tpLTFdOwogICAgY3R4LmZpbGxTdHlsZSA9IHVwID8gInJnYmEoNTEsMjE0LDE2NiwwLjU1KSIgOiAicmdiYSgyNTEsMTA3LDEwNywwLjU1KSI7CiAgICBjdHguZmlsbFJlY3QoaSpiYXJXK2JhclcqMC4xNSwgSC1oLCBNYXRo",
  "Lm1heCgxLGJhclcqMC43KSwgaCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIGRyYXdDaGFydChjYW52YXMsIHNlcmllcywgcG9zaXRpdmUsIHRpY2tlcil7CiAgY29uc3Qgd3JhcCA9IGNhbnZhcy5wYXJlbnRFbGVtZW50OwogIGNvbnN0IGRwciA9IHdpbmRvdy5kZXZpY2VQ",
  "aXhlbFJhdGlvIHx8IDE7CiAgY29uc3QgcmVjdCA9IHdyYXAuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgY2FudmFzLndpZHRoID0gcmVjdC53aWR0aCAqIGRwcjsKICBjYW52YXMuaGVpZ2h0ID0gcmVjdC5oZWlnaHQgKiBkcHI7CiAgY2FudmFzLnN0eWxlLndp",
  "ZHRoID0gcmVjdC53aWR0aCsicHgiOwogIGNhbnZhcy5zdHlsZS5oZWlnaHQgPSByZWN0LmhlaWdodCsicHgiOwogIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOwogIGN0eC5zY2FsZShkcHIsZHByKTsKCiAgY29uc3QgVyA9IHJlY3Qud2lkdGgs",
  "IEggPSByZWN0LmhlaWdodDsKICBjb25zdCBwYWQgPSB7dG9wOjE2LCByaWdodDo4LCBib3R0b206MjQsIGxlZnQ6OH07CiAgY29uc3QgbWluID0gTWF0aC5taW4oLi4uc2VyaWVzKSwgbWF4ID0gTWF0aC5tYXgoLi4uc2VyaWVzKTsKICBjb25zdCByYW5nZVYgPSAo",
  "bWF4LW1pbikgfHwgMTsKICBjb25zdCBpbm5lclcgPSBXIC0gcGFkLmxlZnQgLSBwYWQucmlnaHQ7CiAgY29uc3QgaW5uZXJIID0gSCAtIHBhZC50b3AgLSBwYWQuYm90dG9tOwogIGNvbnN0IHN0ZXAgPSBpbm5lclcvKHNlcmllcy5sZW5ndGgtMSk7CgogIGZ1bmN0",
  "aW9uIHh5KGksdil7CiAgICByZXR1cm4gW3BhZC5sZWZ0ICsgaSpzdGVwLCBwYWQudG9wICsgaW5uZXJIIC0gKCh2LW1pbikvcmFuZ2VWKSppbm5lckhdOwogIH0KICBjb25zdCBwdHMgPSBzZXJpZXMubWFwKCh2LGkpPT54eShpLHYpKTsKICBjb25zdCBjb2xvciA9",
  "IHBvc2l0aXZlID8gIiMzM0Q2QTYiIDogIiNGQjZCNkIiOwoKICBmdW5jdGlvbiBzbW9vdGhQYXRoKHBvaW50cyl7CiAgICBpZihwb2ludHMubGVuZ3RoPDMpIHJldHVybiBgTSR7cG9pbnRzWzBdWzBdfSwke3BvaW50c1swXVsxXX0gTCR7cG9pbnRzWzFdWzBdfSwk",
  "e3BvaW50c1sxXVsxXX1gOwogICAgbGV0IGQgPSBgTSR7cG9pbnRzWzBdWzBdfSwke3BvaW50c1swXVsxXX1gOwogICAgZm9yKGxldCBpPTA7aTxwb2ludHMubGVuZ3RoLTE7aSsrKXsKICAgICAgY29uc3QgcDAgPSBwb2ludHNbaT09PTA/MDppLTFdOwogICAgICBj",
  "b25zdCBwMSA9IHBvaW50c1tpXTsKICAgICAgY29uc3QgcDIgPSBwb2ludHNbaSsxXTsKICAgICAgY29uc3QgcDMgPSBwb2ludHNbaSsyPHBvaW50cy5sZW5ndGg/aSsyOmkrMV07CiAgICAgIGNvbnN0IGNwMXggPSBwMVswXSArIChwMlswXS1wMFswXSkvNjsKICAg",
  "ICAgY29uc3QgY3AxeSA9IHAxWzFdICsgKHAyWzFdLXAwWzFdKS82OwogICAgICBjb25zdCBjcDJ4ID0gcDJbMF0gLSAocDNbMF0tcDFbMF0pLzY7CiAgICAgIGNvbnN0IGNwMnkgPSBwMlsxXSAtIChwM1sxXS1wMVsxXSkvNjsKICAgICAgZCArPSBgIEMke2NwMXh9",
  "LCR7Y3AxeX0gJHtjcDJ4fSwke2NwMnl9ICR7cDJbMF19LCR7cDJbMV19YDsKICAgIH0KICAgIHJldHVybiBkOwogIH0KCiAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKICBjYW52YXMuX2NoYXJ0TWV0YSA9IHtwdHMsIHNlcmllcywgVywgSCwgcGFkLCBjb2xvcn07",
  "CgogIC8vIEVudHJhbmNlOiB0aGUgbGluZSBkcmF3cyBpdHNlbGYgbGVmdC10by1yaWdodCB2aWEgYSBncm93aW5nIGNsaXAgcmVjdCwKICAvLyByYXRoZXIgdGhhbiBqdXN0IGFwcGVhcmluZyDigJQgdGhpcyBpcyB0aGUgY2hhcnQncyAid293IiBtb21lbnQuCiAg",
  "aWYocHJlZmVyc1JlZHVjZWRNb3Rpb24pewogICAgcmVkcmF3KGN0eCwgY2FudmFzLl9jaGFydE1ldGEpOwogIH1lbHNlewogICAgY29uc3QgcmV2ZWFsU3RhcnQgPSBwZXJmb3JtYW5jZS5ub3coKTsKICAgIGNvbnN0IHJldmVhbER1cmF0aW9uID0gNzAwOwogICAg",
  "KGZ1bmN0aW9uIHJldmVhbFRpY2sobm93KXsKICAgICAgY29uc3QgdCA9IE1hdGgubWluKDEsIChub3ctcmV2ZWFsU3RhcnQpL3JldmVhbER1cmF0aW9uKTsKICAgICAgY29uc3QgZWFzZWQgPSAxIC0gTWF0aC5wb3coMS10LCAzKTsKICAgICAgY29uc3QgY2xpcFcg",
  "PSBwYWQubGVmdCArIGlubmVyVyplYXNlZDsKICAgICAgY3R4LnNhdmUoKTsKICAgICAgY3R4LmJlZ2luUGF0aCgpOwogICAgICBjdHgucmVjdCgwLCAwLCBjbGlwVywgSCk7CiAgICAgIGN0eC5jbGlwKCk7CiAgICAgIHJlZHJhdyhjdHgsIGNhbnZhcy5fY2hhcnRN",
  "ZXRhKTsKICAgICAgY3R4LnJlc3RvcmUoKTsKICAgICAgaWYodDwxKSByZXF1ZXN0QW5pbWF0aW9uRnJhbWUocmV2ZWFsVGljayk7CiAgICB9KShwZXJmb3JtYW5jZS5ub3coKSk7CiAgfQoKICAvLyBjcm9zc2hhaXIgaW50ZXJhY3Rpdml0eQogIGNvbnN0IHRvb2x0",
  "aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiY2hhcnRUb29sdGlwIik7CiAgY2FudmFzLm9ubW91c2Vtb3ZlID0gKGUpPT57CiAgICBjb25zdCByID0gY2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgbXggPSBlLmNsaWVudFggLSBy",
  "LmxlZnQ7CiAgICBsZXQgaWR4ID0gTWF0aC5yb3VuZCgobXgtcGFkLmxlZnQpL3N0ZXApOwogICAgaWR4ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2VyaWVzLmxlbmd0aC0xLCBpZHgpKTsKICAgIGNvbnN0IFtweCxweV0gPSBwdHNbaWR4XTsKCiAgICByZWRyYXdX",
  "aXRoQ3Jvc3NoYWlyKGN0eCwgY2FudmFzLl9jaGFydE1ldGEsIHB4LCBweSk7CgogICAgdG9vbHRpcC5zdHlsZS5vcGFjaXR5ID0gIjEiOwogICAgdG9vbHRpcC5zdHlsZS5sZWZ0ID0gcHgrInB4IjsKICAgIHRvb2x0aXAuc3R5bGUudG9wID0gcHkrInB4IjsKICAg",
  "IHRvb2x0aXAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InR0LXByaWNlIj4ke2ZtdElOUihzZXJpZXNbaWR4XSl9PC9kaXY+PGRpdiBjbGFzcz0idHQtZGF0ZSI+UG9pbnQgJHtpZHgrMX0gb2YgJHtzZXJpZXMubGVuZ3RofTwvZGl2PmA7CiAgfTsKICBjYW52YXMu",
  "b25tb3VzZWxlYXZlID0gKCk9PnsKICAgIHRvb2x0aXAuc3R5bGUub3BhY2l0eSA9ICIwIjsKICAgIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7CiAgICByZWRyYXcoY3R4LCBjYW52YXMuX2NoYXJ0TWV0YSk7CiAgfTsKCiAgZnVuY3Rpb24gcmVkcmF3KGN0eCwgbWV0",
  "YSl7CiAgICBjb25zdCB7cHRzLCBXLCBILCBwYWQsIGNvbG9yfSA9IG1ldGE7CiAgICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gInJnYmEoMTU4LDE3MSwyMTQsMC4wOCkiOwogICAgY3R4LmxpbmVXaWR0aCA9IDE7CiAgICBj",
  "b25zdCBpbm5lckgyID0gSC1wYWQudG9wLXBhZC5ib3R0b207CiAgICBmb3IobGV0IGk9MDtpPD0zO2krKyl7CiAgICAgIGNvbnN0IHkgPSBwYWQudG9wICsgKGlubmVySDIvMykqaTsKICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKHBhZC5sZWZ0LHkp",
  "OyBjdHgubGluZVRvKFctcGFkLnJpZ2h0LHkpOyBjdHguc3Ryb2tlKCk7CiAgICB9CiAgICBjb25zdCBncmFkMiA9IGN0eC5jcmVhdGVMaW5lYXJHcmFkaWVudCgwLHBhZC50b3AsMCxwYWQudG9wK2lubmVySDIpOwogICAgZ3JhZDIuYWRkQ29sb3JTdG9wKDAsIGNv",
  "bG9yKyI1NSIpOyBncmFkMi5hZGRDb2xvclN0b3AoMSwgY29sb3IrIjAyIik7CiAgICBjb25zdCBhcmVhUGF0aDIgPSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7CiAgICBhcmVhUGF0aDIubGluZVRvKHB0c1twdHMubGVuZ3RoLTFdWzBdLCBwYWQudG9wK2lu",
  "bmVySDIpOwogICAgYXJlYVBhdGgyLmxpbmVUbyhwdHNbMF1bMF0sIHBhZC50b3AraW5uZXJIMik7CiAgICBhcmVhUGF0aDIuY2xvc2VQYXRoKCk7CiAgICBjdHguZmlsbFN0eWxlID0gZ3JhZDI7IGN0eC5maWxsKGFyZWFQYXRoMik7CiAgICBjdHguc3Ryb2tlU3R5",
  "bGUgPSBjb2xvcjsgY3R4LmxpbmVXaWR0aCA9IDI7IGN0eC5saW5lSm9pbj0icm91bmQiOyBjdHgubGluZUNhcD0icm91bmQiOwogICAgY3R4LnN0cm9rZShuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSkpOwogIH0KICBmdW5jdGlvbiByZWRyYXdXaXRoQ3Jvc3No",
  "YWlyKGN0eCwgbWV0YSwgcHgsIHB5KXsKICAgIHJlZHJhdyhjdHgsIG1ldGEpOwogICAgY29uc3Qge0gsIHBhZCwgY29sb3J9ID0gbWV0YTsKICAgIGN0eC5zYXZlKCk7CiAgICBjdHguc3Ryb2tlU3R5bGUgPSAicmdiYSgxNTgsMTcxLDIxNCwwLjM1KSI7CiAgICBj",
  "dHgubGluZVdpZHRoID0gMTsKICAgIGN0eC5zZXRMaW5lRGFzaChbMywzXSk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8ocHgsIHBhZC50b3ApOyBjdHgubGluZVRvKHB4LCBILXBhZC5ib3R0b20pOyBjdHguc3Ryb2tlKCk7CiAgICBjdHguc2V0TGlu",
  "ZURhc2goW10pOwogICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKHB4LHB5LDQsMCxNYXRoLlBJKjIpOwogICAgY3R4LmZpbGxTdHlsZSA9IGNvbG9yOyBjdHguZmlsbCgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gIiMwNTA2MEIiOyBjdHgubGluZVdpZHRoPTI7",
  "IGN0eC5zdHJva2UoKTsKICAgIGN0eC5yZXN0b3JlKCk7CiAgfQp9Cgp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigicmVzaXplIiwgZGVib3VuY2UoKCk9PnsKICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicHJpY2VDaGFydCIpOwogIGlm",
  "KGNhbnZhcyAmJiBzdGF0ZS52aWV3PT09ImRldGFpbCIpIGxvYWRDaGFydChzdGF0ZS5kZXRhaWxUaWNrZXIsIHRydWUpOwp9LCAyMDApKTsKCi8qIC0tLS0tLS0tLS0tLS0tLS0gU1RBVEUgSEVMUEVSUyAtLS0tLS0tLS0tLS0tLS0tICovCmZ1bmN0aW9uIGVtcHR5",
  "U3RhdGVJbm5lcih0aXRsZSwgc3ViKXsKICByZXR1cm4gYAogICAgPGRpdiBjbGFzcz0ic3RhdGUtaWNvbiI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9r",
  "ZS13aWR0aD0iMiI+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNyIvPjxwYXRoIGQ9Ik0yMSAyMWwtNC4zLTQuMyIvPjwvc3ZnPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtdGl0bGUiPiR7dGl0bGV9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1z",
  "dWIiPiR7c3VifTwvZGl2PgogIGA7Cn0KZnVuY3Rpb24gZW1wdHlTdGF0ZUhUTUwodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJzdGF0ZS1ib3giPiR7ZW1wdHlTdGF0ZUlubmVyKHRpdGxlLCBzdWIpfTwvZGl2PmA7Cn0KZnVuY3Rpb24gZXJyb3JT",
  "dGF0ZUhUTUwodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJzdGF0ZS1ib3giPgogICAgPGRpdiBjbGFzcz0ic3RhdGUtaWNvbiI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgZmlsbD0ibm9uZSIgc3Ryb2tl",
  "PSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDl2NE0xMiAxN2guMDFNMTAuMjkgMy44NkwxLjgyIDE4YTIgMiAwIDAwMS43MSAzaDE2Ljk0YTIgMiAwIDAwMS43MS0zTDEzLjcxIDMuODZhMiAyIDAgMDAtMy40MiAweiIvPjwvc3Zn",
  "PjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtdGl0bGUiPiR7dGl0bGV9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1zdWIiPiR7c3VifTwvZGl2PgogIDwvZGl2PmA7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT0KICAgQk9PVAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT0KICAgQUkgQVNTSVNUQU5UIOKAlCBjaGF0IHBhbmVsICsgcGVyLXN0b2NrIGV4cGxhaW4KICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCBh",
  "aVN0YXRlID0geyBvcGVuOiBmYWxzZSwgaGlzdG9yeTogW10sIGNvbmZpZ3VyZWQ6IG51bGwsIGJ1c3k6IGZhbHNlIH07CgpmdW5jdGlvbiBhaVNldFN0YXR1c0xpbmUodGV4dCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlTdGF0dXNM",
  "aW5lIik7CiAgaWYoZWwpIGVsLnRleHRDb250ZW50ID0gdGV4dDsKfQoKYXN5bmMgZnVuY3Rpb24gY2hlY2tBaVN0YXR1cygpewogIHRyeXsKICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KENPTkZJRy5BUElfQkFTRSArICIvYWkvc3RhdHVzIiwg",
  "Q09ORklHLkxJVkVfVElNRU9VVF9NUyk7CiAgICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCJiYWQgc3RhdHVzIik7CiAgICBjb25zdCBqc29uID0gYXdhaXQgci5qc29uKCk7CiAgICBhaVN0YXRlLmNvbmZpZ3VyZWQgPSAhIWpzb24uY29uZmlndXJlZDsKICAg",
  "IGFpU2V0U3RhdHVzTGluZShhaVN0YXRlLmNvbmZpZ3VyZWQgPyAiUmVhZHkiIDogIk5vdCBjb25maWd1cmVkIG9uIHNlcnZlciIpOwogIH1jYXRjaChlKXsKICAgIGFpU3RhdGUuY29uZmlndXJlZCA9IGZhbHNlOwogICAgYWlTZXRTdGF0dXNMaW5lKGxpdmVCYWNr",
  "ZW5kQXZhaWxhYmxlID8gIlVuYXZhaWxhYmxlIiA6ICJCYWNrZW5kIG5vdCBjb25uZWN0ZWQiKTsKICB9Cn0KCmFzeW5jIGZ1bmN0aW9uIGJ1aWxkQWlDb250ZXh0KCl7CiAgLy8gUmVhbCBtYXJrZXQgc25hcHNob3Qgc28gdGhlIGFzc2lzdGFudCBjYW4gYW5zd2Vy",
  "IGdlbmVyYWwgcXVlc3Rpb25zCiAgLy8gKCJ3aG8gYXJlIHRoZSBnYWluZXJzIiwgImhvdydzIG15IHdhdGNobGlzdCBkb2luZyIpIG5vdCBqdXN0IHF1ZXN0aW9ucwogIC8vIGFib3V0IHdoYXRldmVyIHNpbmdsZSBzdG9jayBoYXBwZW5zIHRvIGJlIG9uIHNjcmVl",
  "bi4gUmV1c2VzIHRoZSBzYW1lCiAgLy8gY2FjaGVkL3NoYXJlZCBmZXRjaCB0aGUgcmVzdCBvZiB0aGUgYXBwIHVzZXMsIHNvIHRoaXMgZG9lc24ndCBjb3N0IGFueQogIC8vIGV4dHJhIE5TRSBjYWxscyB3aGVuIHRoZSBjYWNoZSBpcyBhbHJlYWR5IHdhcm0uCiAg",
  "Y29uc3QgY3R4ID0geyB2aWV3OiBzdGF0ZS52aWV3IH07CiAgdHJ5ewogICAgY29uc3QgbGlzdCA9IGF3YWl0IEFQSS5mZXRjaFNjcmVlbmVyUmVzdWx0cyh7fSk7CiAgICBjb25zdCBjb21wYWN0ID0gbGlzdC5tYXAocz0+KHt0aWNrZXI6cy50LCBuYW1lOnMubmFt",
  "ZSwgcHJpY2U6cy5wcmljZSwgY2hhbmdlUGN0OnMucGN0LCBzZWN0b3I6cy5zZWN0b3J9KSk7CiAgICBjb25zdCBieVNpemUgPSBsaXN0LnNsaWNlKCkuc29ydCgoYSxiKT0+Yi5wY3QtYS5wY3QpOwogICAgY3R4Lm1hcmtldCA9IHsKICAgICAgYXNPZjogbmV3IERh",
  "dGUoKS50b0lTT1N0cmluZygpLAogICAgICBzdG9ja3M6IGNvbXBhY3QsCiAgICAgIHRvcEdhaW5lcnM6IGJ5U2l6ZS5zbGljZSgwLDUpLm1hcChzPT4oe3RpY2tlcjpzLnQsIGNoYW5nZVBjdDpzLnBjdCwgcHJpY2U6cy5wcmljZX0pKSwKICAgICAgdG9wTG9zZXJz",
  "OiBieVNpemUuc2xpY2UoLTUpLnJldmVyc2UoKS5tYXAocz0+KHt0aWNrZXI6cy50LCBjaGFuZ2VQY3Q6cy5wY3QsIHByaWNlOnMucHJpY2V9KSksCiAgICB9OwogIH1jYXRjaChlKXsKICAgIGN0eC5tYXJrZXREYXRhRXJyb3IgPSAiQ291bGQgbm90IGxvYWQgY3Vy",
  "cmVudCBtYXJrZXQgZGF0YS4iOwogIH0KICBpZihzdGF0ZS52aWV3ID09PSAiZGV0YWlsIikgY3R4LmN1cnJlbnRseVZpZXdpbmdTdG9jayA9IHN0YXRlLmRldGFpbFRpY2tlcjsKICBpZihzdGF0ZS53YXRjaGxpc3QubGVuZ3RoKSBjdHgud2F0Y2hsaXN0VGlja2Vy",
  "cyA9IHN0YXRlLndhdGNobGlzdC5zbGljZSgwLCAxMCk7CiAgcmV0dXJuIGN0eDsKfQoKZnVuY3Rpb24gYXBwZW5kQWlNZXNzYWdlKHJvbGUsIHRleHQsIGV4dHJhQ2xhc3MpewogIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlNZXNzYWdl",
  "cyIpOwogIGlmKCF3cmFwKSByZXR1cm4gbnVsbDsKICBjb25zdCBkaXYgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCJkaXYiKTsKICBkaXYuY2xhc3NOYW1lID0gImFpLW1zZyAiICsgcm9sZSArIChleHRyYUNsYXNzID8gIiAiICsgZXh0cmFDbGFzcyA6ICIiKTsK",
  "ICBkaXYudGV4dENvbnRlbnQgPSB0ZXh0OwogIHdyYXAuYXBwZW5kQ2hpbGQoZGl2KTsKICB3cmFwLnNjcm9sbFRvcCA9IHdyYXAuc2Nyb2xsSGVpZ2h0OwogIHJldHVybiBkaXY7Cn0KCmFzeW5jIGZ1bmN0aW9uIHNlbmRBaU1lc3NhZ2UocXVlc3Rpb24pewogIGlm",
  "KCFxdWVzdGlvbi50cmltKCkgfHwgYWlTdGF0ZS5idXN5KSByZXR1cm47CiAgYXBwZW5kQWlNZXNzYWdlKCJ1c2VyIiwgcXVlc3Rpb24pOwogIGFpU3RhdGUuYnVzeSA9IHRydWU7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpU2VuZEJ0biIpLmRpc2FibGVk",
  "ID0gdHJ1ZTsKICBjb25zdCBwZW5kaW5nID0gYXBwZW5kQWlNZXNzYWdlKCJhc3Npc3RhbnQiLCAiVGhpbmtpbmfigKYiLCAicGVuZGluZyIpOwoKICB0cnl7CiAgICBpZighbGl2ZUJhY2tlbmRBdmFpbGFibGUpIGF3YWl0IGNoZWNrTGl2ZUJhY2tlbmQoKTsgLy8g",
  "bWF5IGp1c3QgYmUgd2FraW5nIGZyb20gYSBjb2xkIHN0YXJ0CiAgICBpZighbGl2ZUJhY2tlbmRBdmFpbGFibGUpIHRocm93IG5ldyBFcnJvcigiQmFja2VuZCBub3QgY29ubmVjdGVkIOKAlCB0aGUgQUkgYXNzaXN0YW50IG5lZWRzIHRoZSBsaXZlIGJhY2tlbmQg",
  "cnVubmluZy4gSWYgaXQgd2FzIGp1c3QgaWRsZSwgdHJ5IGFnYWluIGluIGEgbW9tZW50LiIpOwogICAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTsKICAgIGNvbnN0IGlkID0gc2V0VGltZW91dCgoKT0+Y3RybC5hYm9ydCgpLCAyMDAwMCk7CiAg",
  "ICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChDT05GSUcuQVBJX0JBU0UgKyAiL2NoYXQiLCB7CiAgICAgIG1ldGhvZDogIlBPU1QiLAogICAgICBoZWFkZXJzOiB7IkNvbnRlbnQtVHlwZSI6ICJhcHBsaWNhdGlvbi9qc29uIn0sCiAgICAgIGJvZHk6IEpTT04uc3Ry",
  "aW5naWZ5KHsKICAgICAgICBxdWVzdGlvbjogcXVlc3Rpb24udHJpbSgpLAogICAgICAgIGNvbnRleHQ6IGF3YWl0IGJ1aWxkQWlDb250ZXh0KCksCiAgICAgICAgaGlzdG9yeTogYWlTdGF0ZS5oaXN0b3J5LnNsaWNlKC02KSwKICAgICAgfSksCiAgICAgIHNpZ25h",
  "bDogY3RybC5zaWduYWwsCiAgICB9KS5maW5hbGx5KCgpPT5jbGVhclRpbWVvdXQoaWQpKTsKCiAgICBjb25zdCBqc29uID0gYXdhaXQgcmVzLmpzb24oKTsKICAgIGlmKCFyZXMub2sgfHwgIWpzb24uc3VjY2VzcykgdGhyb3cgbmV3IEVycm9yKChqc29uLmVycm9y",
  "ICYmIGpzb24uZXJyb3IubWVzc2FnZSkgfHwgKCJSZXF1ZXN0IGZhaWxlZCAoIiArIHJlcy5zdGF0dXMgKyAiKSIpKTsKCiAgICBwZW5kaW5nLnJlbW92ZSgpOwogICAgYXBwZW5kQWlNZXNzYWdlKCJhc3Npc3RhbnQiLCBqc29uLmRhdGEuYW5zd2VyKTsKICAgIGFp",
  "U3RhdGUuaGlzdG9yeS5wdXNoKHtyb2xlOiJ1c2VyIiwgY29udGVudDogcXVlc3Rpb24udHJpbSgpfSk7CiAgICBhaVN0YXRlLmhpc3RvcnkucHVzaCh7cm9sZToiYXNzaXN0YW50IiwgY29udGVudDoganNvbi5kYXRhLmFuc3dlcn0pOwogIH1jYXRjaChlKXsKICAg",
  "IHBlbmRpbmcucmVtb3ZlKCk7CiAgICBhcHBlbmRBaU1lc3NhZ2UoImFzc2lzdGFudCIsICJDb3VsZG4ndCBnZXQgYSByZXNwb25zZTogIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSwgImVycm9yIik7CiAgfWZpbmFsbHl7CiAgICBhaVN0YXRlLmJ1c3kgPSBmYWxz",
  "ZTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVNlbmRCdG4iKS5kaXNhYmxlZCA9IGZhbHNlOwogIH0KfQoKZnVuY3Rpb24gd2lyZUFpUGFuZWwoKXsKICBjb25zdCBmYWIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlGYWIiKTsKICBjb25zdCBw",
  "YW5lbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVBhbmVsIik7CiAgY29uc3QgY2xvc2VCdG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlDbG9zZUJ0biIpOwogIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpSW5wdXQi",
  "KTsKICBjb25zdCBzZW5kQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpU2VuZEJ0biIpOwoKICBwYW5lbC5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsKCiAgZmFiLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgIGFpU3RhdGUub3BlbiA9",
  "ICFhaVN0YXRlLm9wZW47CiAgICBwYW5lbC5jbGFzc0xpc3QudG9nZ2xlKCJoaWRkZW4iLCAhYWlTdGF0ZS5vcGVuKTsKICAgIGlmKGFpU3RhdGUub3Blbil7IGNoZWNrQWlTdGF0dXMoKTsgaW5wdXQuZm9jdXMoKTsgfQogIH0pOwogIGNsb3NlQnRuLmFkZEV2ZW50",
  "TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgIGFpU3RhdGUub3BlbiA9IGZhbHNlOwogICAgcGFuZWwuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7CiAgfSk7CiAgY29uc3Qgc2VuZCA9ICgpPT57CiAgICBjb25zdCBxID0gaW5wdXQudmFsdWU7CiAgICBpbnB1dC52",
  "YWx1ZSA9ICIiOwogICAgc2VuZEFpTWVzc2FnZShxKTsKICB9OwogIHNlbmRCdG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCBzZW5kKTsKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIiwgKGUpPT57IGlmKGUua2V5ID09PSAiRW50ZXIiKSBzZW5k",
  "KCk7IH0pOwp9CgovLyAiRXhwbGFpbiB0aGlzIHN0b2NrIiDigJQgY2FsbGVkIGZyb20gcmVuZGVyRGV0YWlsIG9uY2Ugc3RvY2sgZGF0YSBpcyBsb2FkZWQuCmFzeW5jIGZ1bmN0aW9uIHdpcmVFeHBsYWluQnV0dG9uKHRpY2tlcil7CiAgY29uc3QgYnRuID0gZG9j",
  "dW1lbnQuZ2V0RWxlbWVudEJ5SWQoImV4cGxhaW5CdG4iKTsKICBjb25zdCBjYXJkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImV4cGxhaW5DYXJkIik7CiAgaWYoIWJ0bikgcmV0dXJuOwogIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGFzeW5jICgp",
  "PT57CiAgICBidG4uZGlzYWJsZWQgPSB0cnVlOwogICAgYnRuLnRleHRDb250ZW50ID0gIlRoaW5raW5n4oCmIjsKICAgIGNhcmQuc3R5bGUuZGlzcGxheSA9ICJibG9jayI7CiAgICBjYXJkLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJleHBsYWluLWhlYWQiPjxk",
  "aXYgY2xhc3M9ImFpLWF2YXRhciI+4pymPC9kaXY+PGRpdiBzdHlsZT0iZm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxM3B4OyI+QUkgRXhwbGFuYXRpb248L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJleHBsYWluLXRleHQiPiR7c2tlbGV0b25MaW5lcygzKX08L2Rp",
  "dj5gOwogICAgdHJ5ewogICAgICBpZighbGl2ZUJhY2tlbmRBdmFpbGFibGUpIGF3YWl0IGNoZWNrTGl2ZUJhY2tlbmQoKTsgLy8gbWF5IGp1c3QgYmUgd2FraW5nIGZyb20gYSBjb2xkIHN0YXJ0CiAgICAgIGlmKCFsaXZlQmFja2VuZEF2YWlsYWJsZSkgdGhyb3cg",
  "bmV3IEVycm9yKCJCYWNrZW5kIG5vdCBjb25uZWN0ZWQuIElmIGl0IHdhcyBqdXN0IGlkbGUsIHRyeSBhZ2FpbiBpbiBhIG1vbWVudC4iKTsKICAgICAgY29uc3QgciA9IGF3YWl0IGZldGNoV2l0aFRpbWVvdXQoYCR7Q09ORklHLkFQSV9CQVNFfS9leHBsYWluLyR7",
  "ZW5jb2RlVVJJQ29tcG9uZW50KHRpY2tlcil9YCwgMjAwMDApOwogICAgICBjb25zdCBqc29uID0gYXdhaXQgci5qc29uKCk7CiAgICAgIGlmKCFyLm9rIHx8ICFqc29uLnN1Y2Nlc3MpIHRocm93IG5ldyBFcnJvcigoanNvbi5lcnJvciAmJiBqc29uLmVycm9yLm1l",
  "c3NhZ2UpIHx8ICgiUmVxdWVzdCBmYWlsZWQgKCIgKyByLnN0YXR1cyArICIpIikpOwogICAgICBjYXJkLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJleHBsYWluLWhlYWQiPjxkaXYgY2xhc3M9ImFpLWF2YXRhciI+4pymPC9kaXY+PGRpdiBzdHlsZT0iZm9udC13",
  "ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxM3B4OyI+QUkgRXhwbGFuYXRpb248L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJleHBsYWluLXRleHQiPiR7ZXNjYXBlSHRtbChqc29uLmRhdGEuZXhwbGFuYXRpb24pfTwvZGl2PmA7CiAgICB9Y2F0Y2goZSl7CiAgICAgIGNhcmQu",
  "aW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImV4cGxhaW4taGVhZCI+PGRpdiBjbGFzcz0iYWktYXZhdGFyIj7inKY8L2Rpdj48ZGl2IHN0eWxlPSJmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7Ij5BSSBFeHBsYW5hdGlvbjwvZGl2PjwvZGl2PjxkaXYgY2xh",
  "c3M9ImV4cGxhaW4tdGV4dCIgc3R5bGU9ImNvbG9yOnZhcigtLW5lZy1zb2Z0KTsiPkNvdWxkbid0IGdlbmVyYXRlIGFuIGV4cGxhbmF0aW9uOiAke2VzY2FwZUh0bWwoZSAmJiBlLm1lc3NhZ2UgfHwgU3RyaW5nKGUpKX08L2Rpdj5gOwogICAgfWZpbmFsbHl7CiAg",
  "ICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlOwogICAgICBidG4udGV4dENvbnRlbnQgPSAi4pymIEV4cGxhaW4gdGhpcyBzdG9jayI7CiAgICB9CiAgfSk7Cn0KCnNldEFjdGl2ZU5hdigiZGFzaGJvYXJkIik7CndpcmVBaVBhbmVsKCk7CmNoZWNrTGl2ZUJhY2tlbmQo",
  "KS5maW5hbGx5KHJlbmRlcik7CnNldEludGVydmFsKGNoZWNrTGl2ZUJhY2tlbmQsIDQ1MDAwKTsKPC9zY3JpcHQ+CjwvYm9keT4KPC9odG1sPgo="
];

const FRONTEND_HTML = Buffer.from(
  FRONTEND_B64_CHUNKS.join(""),
  "base64"
).toString("utf8");

app.get("/", (req, res) => {
  res.type("html").send(FRONTEND_HTML);
});
// SPA-style fallback so a hard refresh on any non-API path still works.
app.get(/^(?!\/api).*/, (req, res) => {
  res.type("html").send(FRONTEND_HTML);
});

app.use("/api", (req, res, next) => next(Errors.notFound(`No route for ${req.method} ${req.originalUrl}`)));
app.use(errorMiddleware);

app.listen(config.port, () => {
  console.log(`[EquityScan] running at http://localhost:${config.port}`);
  console.log(`[EquityScan] daily call budget: ${config.dailyCallBudget}, cache TTL: ${config.quoteCacheTtl}ms`);
  startBackgroundRefresh();
});
