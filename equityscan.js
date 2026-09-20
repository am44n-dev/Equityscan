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
  "ZW50KDUwJSA0MCUgYXQgNTAlIDEwMCUsIHJnYmEoNDksMjEzLDIzOCwwLjA2KSwgdHJhbnNwYXJlbnQgNjAlKTsKICBhbmltYXRpb246ZHJpZnRHbG93IDI2cyBlYXNlLWluLW91dCBpbmZpbml0ZSBhbHRlcm5hdGU7Cn0KQGtleWZyYW1lcyBkcmlmdEdsb3d7CiAg",
  "MCV7dHJhbnNmb3JtOnRyYW5zbGF0ZTNkKDAsMCwwKSBzY2FsZSgxKTt9CiAgMTAwJXt0cmFuc2Zvcm06dHJhbnNsYXRlM2QoLTIlLDIlLDApIHNjYWxlKDEuMDYpO30KfQouYW1iaWVudC1ncmlkewogIHBvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7b3BhY2l0eTow",
  "LjM1OwogIGJhY2tncm91bmQtaW1hZ2U6CiAgICBsaW5lYXItZ3JhZGllbnQodmFyKC0tYm9yZGVyLWhhaXIpIDFweCwgdHJhbnNwYXJlbnQgMXB4KSwKICAgIGxpbmVhci1ncmFkaWVudCg5MGRlZywgdmFyKC0tYm9yZGVyLWhhaXIpIDFweCwgdHJhbnNwYXJlbnQg",
  "MXB4KTsKICBiYWNrZ3JvdW5kLXNpemU6NjRweCA2NHB4OwogIG1hc2staW1hZ2U6cmFkaWFsLWdyYWRpZW50KDcwJSA2MCUgYXQgNTAlIDIwJSwgYmxhY2ssIHRyYW5zcGFyZW50IDg1JSk7Cn0KLmFtYmllbnQtbGluZXN7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6",
  "MDtvcGFjaXR5OjAuNTt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSEVBREVSCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PSAqLwpoZWFkZXIudG9wYmFyewogIHBvc2l0aW9uOnN0aWNreTt0b3A6MDt6LWluZGV4OjUwOwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjI4cHg7CiAgcGFkZGluZzowIDI4cHg7aGVpZ2h0OjY0cHg7CiAgYmFja2dyb3VuZDpyZ2Jh",
  "KDgsMTAsMTksMC41NSk7CiAgYmFja2Ryb3AtZmlsdGVyOmJsdXIoMThweCkgc2F0dXJhdGUoMTQwJSk7CiAgLXdlYmtpdC1iYWNrZHJvcC1maWx0ZXI6Ymx1cigxOHB4KSBzYXR1cmF0ZSgxNDAlKTsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB0cmFuc3BhcmVu",
  "dDsKICB0cmFuc2l0aW9uOmJhY2tncm91bmQgLjM1cyB2YXIoLS1lYXNlLW91dCksIGJvcmRlci1jb2xvciAuMzVzIHZhcigtLWVhc2Utb3V0KSwgYm94LXNoYWRvdyAuMzVzIHZhcigtLWVhc2Utb3V0KTsKfQpoZWFkZXIudG9wYmFyLnNjcm9sbGVkewogIGJhY2tn",
  "cm91bmQ6cmdiYSg4LDEwLDE5LDAuODYpOwogIGJvcmRlci1ib3R0b20tY29sb3I6dmFyKC0tYm9yZGVyLWhhaXIpOwogIGJveC1zaGFkb3c6MCAxMnB4IDMwcHggLTE4cHggcmdiYSgwLDAsMCwwLjYpOwp9Ci5icmFuZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6",
  "Y2VudGVyO2dhcDoxMXB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2luZzotMC4wMWVtO2ZvbnQtc2l6ZToxOHB4O2ZsZXgtc2hyaW5rOjA7fQouYnJhbmQtbWFya3sKICB3aWR0aDozMnB4O2hlaWdodDozMnB4O2JvcmRlci1yYWRpdXM6OXB4O3Bvc2l0aW9u",
  "OnJlbGF0aXZlO2ZsZXgtc2hyaW5rOjA7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTUwZGVnLHZhcigtLWluZGlnby03MDApLHZhcigtLWJnLWVsZXZhdGVkLTIpKTsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTsKICBib3gtc2hh",
  "ZG93OjAgNnB4IDE4cHggLThweCByZ2JhKDc2LDEyNSwyNTUsMC41NSk7CiAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyOwp9Ci5icmFuZC1tYXJrIHN2Z3t3aWR0aDoxOXB4O2hlaWdodDoxOXB4O2Rpc3BsYXk6",
  "YmxvY2s7fQouYnJhbmQtd29yZG1hcmt7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtsaW5lLWhlaWdodDoxLjE1O30KLmJyYW5kLXdvcmRtYXJrIC5lcXtjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5icmFuZC13b3JkbWFyayAuc2NhbnsKICBiYWNr",
  "Z3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMjBkZWcsdmFyKC0tYmx1ZS1zb2Z0KSx2YXIoLS12aW9sZXQtc29mdCkpOwogIC13ZWJraXQtYmFja2dyb3VuZC1jbGlwOnRleHQ7YmFja2dyb3VuZC1jbGlwOnRleHQ7Y29sb3I6dHJhbnNwYXJlbnQ7Cn0KLmJyYW5kIHNt",
  "YWxse2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6OS41cHg7bGV0dGVyLXNwYWNpbmc6MC4xZW07ZGlzcGxheTpibG9jazttYXJnaW4tdG9wOjFweDt9CgpuYXYubWFpbm5hdntkaXNwbGF5OmZsZXg7Z2FwOjRweDtmbGV4OjE7",
  "fQpuYXYubWFpbm5hdiBidXR0b257CiAgYmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLXRleHQtbWlkKTtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo2MDA7CiAgcGFkZGluZzo4cHggMTRweDtib3JkZXItcmFkaXVzOjlweDtjdXJzb3I6",
  "cG9pbnRlcjtwb3NpdGlvbjpyZWxhdGl2ZTsKICB0cmFuc2l0aW9uOmNvbG9yIC4ycyB2YXIoLS1lYXNlLW91dCksIGJhY2tncm91bmQgLjJzIHZhcigtLWVhc2Utb3V0KTsKfQpuYXYubWFpbm5hdiBidXR0b246aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dC1oaSk7YmFj",
  "a2dyb3VuZDp2YXIoLS1ib3JkZXItaGFpcik7fQpuYXYubWFpbm5hdiBidXR0b24uYWN0aXZle2NvbG9yOnZhcigtLXRleHQtaGkpO30KbmF2Lm1haW5uYXYgYnV0dG9uLmFjdGl2ZTo6YWZ0ZXJ7CiAgY29udGVudDoiIjtwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjE0",
  "cHg7cmlnaHQ6MTRweDtib3R0b206MnB4O2hlaWdodDoycHg7Ym9yZGVyLXJhZGl1czoycHg7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7Cn0KCi5oZWFkZXItcmlnaHR7ZGlzcGxheTpmbGV4O2Fs",
  "aWduLWl0ZW1zOmNlbnRlcjtnYXA6MTJweDtmbGV4LXNocmluazowO30KLm1hcmtldC1waWxsewogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjdweDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6OTlweDsKICBiYWNrZ3JvdW5kOnZh",
  "cigtLWJnLWVsZXZhdGVkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtmb250LXNpemU6MTJweDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7Zm9udC13ZWlnaHQ6NjAwOwp9Ci5kb3QtbGl2ZXt3aWR0aDo2cHg7aGVpZ2h0OjZweDtib3JkZXItcmFk",
  "aXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLXBvcyk7Ym94LXNoYWRvdzowIDAgMCAzcHggdmFyKC0tcG9zLWJnKTthbmltYXRpb246cHVsc2VEb3QgMnMgZWFzZS1pbi1vdXQgaW5maW5pdGU7fQpAa2V5ZnJhbWVzIHB1bHNlRG90ezAlLDEwMCV7b3BhY2l0eToxO301",
  "MCV7b3BhY2l0eTouNDU7fX0KCi5pY29uLWJ0bnsKICB3aWR0aDozNnB4O2hlaWdodDozNnB4O2JvcmRlci1yYWRpdXM6MTBweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkKTsKICBkaXNwbGF5",
  "OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6dmFyKC0tdGV4dC1taWQpO2N1cnNvcjpwb2ludGVyOwogIHRyYW5zaXRpb246YWxsIC4xOHMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5pY29uLWJ0bjpob3Zlcntjb2xvcjp2",
  "YXIoLS10ZXh0LWhpKTtib3JkZXItY29sb3I6dmFyKC0tYm9yZGVyLXNvZnQpO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpO30KLmljb24tYnRuIHN2Z3t3aWR0aDoxNnB4O2hlaWdodDoxNnB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBMQVlPVVQKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCm1haW57cG9zaXRpb246cmVsYXRpdmU7ei1pbmRleDoxO21heC13aWR0aDox",
  "MzIwcHg7bWFyZ2luOjAgYXV0bztwYWRkaW5nOjM2cHggMjhweCAxMjBweDt9Ci52aWV3e2FuaW1hdGlvbjp2aWV3SW4gLjQycyB2YXIoLS1lYXNlLW91dCk7fQpAa2V5ZnJhbWVzIHZpZXdJbntmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSg4cHgp",
  "O310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCk7fX0KLnNlY3Rpb24taGVhZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6YmFzZWxpbmU7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47bWFyZ2luOjAgMCAxNnB4O30KLnNlY3Rpb24taGVh",
  "ZCBoMntmb250LXNpemU6MTVweDtmb250LXdlaWdodDo3MDA7Y29sb3I6dmFyKC0tdGV4dC1oaSk7bWFyZ2luOjA7bGV0dGVyLXNwYWNpbmc6LTAuMDFlbTt9Ci5zZWN0aW9uLWhlYWQgLnN1Yntjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTIuNXB4O30K",
  "Ci8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBHTEFTUyBDQVJEIEJBU0UKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICov",
  "Ci5nbGFzc3sKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxODBkZWcsIHZhcigtLWJnLWVsZXZhdGVkKSwgdmFyKC0tYmctc3VyZmFjZSkpOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpOwogIGJvcmRlci1yYWRpdXM6dmFyKC0tcmFk",
  "aXVzLWwpOwogIHBvc2l0aW9uOnJlbGF0aXZlOwp9Ci5nbGFzczo6YmVmb3JlewogIGNvbnRlbnQ6IiI7cG9zaXRpb246YWJzb2x1dGU7aW5zZXQ6MDtib3JkZXItcmFkaXVzOmluaGVyaXQ7cGFkZGluZzoxcHg7cG9pbnRlci1ldmVudHM6bm9uZTsKICBiYWNrZ3Jv",
  "dW5kOmxpbmVhci1ncmFkaWVudCgxNjBkZWcsIHJnYmEoMjU1LDI1NSwyNTUsMC4wNiksIHRyYW5zcGFyZW50IDQwJSk7CiAgLXdlYmtpdC1tYXNrOmxpbmVhci1ncmFkaWVudCgjMDAwIDAgMCkgY29udGVudC1ib3gsIGxpbmVhci1ncmFkaWVudCgjMDAwIDAgMCk7",
  "CiAgLXdlYmtpdC1tYXNrLWNvbXBvc2l0ZTp4b3I7bWFzay1jb21wb3NpdGU6ZXhjbHVkZTsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEhFUk8gLyBJTkRJQ0VTCiAgID09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouaGVyby1yb3d7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpO2dhcDoxNHB4O21hcmdpbi1ib3R0b206MzRweDt9Ci5pbmRl",
  "eC1jYXJkewogIHBhZGRpbmc6MjBweCAyMnB4O292ZXJmbG93OmhpZGRlbjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMjVzIHZhcigtLWVhc2Utb3V0KSwgYm9yZGVyLWNvbG9yIC4yNXMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5pbmRleC1jYXJkOmhvdmVye3RyYW5zZm9y",
  "bTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjp2YXIoLS1ib3JkZXItc29mdCk7fQouaW5kZXgtY2FyZCAucm93MXtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9t",
  "OjE0cHg7fQouaW5kZXgtbmFtZXtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7bGV0dGVyLXNwYWNpbmc6MC4wMWVtO30KLmluZGV4LWZ1bGx7Zm9udC1zaXplOjEwLjVweDtjb2xvcjp2YXIoLS10ZXh0LWZhaW50",
  "KTttYXJnaW4tdG9wOjJweDt9Ci5pbmRleC1iYWRnZXtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7cGFkZGluZzozcHggOHB4O2JvcmRlci1yYWRpdXM6N3B4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDt9Ci5pbmRleC1iYWRn",
  "ZS5wb3N7Y29sb3I6dmFyKC0tcG9zKTtiYWNrZ3JvdW5kOnZhcigtLXBvcy1iZyk7fQouaW5kZXgtYmFkZ2UubmVne2NvbG9yOnZhcigtLW5lZyk7YmFja2dyb3VuZDp2YXIoLS1uZWctYmcpO30KLmluZGV4LXZhbHVle2ZvbnQtc2l6ZToyOHB4O2ZvbnQtd2VpZ2h0",
  "OjcwMDtsZXR0ZXItc3BhY2luZzotMC4wMWVtO30KLmluZGV4LWNoYW5nZXtmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7bWFyZ2luLXRvcDo0cHg7fQouaW5kZXgtY2hhbmdlLnBvc3tjb2xvcjp2YXIoLS1wb3Mtc29mdCk7fQouaW5kZXgtY2hhbmdlLm5l",
  "Z3tjb2xvcjp2YXIoLS1uZWctc29mdCk7fQouaW5kZXgtc3Bhcmt7bWFyZ2luLXRvcDoxNHB4O2hlaWdodDozNnB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTRUFSQ0gKICAgPT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5zZWFyY2gtd3JhcHtwb3NpdGlvbjpyZWxhdGl2ZTttYXJnaW4tYm90dG9tOjM4cHg7fQouc2VhcmNoLWJveHsKICBkaXNwbGF5OmZsZXg7YWxpZ24taXRl",
  "bXM6Y2VudGVyO2dhcDoxMHB4O3BhZGRpbmc6MTRweCAxNnB4O2JvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLW0pOwogIGJhY2tncm91bmQ6cmdiYSgxOSwyNCw0MSwwLjc1KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxMnB4KTsKICBib3JkZXI6MXB4IHNvbGlkIHZh",
  "cigtLWJvcmRlci1zb2Z0KTsKICB0cmFuc2l0aW9uOmJvcmRlci1jb2xvciAuMjJzIHZhcigtLWVhc2Utb3V0KSwgYm94LXNoYWRvdyAuMjJzIHZhcigtLWVhc2Utb3V0KTsKfQouc2VhcmNoLWJveC5mb2N1c2VkewogIGJvcmRlci1jb2xvcjpyZ2JhKDEyNCwxNTAs",
  "MjU1LDAuNTUpOwogIGJveC1zaGFkb3c6MCAwIDAgNHB4IHJnYmEoNzYsMTI1LDI1NSwwLjEwKSwgMCAxOHB4IDQwcHggLTIwcHggcmdiYSg3NiwxMjUsMjU1LDAuMzUpOwp9Ci5zZWFyY2gtYm94IHN2Z3t3aWR0aDoxN3B4O2hlaWdodDoxN3B4O2NvbG9yOnZhcigt",
  "LXRleHQtbG8pO2ZsZXgtc2hyaW5rOjA7fQouc2VhcmNoLWJveCBpbnB1dHsKICBmbGV4OjE7YmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO291dGxpbmU6bm9uZTtjb2xvcjp2YXIoLS10ZXh0LWhpKTtmb250LXNpemU6MTQuNXB4O2ZvbnQtZmFtaWx5OnZhcigt",
  "LWZvbnQtdWkpOwp9Ci5zZWFyY2gtYm94IGlucHV0OjpwbGFjZWhvbGRlcntjb2xvcjp2YXIoLS10ZXh0LWxvKTt9CmtiZC5rc2hvcnRjdXR7CiAgZm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pO2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO2Jv",
  "cmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIHBhZGRpbmc6MnB4IDdweDtib3JkZXItcmFkaXVzOjZweDtiYWNrZ3JvdW5kOnZhcigtLWJnLWJhc2UpOwp9Ci5zZWFyY2gtZHJvcHsKICBwb3NpdGlvbjphYnNvbHV0ZTtsZWZ0OjA7cmlnaHQ6MDt0",
  "b3A6Y2FsYygxMDAlICsgOHB4KTt6LWluZGV4OjQwOwogIGJvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLW0pO292ZXJmbG93OmhpZGRlbjsKICBiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTsK",
  "ICBib3gtc2hhZG93OjAgMjRweCA2MHB4IC0yMnB4IHJnYmEoMCwwLDAsMC42NSk7CiAgbWF4LWhlaWdodDozNDBweDtvdmVyZmxvdy15OmF1dG87Cn0KLnNlYXJjaC1yb3d7CiAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6",
  "c3BhY2UtYmV0d2VlbjtwYWRkaW5nOjExcHggMTZweDtjdXJzb3I6cG9pbnRlcjsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7CiAgYW5pbWF0aW9uOnJvd0luIC4yOHMgdmFyKC0tZWFzZS1vdXQpIGJvdGg7CiAgdHJhbnNpdGlv",
  "bjpiYWNrZ3JvdW5kIC4xNXM7Cn0KLnNlYXJjaC1yb3c6aG92ZXJ7YmFja2dyb3VuZDp2YXIoLS1ib3JkZXItaGFpcik7fQouc2VhcmNoLXJvdzpsYXN0LWNoaWxke2JvcmRlci1ib3R0b206bm9uZTt9CkBrZXlmcmFtZXMgcm93SW57ZnJvbXtvcGFjaXR5OjA7dHJh",
  "bnNmb3JtOnRyYW5zbGF0ZVkoLTRweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06dHJhbnNsYXRlWSgwKTt9fQouc3ItbGVmdHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMXB4O30KLnNyLXRpY2tlcnsKICB3aWR0aDozNnB4O2hlaWdodDoz",
  "NnB4O2JvcmRlci1yYWRpdXM6OXB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjsKICBmb250LXNpemU6MTFweDtmb250LXdlaWdodDo4MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pOwogIGJhY2tncm91",
  "bmQ6bGluZWFyLWdyYWRpZW50KDE1MGRlZyx2YXIoLS1pbmRpZ28tNzAwKSx2YXIoLS1iZy1lbGV2YXRlZC0yKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Y29sb3I6dmFyKC0tYmx1ZS1zb2Z0KTsKfQouc3ItbmFtZXtmb250LXNpemU6MTMu",
  "NXB4O2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5zci1tZXRhe2ZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7fQouc3ItcHJpY2V7Zm9udC1zaXplOjEzLjVweDtmb250LXdlaWdodDo3MDA7fQouc2VhcmNoLWVtcHR5",
  "e3BhZGRpbmc6MjZweCAxNnB4O3RleHQtYWxpZ246Y2VudGVyO2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxM3B4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTQ1JFRU5F",
  "UiBGSUxURVJTCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouZmlsdGVycy1iYXJ7CiAgZGlzcGxheTpmbGV4O2ZsZXgtd3JhcDp3cmFwO2dhcDoxMHB4O3BhZGRpbmc6MTZweDttYXJnaW4t",
  "Ym90dG9tOjIwcHg7Cn0KLmZpbHRlci1jaGlwewogIGRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjRweDtwYWRkaW5nOjlweCAxNHB4O2JvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLXMpOwogIGJhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7",
  "Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7bWluLXdpZHRoOjE1MHB4Owp9Ci5maWx0ZXItY2hpcCBsYWJlbHtmb250LXNpemU6MTAuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtd2VpZ2h0OjcwMDtsZXR0ZXItc3BhY2luZzowLjAyZW07",
  "fQouZmlsdGVyLWNoaXAgc2VsZWN0LCAuZmlsdGVyLWNoaXAgaW5wdXRbdHlwZT10ZXh0XXsKICBiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tdGV4dC1oaSk7Zm9udC1zaXplOjEzcHg7Zm9udC13ZWlnaHQ6NjAwO291dGxpbmU6bm9uZTtm",
  "b250LWZhbWlseTppbmhlcml0Owp9Ci5yYW5nZS1zbGlkZXJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7YXBwZWFyYW5jZTpub25lO3dpZHRoOjEzMHB4O2hlaWdodDozcHg7Ym9yZGVyLXJhZGl1czozcHg7YmFja2dyb3VuZDp2YXIoLS1ib3JkZXItc29mdCk7b3V0",
  "bGluZTpub25lO2N1cnNvcjpwb2ludGVyO30KLnJhbmdlLXNsaWRlcjo6LXdlYmtpdC1zbGlkZXItdGh1bWJ7LXdlYmtpdC1hcHBlYXJhbmNlOm5vbmU7d2lkdGg6MTNweDtoZWlnaHQ6MTNweDtib3JkZXItcmFkaXVzOjUwJTtiYWNrZ3JvdW5kOnZhcigtLWJsdWUt",
  "c29mdCk7Ym94LXNoYWRvdzowIDAgMCAzcHggcmdiYSg3NiwxMjUsMjU1LDAuMjIpO2N1cnNvcjpwb2ludGVyO30KLnJhbmdlLXZhbHtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpO30KLnRvZ2dsZS1ncm91cHtk",
  "aXNwbGF5OmZsZXg7Z2FwOjZweDt9Ci50b2dnbGUtYnRuewogIHBhZGRpbmc6NXB4IDExcHg7Ym9yZGVyLXJhZGl1czo3cHg7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVyOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVy",
  "LWhhaXIpO2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7Y29sb3I6dmFyKC0tdGV4dC1taWQpOwogIHRyYW5zaXRpb246YWxsIC4xNnMgdmFyKC0tZWFzZS1vdXQpOwp9Ci50b2dnbGUtYnRuLmFjdGl2ZXtjb2xvcjojZmZmO2JvcmRlci1jb2xvcjp0cmFuc3BhcmVu",
  "dDtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7fQoucmVzZXQtZmlsdGVyc3ttYXJnaW4tbGVmdDphdXRvO2FsaWduLXNlbGY6Y2VudGVyO2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMi41",
  "cHg7Zm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVyO3BhZGRpbmc6OHB4IDZweDt9Ci5yZXNldC1maWx0ZXJzOmhvdmVye2NvbG9yOnZhcigtLXRleHQtaGkpO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PQogICBUQUJMRQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLnRhYmxlLXdyYXB7b3ZlcmZsb3cteDphdXRvO2JvcmRlci1yYWRpdXM6dmFyKC0tcmFkaXVzLWwpO30KdGFi",
  "bGUuc3RvY2stdGFibGV7d2lkdGg6MTAwJTtib3JkZXItY29sbGFwc2U6Y29sbGFwc2U7bWluLXdpZHRoOjc2MHB4O30KLnN0b2NrLXRhYmxlIHRoZWFkIHRoewogIHBvc2l0aW9uOnN0aWNreTt0b3A6NjRweDt6LWluZGV4OjU7CiAgdGV4dC1hbGlnbjpyaWdodDtm",
  "b250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bGV0dGVyLXNwYWNpbmc6MC4wMmVtOwogIHBhZGRpbmc6MTJweCAxNnB4O2JhY2tncm91bmQ6cmdiYSgxMywxNywzMiwwLjkyKTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxMHB4",
  "KTsKICBib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7Y3Vyc29yOnBvaW50ZXI7dXNlci1zZWxlY3Q6bm9uZTt3aGl0ZS1zcGFjZTpub3dyYXA7Cn0KLnN0b2NrLXRhYmxlIHRoZWFkIHRoOmZpcnN0LWNoaWxkLCAuc3RvY2stdGFibGUg",
  "dGhlYWQgdGg6bnRoLWNoaWxkKDIpe3RleHQtYWxpZ246bGVmdDt9Ci5zdG9jay10YWJsZSB0aGVhZCB0aDpob3Zlcntjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5zdG9jay10YWJsZSB0aGVhZCB0aCAuc29ydC1pbmR7b3BhY2l0eTowO21hcmdpbi1sZWZ0OjRweDtm",
  "b250LXNpemU6OXB4O3RyYW5zaXRpb246b3BhY2l0eSAuMTVzO30KLnN0b2NrLXRhYmxlIHRoZWFkIHRoLnNvcnRlZCAuc29ydC1pbmR7b3BhY2l0eToxO2NvbG9yOnZhcigtLWJsdWUtc29mdCk7fQouc3RvY2stdGFibGUgdGJvZHkgdHJ7CiAgYm9yZGVyLWJvdHRv",
  "bToxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpO2N1cnNvcjpwb2ludGVyOwogIHRyYW5zaXRpb246YmFja2dyb3VuZCAuMTVzIHZhcigtLWVhc2Utb3V0KTsKICBhbmltYXRpb246cm93RmFkZSAuM3MgdmFyKC0tZWFzZS1vdXQpIGJvdGg7Cn0KLnN0b2NrLXRh",
  "YmxlIHRib2R5IHRyOmhvdmVye2JhY2tncm91bmQ6dmFyKC0tYm9yZGVyLWhhaXIpO30KLnN0b2NrLXRhYmxlIHRke3BhZGRpbmc6MTNweCAxNnB4O3RleHQtYWxpZ246cmlnaHQ7Zm9udC1zaXplOjEzcHg7d2hpdGUtc3BhY2U6bm93cmFwO30KLnN0b2NrLXRhYmxl",
  "IHRkOmZpcnN0LWNoaWxkLCAuc3RvY2stdGFibGUgdGQ6bnRoLWNoaWxkKDIpe3RleHQtYWxpZ246bGVmdDt9CkBrZXlmcmFtZXMgcm93RmFkZXtmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWCgtNHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0",
  "cmFuc2xhdGVYKDApO319Ci5jZWxsLWNvbXBhbnl7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTBweDt9Ci5jZWxsLXRpY2tlci1iYWRnZXsKICB3aWR0aDozMHB4O2hlaWdodDozMHB4O2JvcmRlci1yYWRpdXM6OHB4O2ZvbnQtc2l6ZTo5LjVw",
  "eDtmb250LXdlaWdodDo4MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pOwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpOwogIGJhY2tncm91bmQ6bGluZWFyLWdy",
  "YWRpZW50KDE1MGRlZyx2YXIoLS1pbmRpZ28tNzAwKSx2YXIoLS1iZy1lbGV2YXRlZC0yKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7ZmxleC1zaHJpbms6MDsKfQouY29tcGFueS1uYW1le2ZvbnQtd2VpZ2h0OjYwMDtjb2xvcjp2YXIoLS10",
  "ZXh0LWhpKTtmb250LXNpemU6MTNweDt9Ci5jb21wYW55LXN1Yntmb250LXNpemU6MTFweDtjb2xvcjp2YXIoLS10ZXh0LWxvKTt9Ci5jaGFuZ2UtcGlsbHsKICBkaXNwbGF5OmlubGluZS1mbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6M3B4O3BhZGRpbmc6M3B4",
  "IDhweDtib3JkZXItcmFkaXVzOjZweDtmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEyLjVweDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7Cn0KLmNoYW5nZS1waWxsLnBvc3tjb2xvcjp2YXIoLS1wb3MpO2JhY2tncm91bmQ6dmFyKC0tcG9zLWJnKTt9Ci5j",
  "aGFuZ2UtcGlsbC5uZWd7Y29sb3I6dmFyKC0tbmVnKTtiYWNrZ3JvdW5kOnZhcigtLW5lZy1iZyk7fQouc3Rhci1idG57YmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2N1cnNvcjpwb2ludGVyO2NvbG9yOnZhcigtLXRleHQtZmFpbnQpO3BhZGRpbmc6NHB4O3Ry",
  "YW5zaXRpb246YWxsIC4ycyB2YXIoLS1lYXNlLXNwcmluZyk7fQouc3Rhci1idG46aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dC1taWQpO3RyYW5zZm9ybTpzY2FsZSgxLjE1KTt9Ci5zdGFyLWJ0bi5hY3RpdmV7Y29sb3I6I0ZGQzg1Nzt9Ci5zdGFyLWJ0biBzdmd7d2lk",
  "dGg6MTZweDtoZWlnaHQ6MTZweDt9CgovKiBtb2JpbGUgY2FyZHMgKi8KLnN0b2NrLWNhcmRze2Rpc3BsYXk6bm9uZTtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Z2FwOjEwcHg7fQouc3RvY2stY2FyZHsKICBwYWRkaW5nOjE0cHggMTZweDtkaXNwbGF5OmZsZXg7YWxp",
  "Z24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2dhcDoxMnB4OwogIGFuaW1hdGlvbjpyb3dGYWRlIC4zcyB2YXIoLS1lYXNlLW91dCkgYm90aDsKfQouc3RvY2stY2FyZCAubGVmdHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2Vu",
  "dGVyO2dhcDoxMXB4O21pbi13aWR0aDowO30KLnN0b2NrLWNhcmQgLm5hbWUtYmxvY2t7bWluLXdpZHRoOjA7fQouc3RvY2stY2FyZCAuY29tcGFueS1uYW1le2Rpc3BsYXk6YmxvY2s7b3ZlcmZsb3c6aGlkZGVuO3RleHQtb3ZlcmZsb3c6ZWxsaXBzaXM7d2hpdGUt",
  "c3BhY2U6bm93cmFwO21heC13aWR0aDoxMzBweDt9Ci5zdG9jay1jYXJkIC5yaWdodHt0ZXh0LWFsaWduOnJpZ2h0O2ZsZXgtc2hyaW5rOjA7fQouc3RvY2stY2FyZCAucHJpY2V7Zm9udC1zaXplOjE0LjVweDtmb250LXdlaWdodDo3MDA7Zm9udC1mYW1pbHk6dmFy",
  "KC0tZm9udC1udW0pO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTVE9DSyBERVRBSUwKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09ICovCi5kZXRhaWwtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmbGV4LXdyYXA6d3JhcDtnYXA6MjBweDttYXJnaW4tYm90dG9tOjI2cHg7fQouZGV0YWlsLXRpdGxl",
  "LXJvd3tkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxNHB4O30KLmRldGFpbC10aWNrZXItYmFkZ2V7CiAgd2lkdGg6NTJweDtoZWlnaHQ6NTJweDtib3JkZXItcmFkaXVzOjE0cHg7Zm9udC1zaXplOjE1cHg7Zm9udC13ZWlnaHQ6ODAwO2ZvbnQt",
  "ZmFtaWx5OnZhcigtLWZvbnQtbnVtKTsKICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y29sb3I6dmFyKC0tYmx1ZS1zb2Z0KTsKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxNTBkZWcsdmFyKC0taW5k",
  "aWdvLTcwMCksdmFyKC0tYmctZWxldmF0ZWQtMikpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwp9Ci5kZXRhaWwtbmFtZXtmb250LXNpemU6MjJweDtmb250LXdlaWdodDo4MDA7bGV0dGVyLXNwYWNpbmc6LTAuMDE1ZW07fQouZGV0YWlsLXN1",
  "Yntmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO21hcmdpbi10b3A6MnB4O30KLmRldGFpbC1wcmljZS1ibG9ja3t0ZXh0LWFsaWduOnJpZ2h0O30KLmRldGFpbC1wcmljZXtmb250LXNpemU6MzJweDtmb250LXdlaWdodDo4MDA7Zm9udC1mYW1p",
  "bHk6dmFyKC0tZm9udC1udW0pO2xldHRlci1zcGFjaW5nOi0wLjAxZW07fQouZGV0YWlsLWNoYW5nZXtmb250LXNpemU6MTRweDtmb250LXdlaWdodDo3MDA7bWFyZ2luLXRvcDo0cHg7fQoKLm1ldHJpY3MtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1j",
  "b2x1bW5zOnJlcGVhdCg2LDFmcik7Z2FwOjEwcHg7bWFyZ2luOjI0cHggMCAyOHB4O30KLm1ldHJpYy1jYXJke3BhZGRpbmc6MTRweCAxNnB4O30KLm1ldHJpYy1sYWJlbHtmb250LXNpemU6MTAuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtd2VpZ2h0Ojcw",
  "MDtsZXR0ZXItc3BhY2luZzowLjAyZW07bWFyZ2luLWJvdHRvbTo2cHg7fQoubWV0cmljLXZhbHVle2ZvbnQtc2l6ZToxNS41cHg7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtZmFtaWx5OnZhcigtLWZvbnQtbnVtKTt9CgouY2hhcnQtY2FyZHtwYWRkaW5nOjIycHg7bWFy",
  "Z2luLWJvdHRvbToyOHB4O30KLmNoYXJ0LWhlYWR7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmNlbnRlcjttYXJnaW4tYm90dG9tOjZweDtmbGV4LXdyYXA6d3JhcDtnYXA6MTJweDt9Ci5yYW5nZS10YWJze2Rp",
  "c3BsYXk6ZmxleDtnYXA6MnB4O2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7cGFkZGluZzozcHg7Ym9yZGVyLXJhZGl1czo5cHg7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7fQoucmFuZ2UtdGFicyBidXR0b257CiAgYm9yZGVyOm5vbmU7YmFj",
  "a2dyb3VuZDpub25lO2NvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4O2ZvbnQtd2VpZ2h0OjcwMDtwYWRkaW5nOjZweCAxMnB4O2JvcmRlci1yYWRpdXM6N3B4O2N1cnNvcjpwb2ludGVyOwogIHRyYW5zaXRpb246YWxsIC4xOHMgdmFyKC0tZWFzZS1v",
  "dXQpOwp9Ci5yYW5nZS10YWJzIGJ1dHRvbi5hY3RpdmV7Y29sb3I6I2ZmZjtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7fQouY2hhcnQtY2FudmFzLXdyYXB7cG9zaXRpb246cmVsYXRpdmU7aGVpZ2h0",
  "OjI4MHB4O21hcmdpbi10b3A6MTRweDt9Ci52b2x1bWUtd3JhcHttYXJnaW4tdG9wOjEwcHg7fQoudm9sdW1lLWxhYmVse2ZvbnQtc2l6ZToxMC41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOjAuMDJlbTttYXJn",
  "aW4tYm90dG9tOjZweDt9CiN2b2x1bWVDaGFydHt3aWR0aDoxMDAlO2hlaWdodDo2NHB4O2Rpc3BsYXk6YmxvY2s7fQouY2hhcnQtdG9vbHRpcHsKICBwb3NpdGlvbjphYnNvbHV0ZTtwb2ludGVyLWV2ZW50czpub25lO3BhZGRpbmc6OHB4IDExcHg7Ym9yZGVyLXJh",
  "ZGl1czo5cHg7YmFja2dyb3VuZDp2YXIoLS1iZy1lbGV2YXRlZC0yKTsKICBib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTtmb250LXNpemU6MTEuNXB4O2JveC1zaGFkb3c6MCAxNHB4IDMwcHggLTEycHggcmdiYSgwLDAsMCwwLjYpOwogIG9wYWNp",
  "dHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlKC01MCUsLTExNSUpO3RyYW5zaXRpb246b3BhY2l0eSAuMXM7d2hpdGUtc3BhY2U6bm93cmFwO3otaW5kZXg6NjsKfQouY2hhcnQtdG9vbHRpcCAudHQtcHJpY2V7Zm9udC13ZWlnaHQ6NzAwO2ZvbnQtZmFtaWx5OnZhcigt",
  "LWZvbnQtbnVtKTtjb2xvcjp2YXIoLS10ZXh0LWhpKTt9Ci5jaGFydC10b29sdGlwIC50dC1kYXRle2NvbG9yOnZhcigtLXRleHQtbG8pO21hcmdpbi10b3A6MnB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PQogICBXQVRDSExJU1QKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi53YXRjaGxpc3QtZ3JpZHtkaXNwbGF5OmdyaWQ7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgz",
  "LDFmcik7Z2FwOjE0cHg7fQoudHJlbmRpbmctcm93e2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTtnYXA6MTRweDttYXJnaW4tYm90dG9tOjM0cHg7fQoudHJlbmRpbmctY2FyZHtwYWRkaW5nOjE2cHggMThweDtjdXJzb3I6",
  "cG9pbnRlcjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMnMgdmFyKC0tZWFzZS1vdXQpLGJvcmRlci1jb2xvciAuMnMgdmFyKC0tZWFzZS1vdXQpO2FuaW1hdGlvbjpjYXJkSW4gLjM4cyB2YXIoLS1lYXNlLXNwcmluZykgYm90aDt9Ci50cmVuZGluZy1jYXJkOmhvdmVy",
  "e3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO2JvcmRlci1jb2xvcjp2YXIoLS1ib3JkZXItc29mdCk7fQoudHJlbmRpbmctdG9we2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpjZW50ZXI7fQoud2F0Y2gtY2Fy",
  "ZHtwYWRkaW5nOjE2cHggMThweDtwb3NpdGlvbjpyZWxhdGl2ZTtvdmVyZmxvdzpoaWRkZW47dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzIHZhcigtLWVhc2Utb3V0KTt9Ci53YXRjaC1jYXJkOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpO30KLndhdGNo",
  "LWNhcmQucmVtb3Zpbmd7YW5pbWF0aW9uOmNhcmRPdXQgLjNzIHZhcigtLWVhc2Utb3V0KSBmb3J3YXJkczt9CkBrZXlmcmFtZXMgY2FyZE91dHt0b3tvcGFjaXR5OjA7dHJhbnNmb3JtOnNjYWxlKDAuOSkgdHJhbnNsYXRlWSg2cHgpO319Ci53YXRjaC1jYXJkLmVu",
  "dGVyaW5ne2FuaW1hdGlvbjpjYXJkSW4gLjM4cyB2YXIoLS1lYXNlLXNwcmluZykgYm90aDt9CkBrZXlmcmFtZXMgY2FyZElue2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTpzY2FsZSgwLjkpIHRyYW5zbGF0ZVkoMTBweCk7fXRve29wYWNpdHk6MTt0cmFuc2Zvcm06",
  "c2NhbGUoMSkgdHJhbnNsYXRlWSgwKTt9fQoud2F0Y2gtdG9we2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpmbGV4LXN0YXJ0O21hcmdpbi1ib3R0b206MTBweDt9Ci53YXRjaC1lbXB0eXtwYWRkaW5nOjYwcHgg",
  "MjBweDt0ZXh0LWFsaWduOmNlbnRlcjtncmlkLWNvbHVtbjoxLy0xO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBTS0VMRVRPTlMKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCkBrZXlmcmFtZXMgc2hpbW1lcnswJXtiYWNrZ3JvdW5kLXBvc2l0aW9uOi0zMDBweCAwO30xMDAle2JhY2tncm91bmQtcG9zaXRpb246MzAwcHggMDt9fQouc2tlbHsKICBib3JkZXItcmFkaXVzOjhw",
  "eDsKICBiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZywgdmFyKC0tYmctZWxldmF0ZWQpIDI1JSwgdmFyKC0tYmctZWxldmF0ZWQtMikgNTAlLCB2YXIoLS1iZy1lbGV2YXRlZCkgNzUlKTsKICBiYWNrZ3JvdW5kLXNpemU6MzAwcHggMTAwJTsKICBhbmlt",
  "YXRpb246c2hpbW1lciAxLjVzIGVhc2UtaW4tb3V0IGluZmluaXRlOwp9Ci5za2VsLWxpbmV7aGVpZ2h0OjEycHg7bWFyZ2luLWJvdHRvbTo4cHg7fQouc2tlbC1jYXJke2hlaWdodDoxMTJweDtib3JkZXItcmFkaXVzOnZhcigtLXJhZGl1cy1sKTt9CgovKiA9PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgRU1QVFkgLyBFUlJPUiBTVEFURVMKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5z",
  "dGF0ZS1ib3h7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjt0ZXh0LWFsaWduOmNlbnRlcjsKICBwYWRkaW5nOjY0cHggMjRweDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7",
  "Z2FwOjEycHg7Cn0KLnN0YXRlLWljb257CiAgd2lkdGg6NTJweDtoZWlnaHQ6NTJweDtib3JkZXItcmFkaXVzOjE0cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyOwogIGJhY2tncm91bmQ6dmFyKC0tYmctZWxl",
  "dmF0ZWQtMik7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bWFyZ2luLWJvdHRvbTo0cHg7Cn0KLnN0YXRlLXRpdGxle2ZvbnQtc2l6ZToxNC41cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOnZhcigtLXRleHQt",
  "aGkpO30KLnN0YXRlLXN1Yntmb250LXNpemU6MTIuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO21heC13aWR0aDozMjBweDt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQk9UVE9NIE5B",
  "ViAobW9iaWxlKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLmJvdHRvbS1uYXZ7CiAgZGlzcGxheTpub25lO3Bvc2l0aW9uOmZpeGVkO2xlZnQ6MDtyaWdodDowO2JvdHRvbTowO3otaW5k",
  "ZXg6NTA7CiAgYmFja2dyb3VuZDpyZ2JhKDEwLDEzLDIzLDAuOSk7YmFja2Ryb3AtZmlsdGVyOmJsdXIoMThweCk7CiAgYm9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpOwogIHBhZGRpbmc6OHB4IDZweCBjYWxjKDhweCArIGVudihzYWZlLWFy",
  "ZWEtaW5zZXQtYm90dG9tKSk7CiAganVzdGlmeS1jb250ZW50OnNwYWNlLWFyb3VuZDsKfQouYm90dG9tLW5hdiBidXR0b257CiAgYmFja2dyb3VuZDpub25lO2JvcmRlcjpub25lO2NvbG9yOnZhcigtLXRleHQtbG8pO2Rpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlv",
  "bjpjb2x1bW47YWxpZ24taXRlbXM6Y2VudGVyO2dhcDozcHg7CiAgZm9udC1zaXplOjEwcHg7Zm9udC13ZWlnaHQ6NzAwO3BhZGRpbmc6NHB4IDEwcHg7Y3Vyc29yOnBvaW50ZXI7Cn0KLmJvdHRvbS1uYXYgYnV0dG9uIHN2Z3t3aWR0aDoxOXB4O2hlaWdodDoxOXB4",
  "O30KLmJvdHRvbS1uYXYgYnV0dG9uLmFjdGl2ZXtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBSRVNQT05TSVZFCiAgID09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpAbWVkaWEgKG1heC13aWR0aDogOTgwcHgpewogIC5oZXJvLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTt9CiAgLm1ldHJpY3MtZ3JpZHtncmlkLXRl",
  "bXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTt9CiAgLndhdGNobGlzdC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KICAudHJlbmRpbmctcm93e2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMiwxZnIpO30KfQovKiA9PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQUkgQVNTSVNUQU5UIOKAlCBmbG9hdGluZyBidXR0b24gKyBjaGF0IHBhbmVsLCBleHBsYWluLXN0b2NrIGNhcmQKICAgPT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5haS1mYWJ7CiAgcG9zaXRpb246Zml4ZWQ7cmlnaHQ6MjJweDtib3R0b206MjJweDt6LWluZGV4OjYwOwogIHdpZHRoOjUycHg7aGVpZ2h0OjUycHg7Ym9yZGVyLXJhZGl1czoxNnB4O2Jv",
  "cmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE1MGRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpIDcwJSx2YXIoLS1jeWFuKSk7CiAgY29sb3I6I2ZmZjtkaXNwbGF5OmZsZXg7YWxpZ24taXRl",
  "bXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y3Vyc29yOnBvaW50ZXI7CiAgYm94LXNoYWRvdzowIDE0cHggMzRweCAtMTJweCByZ2JhKDc2LDEyNSwyNTUsMC41NSk7CiAgdHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjJzIHZhcigtLWVhc2Utc3ByaW5nKTsK",
  "fQouYWktZmFiOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgpIHNjYWxlKDEuMDQpO30KLmFpLWZhYiBzdmd7d2lkdGg6MjJweDtoZWlnaHQ6MjJweDt9Ci5haS1mYWIuaGlkZGVuLCAuYWktcGFuZWwuaGlkZGVue2Rpc3BsYXk6bm9uZTt9CgouYWktcGFu",
  "ZWx7CiAgcG9zaXRpb246Zml4ZWQ7cmlnaHQ6MjJweDtib3R0b206ODhweDt6LWluZGV4OjYxOwogIHdpZHRoOjM2MHB4O21heC13aWR0aDpjYWxjKDEwMHZ3IC0gMzJweCk7aGVpZ2h0Om1pbig1MjBweCwgNzB2aCk7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0",
  "aW9uOmNvbHVtbjtib3JkZXItcmFkaXVzOnZhcigtLXJhZGl1cy1sKTtvdmVyZmxvdzpoaWRkZW47CiAgYmFja2dyb3VuZDp2YXIoLS1iZy1lbGV2YXRlZCk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7CiAgYm94LXNoYWRvdzowIDMwcHggNzBw",
  "eCAtMjBweCByZ2JhKDAsMCwwLDAuNjUpOwogIGFuaW1hdGlvbjpwYW5lbEluIC4yOHMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5haS1wYW5lbC5oaWRkZW57ZGlzcGxheTpub25lO30KQGtleWZyYW1lcyBwYW5lbElue2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTp0cmFu",
  "c2xhdGVZKDEwcHgpIHNjYWxlKDAuOTgpO310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoMCkgc2NhbGUoMSk7fX0KLmFpLXBhbmVsLWhlYWR7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2Vl",
  "bjtwYWRkaW5nOjEycHggMTRweDtib3JkZXItYm90dG9tOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7ZmxleC1zaHJpbms6MDt9Ci5haS1hdmF0YXJ7d2lkdGg6MjhweDtoZWlnaHQ6MjhweDtib3JkZXItcmFkaXVzOjlweDtiYWNrZ3JvdW5kOmxpbmVhci1n",
  "cmFkaWVudCgxNTBkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOiNmZmY7Zm9udC1zaXplOjE0cHg7ZmxleC1zaHJpbms6MDt9Ci5haS1tZXNzYWdl",
  "c3tmbGV4OjE7b3ZlcmZsb3cteTphdXRvO3BhZGRpbmc6MTRweDtkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2dhcDoxMHB4O30KLmFpLW1zZ3tmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjU7cGFkZGluZzoxMHB4IDEycHg7Ym9yZGVyLXJh",
  "ZGl1czoxMXB4O21heC13aWR0aDo4OCU7d2hpdGUtc3BhY2U6cHJlLXdyYXA7fQouYWktbXNnLmFzc2lzdGFudHtiYWNrZ3JvdW5kOnZhcigtLWJnLWJhc2UpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpO2NvbG9yOnZhcigtLXRleHQtbWlkKTth",
  "bGlnbi1zZWxmOmZsZXgtc3RhcnQ7fQouYWktbXNnLnVzZXJ7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHZhcigtLWJsdWUpLHZhcigtLXZpb2xldCkpO2NvbG9yOiNmZmY7YWxpZ24tc2VsZjpmbGV4LWVuZDt9Ci5haS1tc2cucGVuZGluZ3tjb2xv",
  "cjp2YXIoLS10ZXh0LWZhaW50KTtmb250LXN0eWxlOml0YWxpYzt9Ci5haS1tc2cuZXJyb3J7YmFja2dyb3VuZDp2YXIoLS1uZWctYmcpO2JvcmRlcjoxcHggc29saWQgcmdiYSgyNTEsMTA3LDEwNywwLjMpO2NvbG9yOnZhcigtLW5lZy1zb2Z0KTthbGlnbi1zZWxm",
  "OmZsZXgtc3RhcnQ7fQouYWktaW5wdXQtcm93e2Rpc3BsYXk6ZmxleDtnYXA6OHB4O3BhZGRpbmc6MTBweDtib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7ZmxleC1zaHJpbms6MDt9Ci5haS1pbnB1dC1yb3cgaW5wdXR7ZmxleDoxO2JhY2tn",
  "cm91bmQ6dmFyKC0tYmctYmFzZSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Ym9yZGVyLXJhZGl1czoxMHB4O3BhZGRpbmc6OXB4IDEycHg7Y29sb3I6dmFyKC0tdGV4dC1oaSk7Zm9udC1zaXplOjEzcHg7Zm9udC1mYW1pbHk6dmFyKC0tZm9u",
  "dC11aSk7b3V0bGluZTpub25lO30KLmFpLWlucHV0LXJvdyBpbnB1dDpmb2N1c3tib3JkZXItY29sb3I6cmdiYSgxMjQsMTUwLDI1NSwwLjUpO30KLmFpLXNlbmQtYnRue3dpZHRoOjM4cHg7aGVpZ2h0OjM4cHg7Ym9yZGVyLXJhZGl1czoxMHB4O2JvcmRlcjpub25l",
  "O2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpKTtjb2xvcjojZmZmO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjdXJzb3I6cG9pbnRlcjtmbGV4LXNo",
  "cmluazowO30KLmFpLXNlbmQtYnRuOmRpc2FibGVke29wYWNpdHk6MC41O2N1cnNvcjpkZWZhdWx0O30KLmFpLXNlbmQtYnRuIHN2Z3t3aWR0aDoxNXB4O2hlaWdodDoxNXB4O30KCi5leHBsYWluLWNhcmR7cGFkZGluZzoxOHB4IDIwcHg7bWFyZ2luLXRvcDoxNHB4",
  "O30KLmV4cGxhaW4taGVhZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo5cHg7bWFyZ2luLWJvdHRvbToxMHB4O30KLmV4cGxhaW4tdGV4dHtmb250LXNpemU6MTMuNXB4O2xpbmUtaGVpZ2h0OjEuNjU7Y29sb3I6dmFyKC0tdGV4dC1taWQpO3do",
  "aXRlLXNwYWNlOnByZS13cmFwO30KLmV4cGxhaW4tYnRuewogIGRpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo3cHg7cGFkZGluZzo4cHggMTRweDtib3JkZXItcmFkaXVzOjlweDsKICBiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVk",
  "LTIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpO2NvbG9yOnZhcigtLXRleHQtaGkpOwogIGZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246YWxsIC4xOHMgdmFyKC0tZWFzZS1vdXQpOwp9",
  "Ci5leHBsYWluLWJ0bjpob3Zlcntib3JkZXItY29sb3I6cmdiYSgxMjQsMTUwLDI1NSwwLjUpO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpO30KLmV4cGxhaW4tYnRuIHN2Z3t3aWR0aDoxNHB4O2hlaWdodDoxNHB4O30KLmV4cGxhaW4tYnRuOmRpc2FibGVke29w",
  "YWNpdHk6MC41O2N1cnNvcjpkZWZhdWx0O3RyYW5zZm9ybTpub25lO30KCkBtZWRpYSAobWF4LXdpZHRoOiA2NDBweCl7CiAgI2JhY2tlbmRCYWRnZXtkaXNwbGF5Om5vbmU7fQogIC5haS1wYW5lbHtyaWdodDoxMnB4O2xlZnQ6MTJweDt3aWR0aDphdXRvO2JvdHRv",
  "bTo4MHB4O30KICAuYWktZmFie3JpZ2h0OjE2cHg7Ym90dG9tOjc2cHg7fQp9CkBtZWRpYSAobWF4LXdpZHRoOiA3NjBweCl7CiAgbmF2Lm1haW5uYXZ7ZGlzcGxheTpub25lO30KICBoZWFkZXIudG9wYmFye3BhZGRpbmc6MCAxNnB4O2hlaWdodDo1OHB4O2dhcDox",
  "NHB4O30KICBtYWlue3BhZGRpbmc6MjBweCAxNnB4IDk2cHg7fQogIC5oZXJvLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZyKTtnYXA6MTBweDt9CiAgLm1ldHJpY3MtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZyKTt9",
  "CiAgLndhdGNobGlzdC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnI7fQogIC50cmVuZGluZy1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjt9CiAgLnRhYmxlLXdyYXB7ZGlzcGxheTpub25lO30KICAuc3RvY2stY2FyZHN7ZGlzcGxheTpmbGV4O30K",
  "ICAuYm90dG9tLW5hdntkaXNwbGF5OmZsZXg7fQogIC5kZXRhaWwtcHJpY2UtYmxvY2t7dGV4dC1hbGlnbjpsZWZ0O30KICAuZGV0YWlsLWhlYWR7ZmxleC1kaXJlY3Rpb246Y29sdW1uO30KICAuZmlsdGVycy1iYXJ7cGFkZGluZzoxMnB4O30KICAuZmlsdGVyLWNo",
  "aXB7bWluLXdpZHRoOjQ0JTtmbGV4OjE7fQp9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8ZGl2IGNsYXNzPSJhbWJpZW50Ij4KICA8ZGl2IGNsYXNzPSJhbWJpZW50LWdyaWQiPjwvZGl2PgogIDxzdmcgY2xhc3M9ImFtYmllbnQtbGluZXMiIGlkPSJhbWJpZW50",
  "TGluZXMiIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiPjwvc3ZnPgo8L2Rpdj4KCjxoZWFkZXIgY2xhc3M9InRvcGJhciIgaWQ9InRvcGJhciI+CiAgPGRpdiBjbGFzcz0iYnJhbmQiPgogICAgPGRpdiBjbGFzcz0iYnJhbmQtbWFyayI+CiAgICAgIDxzdmcgdmll",
  "d0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj4KICAgICAgICA8ZGVmcz4KICAgICAgICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibG9nb0dyYWQiIHgxPSIyIiB5MT0iMjAiIHgyPSIyMiIgeTI9IjQiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAg",
  "ICAgICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzRDN0RGRiIvPgogICAgICAgICAgICA8c3RvcCBvZmZzZXQ9IjU1JSIgc3RvcC1jb2xvcj0iIzhCNkJGMCIvPgogICAgICAgICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMz",
  "MUQ1RUUiLz4KICAgICAgICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICAgICAgPC9kZWZzPgogICAgICAgIDxyZWN0IHg9IjIuNSIgeT0iMTMiIHdpZHRoPSI0IiBoZWlnaHQ9IjguNSIgcng9IjEuMiIgZmlsbD0idXJsKCNsb2dvR3JhZCkiIG9wYWNpdHk9IjAuNTUi",
  "Lz4KICAgICAgICA8cmVjdCB4PSIxMCIgeT0iOCIgd2lkdGg9IjQiIGhlaWdodD0iMTMuNSIgcng9IjEuMiIgZmlsbD0idXJsKCNsb2dvR3JhZCkiIG9wYWNpdHk9IjAuOCIvPgogICAgICAgIDxyZWN0IHg9IjE3LjUiIHk9IjIuNSIgd2lkdGg9IjQiIGhlaWdodD0i",
  "MTkiIHJ4PSIxLjIiIGZpbGw9InVybCgjbG9nb0dyYWQpIi8+CiAgICAgIDwvc3ZnPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJicmFuZC13b3JkbWFyayI+PHNwYW4+PHNwYW4gY2xhc3M9ImVxIj5FcXVpdHk8L3NwYW4+PHNwYW4gY2xhc3M9InNjYW4iPlNj",
  "YW48L3NwYW4+PC9zcGFuPjxzbWFsbD5NQVJLRVQgSU5URUxMSUdFTkNFPC9zbWFsbD48L2Rpdj4KICA8L2Rpdj4KICA8bmF2IGNsYXNzPSJtYWlubmF2IiBpZD0ibWFpbk5hdiI+CiAgICA8YnV0dG9uIGRhdGEtdmlldz0iZGFzaGJvYXJkIj5EYXNoYm9hcmQ8L2J1",
  "dHRvbj4KICAgIDxidXR0b24gZGF0YS12aWV3PSJzY3JlZW5lciI+U2NyZWVuZXI8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS12aWV3PSJtYXJrZXRzIj5NYXJrZXRzPC9idXR0b24+CiAgICA8YnV0dG9uIGRhdGEtdmlldz0id2F0Y2hsaXN0Ij5XYXRjaGxpc3Q8",
  "L2J1dHRvbj4KICA8L25hdj4KICA8ZGl2IGNsYXNzPSJoZWFkZXItcmlnaHQiPgogICAgPGRpdiBjbGFzcz0ibWFya2V0LXBpbGwiPjxzcGFuIGNsYXNzPSJkb3QtbGl2ZSI+PC9zcGFuPjxzcGFuIGlkPSJtYXJrZXRTdGF0dXNUZXh0Ij5NYXJrZXQgT3Blbjwvc3Bh",
  "bj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9Im1hcmtldC1waWxsIiBpZD0iYmFja2VuZEJhZGdlIiB0aXRsZT0iQ2hlY2tpbmcgYmFja2VuZCBjb25uZWN0aW9u4oCmIj48c3BhbiBjbGFzcz0iZG90LWxpdmUiPjwvc3Bhbj48c3Bhbj5DaGVja2luZ+KApjwvc3Bhbj48",
  "L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiBpZD0ic2VhcmNoVG9nZ2xlQnRuIiB0aXRsZT0iU2VhcmNoICgvKSI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdp",
  "ZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEgMjFsLTQuMy00LjMiLz48L3N2Zz4KICAgIDwvYnV0dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4iIHRpdGxlPSJTZXR0",
  "aW5ncyI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEy",
  "IiBjeT0iMTIiIHI9IjMiLz48cGF0aCBkPSJNMTkuNCAxNWExLjY1IDEuNjUgMCAwMC4zMyAxLjgybC4wNi4wNmEyIDIgMCAxMS0yLjgzIDIuODNsLS4wNi0uMDZhMS42NSAxLjY1IDAgMDAtMS44Mi0uMzMgMS42NSAxLjY1IDAgMDAtMSAxLjUxVjIxYTIgMiAwIDAx",
  "LTQgMHYtLjA5QTEuNjUgMS42NSAwIDAwOSAxOS40YTEuNjUgMS42NSAwIDAwLTEuODIuMzNsLS4wNi4wNmEyIDIgMCAxMS0yLjgzLTIuODNsLjA2LS4wNkExLjY1IDEuNjUgMCAwMDQuNiAxNWExLjY1IDEuNjUgMCAwMC0xLjUxLTFIM2EyIDIgMCAwMTAtNGguMDlB",
  "MS42NSAxLjY1IDAgMDA0LjYgOWExLjY1IDEuNjUgMCAwMC0uMzMtMS44MmwtLjA2LS4wNmEyIDIgMCAxMTIuODMtMi44M2wuMDYuMDZBMS42NSAxLjY1IDAgMDA5IDQuNmExLjY1IDEuNjUgMCAwMDEtMS41MVYzYTIgMiAwIDAxNCAwdi4wOWExLjY1IDEuNjUgMCAw",
  "MDEgMS41MSAxLjY1IDEuNjUgMCAwMDEuODItLjMzbC4wNi0uMDZhMiAyIDAgMTEyLjgzIDIuODNsLS4wNi4wNkExLjY1IDEuNjUgMCAwMDE5LjQgOWExLjY1IDEuNjUgMCAwMDEuNTEgMUgyMWEyIDIgMCAwMTAgNGgtLjA5YTEuNjUgMS42NSAwIDAwLTEuNTEgMXoi",
  "Lz48L3N2Zz4KICAgIDwvYnV0dG9uPgogIDwvZGl2Pgo8L2hlYWRlcj4KCjxtYWluIGlkPSJtYWluUm9vdCI+PC9tYWluPgoKPG5hdiBjbGFzcz0iYm90dG9tLW5hdiIgaWQ9ImJvdHRvbU5hdiI+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9ImRhc2hib2FyZCI+PHN2ZyB2",
  "aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxyZWN0IHg9IjMiIHk9IjMiIHdpZHRoPSI3IiBoZWlnaHQ9IjkiIHJ4PSIxLjUiLz48cmVjdCB4PSIxNCIgeT0iMyIgd2lkdGg9IjciIGhl",
  "aWdodD0iNSIgcng9IjEuNSIvPjxyZWN0IHg9IjE0IiB5PSIxMiIgd2lkdGg9IjciIGhlaWdodD0iOSIgcng9IjEuNSIvPjxyZWN0IHg9IjMiIHk9IjE2IiB3aWR0aD0iNyIgaGVpZ2h0PSI1IiByeD0iMS41Ii8+PC9zdmc+RGFzaGJvYXJkPC9idXR0b24+CiAgPGJ1",
  "dHRvbiBkYXRhLXZpZXc9InNjcmVlbmVyIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTQgNmgxNk03IDEyaDEwTTEwIDE4aDQiLz48L3N2Zz5TY3JlZW5l",
  "cjwvYnV0dG9uPgogIDxidXR0b24gZGF0YS12aWV3PSJtYXJrZXRzIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTMgMTdsNi02IDQgNCA4LTgiLz48L3N2",
  "Zz5NYXJrZXRzPC9idXR0b24+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9IndhdGNobGlzdCI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2",
  "IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9zdmc+V2F0Y2hsaXN0PC9idXR0b24+CjwvbmF2PgoKPGJ1dHRvbiBjbGFzcz0iYWktZmFiIiBpZD0iYWlGYWIiIHRpdGxlPSJBc2sg",
  "dGhlIEVxdWl0eVNjYW4gQXNzaXN0YW50Ij4KICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5k",
  "Ij48cGF0aCBkPSJNMTIgOFY0SDgiLz48cmVjdCB4PSI0IiB5PSI4IiB3aWR0aD0iMTYiIGhlaWdodD0iMTIiIHJ4PSIyIi8+PHBhdGggZD0iTTIgMTRoMk0yMCAxNGgyTTkgMTN2Mk0xNSAxM3YyIi8+PC9zdmc+CjwvYnV0dG9uPgoKPGRpdiBjbGFzcz0iYWktcGFu",
  "ZWwiIGlkPSJhaVBhbmVsIj4KICA8ZGl2IGNsYXNzPSJhaS1wYW5lbC1oZWFkIj4KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjlweDsiPgogICAgICA8ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PgogICAg",
  "ICA8ZGl2PgogICAgICAgIDxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTMuNXB4OyI+RXF1aXR5U2NhbiBBc3Npc3RhbnQ8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6MTAuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pOyIg",
  "aWQ9ImFpU3RhdHVzTGluZSI+Q2hlY2tpbmfigKY8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiBpZD0iYWlDbG9zZUJ0biIgc3R5bGU9IndpZHRoOjMwcHg7aGVpZ2h0OjMwcHg7Ij4KICAgICAgPHN2ZyB2",
  "aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBhdGggZD0iTTE4IDZMNiAxOE02IDZsMTIgMTIiLz48L3N2Zz4KICAgIDwvYnV0dG9uPgogIDwv",
  "ZGl2PgogIDxkaXYgY2xhc3M9ImFpLW1lc3NhZ2VzIiBpZD0iYWlNZXNzYWdlcyI+CiAgICA8ZGl2IGNsYXNzPSJhaS1tc2cgYXNzaXN0YW50Ij5IaSDigJQgYXNrIG1lIGFib3V0IGEgc3RvY2sncyBudW1iZXJzLCB5b3VyIHdhdGNobGlzdCwgb3Igd2hhdCdzIGhh",
  "cHBlbmluZyBvbiB0aGUgZGFzaGJvYXJkIHJpZ2h0IG5vdy4gSSBvbmx5IGtub3cgd2hhdCdzIGxvYWRlZCBpbiB0aGUgYXBwLCBhbmQgSSB3b24ndCB0ZWxsIHlvdSB3aGF0IHRvIGJ1eSBvciBzZWxsLjwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImFpLWlu",
  "cHV0LXJvdyI+CiAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImFpSW5wdXQiIHBsYWNlaG9sZGVyPSJBc2sgYWJvdXQgdGhlIGRhdGHigKYiIGF1dG9jb21wbGV0ZT0ib2ZmIj4KICAgIDxidXR0b24gY2xhc3M9ImFpLXNlbmQtYnRuIiBpZD0iYWlTZW5kQnRuIiB0",
  "aXRsZT0iU2VuZCI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9",
  "Ik0yMiAyTDExIDEzTTIyIDJsLTcgMjAtNC05LTktNCAyMC03eiIvPjwvc3ZnPgogICAgPC9idXR0b24+CiAgPC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4KInVzZSBzdHJpY3QiOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PQogICBWSVNJQkxFIEVSUk9SIERJQUdOT1NUSUNTIOKAlCBzaG93cyB1bmNhdWdodCBlcnJvcnMgb24tc2NyZWVuIHNvIHRoZXkKICAgY2FuIGJlIHJlYWQvcmVwb3J0ZWQgd2l0aG91dCBvcGVuaW5nIGJyb3dzZXIgZGV2IHRvb2xz",
  "LiBTYWZlIHRvCiAgIGxlYXZlIGluOyBpdCBvbmx5IGFwcGVhcnMgd2hlbiBzb21ldGhpbmcgYWN0dWFsbHkgdGhyb3dzLgogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9u",
  "IHNob3dFcnJvckJhbm5lcihtc2cpewogIGxldCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXJyQmFubmVyIik7CiAgaWYoIWJhbm5lcil7CiAgICBiYW5uZXIgPSBkb2N1bWVudC5jcmVhdGVFbGVtZW50KCJkaXYiKTsKICAgIGJhbm5lci5pZCA9",
  "ICJlcnJCYW5uZXIiOwogICAgYmFubmVyLnN0eWxlLmNzc1RleHQgPSAicG9zaXRpb246Zml4ZWQ7bGVmdDoxMnB4O3JpZ2h0OjEycHg7Ym90dG9tOjEycHg7ei1pbmRleDo5OTk7YmFja2dyb3VuZDojMmEwZTE0O2JvcmRlcjoxcHggc29saWQgI0ZCNkI2Qjtjb2xv",
  "cjojRkZEOUQ5O3BhZGRpbmc6MTJweCAxNHB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNpemU6MTJweDtmb250LWZhbWlseTptb25vc3BhY2U7bWF4LWhlaWdodDozNXZoO292ZXJmbG93OmF1dG87Ym94LXNoYWRvdzowIDIwcHggNTBweCByZ2JhKDAsMCwwLDAu",
  "NSk7IjsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYmFubmVyKTsKICB9CiAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImRpdiIpOwogIGxpbmUuc3R5bGUubWFyZ2luQm90dG9tID0gIjZweCI7CiAgbGluZS50ZXh0Q29udGVudCA9",
  "IG5ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCkgKyAiIOKAlCAiICsgbXNnOwogIGJhbm5lci5hcHBlbmRDaGlsZChsaW5lKTsKfQp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigiZXJyb3IiLCAoZSk9PiBzaG93RXJyb3JCYW5uZXIoIkpTIGVycm9yOiAiICsg",
  "KGUubWVzc2FnZXx8ZSkpKTsKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInVuaGFuZGxlZHJlamVjdGlvbiIsIChlKT0+IHNob3dFcnJvckJhbm5lcigiVW5oYW5kbGVkIHByb21pc2UgcmVqZWN0aW9uOiAiICsgKGUucmVhc29uICYmIGUucmVhc29uLm1lc3NhZ2Ug",
  "fHwgZS5yZWFzb24pKSk7CgovLyBTYWZlIERPTSB0ZXh0IHNldHRlciDigJQgc2V2ZXJhbCB1cGRhdGVzIGhlcmUgY29tZSBmcm9tIGRlYm91bmNlZC9hc3luYwovLyBjYWxsYmFja3MgKHNlYXJjaCB0eXBpbmcsIGZpbHRlciBjaGFuZ2VzKSB0aGF0IGNhbiByZXNv",
  "bHZlIGFmdGVyIHRoZSB1c2VyCi8vIGhhcyBhbHJlYWR5IG5hdmlnYXRlZCB0byBhIGRpZmZlcmVudCB2aWV3LCBhdCB3aGljaCBwb2ludCB0aGUgdGFyZ2V0Ci8vIGVsZW1lbnQgbm8gbG9uZ2VyIGV4aXN0cy4gVGhpcyBqdXN0IG5vLW9wcyBpbnN0ZWFkIG9mIHRo",
  "cm93aW5nLgpmdW5jdGlvbiBzZXRUZXh0KGlkLCB0ZXh0KXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKICBpZihlbCkgZWwudGV4dENvbnRlbnQgPSB0ZXh0Owp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIElOVEVHUkFUSU9OIExBWUVSCiAgIFRoaXMgZnJvbnRlbmQgbm93IHRhbGtzIHRvIGEgcmVhbCBFcXVpdHlTY2FuIGJhY2tlbmQgKHNlZSAvYmFja2VuZCkKICAgd2hpY2ggcHJveGllcyBOU0UgdmlhIHN0",
  "b2NrLW5zZS1pbmRpYSwgY2FjaGVkIGFuZCBidWRnZXQtbGltaXRlZCB0bwogICB+NTAgdXBzdHJlYW0gY2FsbHMvZGF5LiBFdmVyeSBBUEkuKiBtZXRob2QgYmVsb3cgdHJpZXMgdGhlIGxpdmUKICAgYmFja2VuZCBmaXJzdCBhbmQgZmFsbHMgYmFjayB0byBkZXRl",
  "cm1pbmlzdGljIG1vY2sgZGF0YSBpZiB0aGUKICAgYmFja2VuZCBpcyB1bnJlYWNoYWJsZSDigJQgd2hpY2ggaXMgZXhwZWN0ZWQgd2hlbiB0aGlzIHBhZ2UgaXMgb3BlbmVkCiAgIGFzIGEgaG9zdGVkIHByZXZpZXcsIHNpbmNlIGEgcHVibGlzaGVkIHBhZ2UgY2Fu",
  "bm90IHJlYWNoIGEKICAgbG9jYWxob3N0IHNlcnZlci4gUnVuIHRoZSBiYWNrZW5kIGFuZCBvcGVuIHRoaXMgZmlsZSBsb2NhbGx5IChub3QKICAgdGhlIHB1Ymxpc2hlZCBwcmV2aWV3KSB0byBzZWUgcmVhbCBOU0UgcXVvdGVzIGVuZCB0byBlbmQuCiAgIFRoZSBi",
  "YWNrZW5kIGhhcyBubyBoaXN0b3JpY2FsLXByaWNlIGVuZHBvaW50IHlldCwgc28gY2hhcnQgc2VyaWVzCiAgIGFuZCBzcGFya2xpbmVzIHN0YXkgc3ludGhldGljIGV2ZW4gaW4gbGl2ZSBtb2RlIOKAlCBldmVyeXRoaW5nIGVsc2UKICAgKHByaWNlLCBjaGFuZ2Ug",
  "JSwgNTJXIGhpZ2gvbG93LCBjb21wYW55IG5hbWUsIG1hcmtldCBzdGF0dXMpIGlzCiAgIHJlYWwgd2hlbiB0aGUgYmFja2VuZCBpcyByZWFjaGFibGUuCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT0gKi8KY29uc3QgQ09ORklHID0gewogIEFQSV9CQVNFOiAod2luZG93LmxvY2F0aW9uLnByb3RvY29sID09PSAiZmlsZToiID8gImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMCIgOiB3aW5kb3cubG9jYXRpb24ub3JpZ2luKSArICIvYXBpIiwKICBMSVZFX1RJTUVP",
  "VVRfTVM6IDgwMDAsCiAgLy8gUmVuZGVyJ3MgZnJlZSB0aWVyIHNwaW5zIHRoZSBzZXJ2ZXIgZG93biBhZnRlciB+MTUgbWluIGlkbGUsIGFuZCB3YWtpbmcKICAvLyBpdCBiYWNrIHVwIGNhbiB0YWtlIDMwLTUwcy4gVGhlIGhlYWx0aCBjaGVjayBuZWVkcyBhIG11",
  "Y2ggbG9uZ2VyIGxlYXNoCiAgLy8gdGhhbiBhIG5vcm1hbCBkYXRhIHJlcXVlc3QsIG9yIGl0IHdyb25nbHkgY29uY2x1ZGVzICJiYWNrZW5kIGlzIGRvd24iCiAgLy8gZHVyaW5nIGV4YWN0bHkgdGhlIG1vbWVudCBpdCdzIGp1c3Qgc2xvd2x5IHN0YXJ0aW5nIHVw",
  "LgogIEhFQUxUSF9USU1FT1VUX01TOiA0NTAwMCwKfTsKbGV0IGxpdmVCYWNrZW5kQXZhaWxhYmxlID0gZmFsc2U7CmNvbnN0IE1PQ0tfTEFURU5DWSA9IDQyMDsKCmZ1bmN0aW9uIGZldGNoV2l0aFRpbWVvdXQodXJsLCBtcyl7CiAgY29uc3QgY3RybCA9IG5ldyBB",
  "Ym9ydENvbnRyb2xsZXIoKTsKICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCk9PmN0cmwuYWJvcnQoKSwgbXMpOwogIHJldHVybiBmZXRjaCh1cmwsIHtzaWduYWw6IGN0cmwuc2lnbmFsfSkuZmluYWxseSgoKT0+Y2xlYXJUaW1lb3V0KGlkKSk7Cn0KCmFzeW5jIGZ1",
  "bmN0aW9uIGNoZWNrTGl2ZUJhY2tlbmQoKXsKICB0cnl7CiAgICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChDT05GSUcuQVBJX0JBU0UgKyAiL2hlYWx0aCIsIENPTkZJRy5IRUFMVEhfVElNRU9VVF9NUyk7CiAgICBsaXZlQmFja2VuZEF2YWlsYWJs",
  "ZSA9ICEhKHIgJiYgci5vayk7CiAgfWNhdGNoKGUpewogICAgbGl2ZUJhY2tlbmRBdmFpbGFibGUgPSBmYWxzZTsKICB9CiAgdXBkYXRlQmFja2VuZEJhZGdlKCk7CiAgcmV0dXJuIGxpdmVCYWNrZW5kQXZhaWxhYmxlOwp9CgpmdW5jdGlvbiB1cGRhdGVCYWNrZW5k",
  "QmFkZ2UoKXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJiYWNrZW5kQmFkZ2UiKTsKICBpZighZWwpIHJldHVybjsKICBlbC5jbGFzc0xpc3QudG9nZ2xlKCJsaXZlIiwgbGl2ZUJhY2tlbmRBdmFpbGFibGUpOwogIGVsLnF1ZXJ5U2VsZWN0",
  "b3IoIi5kb3QtbGl2ZSIpLnN0eWxlLmJhY2tncm91bmQgPSBsaXZlQmFja2VuZEF2YWlsYWJsZSA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS10ZXh0LWZhaW50KSI7CiAgZWwucXVlcnlTZWxlY3Rvcigic3BhbjpsYXN0LWNoaWxkIikudGV4dENvbnRlbnQgPSBsaXZl",
  "QmFja2VuZEF2YWlsYWJsZSA/ICJMaXZlIE5TRSBEYXRhIiA6ICJEZW1vIERhdGEiOwogIGVsLnRpdGxlID0gbGl2ZUJhY2tlbmRBdmFpbGFibGUKICAgID8gIkNvbm5lY3RlZCB0byB0aGUgRXF1aXR5U2NhbiBiYWNrZW5kIOKAlCBwcmljZXMgYXJlIHJlYWwgTlNF",
  "IHF1b3Rlcy4iCiAgICA6ICJCYWNrZW5kIG5vdCByZWFjaGFibGUgYXQgIiArIENPTkZJRy5BUElfQkFTRSArICIg4oCUIHNob3dpbmcgZGV0ZXJtaW5pc3RpYyBkZW1vIGRhdGEuIjsKfQoKZnVuY3Rpb24gbWFwQmFja2VuZFRvRnJvbnRlbmQoZCl7CiAgY29uc3Qg",
  "c2VlZCA9IHRpY2tlclNlZWQoZC5zeW1ib2wpOwogIGNvbnN0IGJhc2lzID0gZC5jdXJyZW50UHJpY2UgfHwgMTAwMDsKICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjAsIDAuMDA1LCBiYXNpcyk7CiAgY29uc3Qga25vd25EZWYgPSBVTklWRVJTRS5m",
  "aW5kKHU9PnUudD09PWQuc3ltYm9sKTsKICByZXR1cm4gewogICAgdDogZC5zeW1ib2wsCiAgICBuYW1lOiBkLmNvbXBhbnlOYW1lIHx8IChrbm93bkRlZiAmJiBrbm93bkRlZi5uYW1lKSB8fCBkLnN5bWJvbCwKICAgIGV4Y2g6IGQuZXhjaGFuZ2UgfHwgIk5TRSIs",
  "CiAgICAvLyBUaGUgbGl2ZSBiYWNrZW5kJ3MgaW5kdXN0cnkgbGFiZWwgZG9lc24ndCByZWxpYWJseSBtYXRjaCBvdXIgZmlsdGVyCiAgICAvLyBkcm9wZG93bidzIHZvY2FidWxhcnkgKG9yIG1heSBiZSBtaXNzaW5nKSwgc28gcHJlZmVyIG91ciBrbm93biBtYXBw",
  "aW5nCiAgICAvLyBmb3IgZmlsdGVyaW5nIHB1cnBvc2VzIGFuZCBvbmx5IGZhbGwgYmFjayB0byB0aGUgYmFja2VuZCdzIHJhdyB2YWx1ZS4KICAgIHNlY3RvcjogKGtub3duRGVmICYmIGtub3duRGVmLnNlY3RvcikgfHwgZC5zZWN0b3IgfHwgIuKAlCIsCiAgICBw",
  "cmljZTogZC5jdXJyZW50UHJpY2UsCiAgICBjaGFuZ2U6IGQuY2hhbmdlLAogICAgcGN0OiBkLnBlcmNlbnRDaGFuZ2UsCiAgICBtYXJrZXRDYXA6IGQubWFya2V0Q2FwLAogICAgdm9sdW1lOiBkLnZvbHVtZSwKICAgIGhpZ2g1MjogZC53ZWVrNTJIaWdoLAogICAg",
  "bG93NTI6IGQud2VlazUyTG93LAogICAgb3BlbjogZC5vcGVuLAogICAgZGF5SGlnaDogZC5kYXlIaWdoLAogICAgZGF5TG93OiBkLmRheUxvdywKICAgIHNlcmllcywKICAgIGxpdmU6IHRydWUsCiAgICBkYXRhU3RhdHVzOiBkLmRhdGFTdGF0dXMsCiAgfTsKfQoK",
  "YXN5bmMgZnVuY3Rpb24gbGl2ZUZldGNoU3RvY2sodGlja2VyKXsKICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChgJHtDT05GSUcuQVBJX0JBU0V9L3N0b2NrLyR7ZW5jb2RlVVJJQ29tcG9uZW50KHRpY2tlcil9YCwgQ09ORklHLkxJVkVfVElNRU9V",
  "VF9NUyk7CiAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcigiYmFja2VuZCBzdGF0dXMgIityLnN0YXR1cyk7CiAgY29uc3QganNvbiA9IGF3YWl0IHIuanNvbigpOwogIGlmKCFqc29uLnN1Y2Nlc3MgfHwgIWpzb24uZGF0YSkgdGhyb3cgbmV3IEVycm9yKCJiYWNr",
  "ZW5kIHBheWxvYWQgZXJyb3IiKTsKICByZXR1cm4gbWFwQmFja2VuZFRvRnJvbnRlbmQoanNvbi5kYXRhKTsKfQoKYXN5bmMgZnVuY3Rpb24gbGl2ZUZldGNoTWFueSh0aWNrZXJzKXsKICBjb25zdCBzZXR0bGVkID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRp",
  "Y2tlcnMubWFwKGxpdmVGZXRjaFN0b2NrKSk7CiAgcmV0dXJuIHNldHRsZWQuZmlsdGVyKHM9PnMuc3RhdHVzPT09ImZ1bGZpbGxlZCIpLm1hcChzPT5zLnZhbHVlKTsKfQoKY29uc3QgVU5JVkVSU0UgPSBbCiAge3Q6IlRDUyIsIG5hbWU6IlRhdGEgQ29uc3VsdGFu",
  "Y3kgU2VydmljZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IklUIFNlcnZpY2VzIiwgYmFzZTozODQyfSwKICB7dDoiUkVMSUFOQ0UiLCBuYW1lOiJSZWxpYW5jZSBJbmR1c3RyaWVzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJFbmVyZ3kiLCBiYXNlOjI5NTF9LAogIHt0",
  "OiJIREZDQkFOSyIsIG5hbWU6IkhERkMgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTY4N30sCiAge3Q6IklORlkiLCBuYW1lOiJJbmZvc3lzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6MTg0MX0sCiAg",
  "e3Q6IklDSUNJQkFOSyIsIG5hbWU6IklDSUNJIEJhbmsiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjEyNjR9LAogIHt0OiJCSEFSVElBUlRMIiwgbmFtZToiQmhhcnRpIEFpcnRlbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiVGVsZWNvbSIsIGJh",
  "c2U6MTY5OH0sCiAge3Q6IlNCSU4iLCBuYW1lOiJTdGF0ZSBCYW5rIG9mIEluZGlhIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZTo4MjR9LAogIHt0OiJJVEMiLCBuYW1lOiJJVEMgTGltaXRlZCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRk1DRyIs",
  "IGJhc2U6NDc4fSwKICB7dDoiTFQiLCBuYW1lOiJMYXJzZW4gJiBUb3Vicm8iLCBleGNoOiJOU0UiLCBzZWN0b3I6IkluZnJhc3RydWN0dXJlIiwgYmFzZTozNjEyfSwKICB7dDoiS09UQUtCQU5LIiwgbmFtZToiS290YWsgTWFoaW5kcmEgQmFuayIsIGV4Y2g6Ik5T",
  "RSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTc4OX0sCiAge3Q6IkhJTkRVTklMVlIiLCBuYW1lOiJIaW5kdXN0YW4gVW5pbGV2ZXIiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ciLCBiYXNlOjI1NDd9LAogIHt0OiJBWElTQkFOSyIsIG5hbWU6IkF4aXMgQmFu",
  "ayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTE0Mn0sCiAge3Q6IkJBSkZJTkFOQ0UiLCBuYW1lOiJCYWphaiBGaW5hbmNlIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGaW5hbmNpYWwgU2VydmljZXMiLCBiYXNlOjcyODR9LAogIHt0OiJNQVJV",
  "VEkiLCBuYW1lOiJNYXJ1dGkgU3V6dWtpIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJBdXRvbW9iaWxlIiwgYmFzZToxMjQ4MH0sCiAge3Q6IkFTSUFOUEFJTlQiLCBuYW1lOiJBc2lhbiBQYWludHMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkNvbnN1bWVyIEdvb2RzIiwg",
  "YmFzZToyODk0fSwKICB7dDoiV0lQUk8iLCBuYW1lOiJXaXBybyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjUxMn0sCiAge3Q6IlRJVEFOIiwgbmFtZToiVGl0YW4gQ29tcGFueSIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQ29uc3VtZXIg",
  "R29vZHMiLCBiYXNlOjM0MjF9LAogIHt0OiJTVU5QSEFSTUEiLCBuYW1lOiJTdW4gUGhhcm1hY2V1dGljYWwiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBoYXJtYSIsIGJhc2U6MTc4Nn0sCiAge3Q6Ik5UUEMiLCBuYW1lOiJOVFBDIExpbWl0ZWQiLCBleGNoOiJOU0Ui",
  "LCBzZWN0b3I6IlBvd2VyIiwgYmFzZTozNjJ9LAogIHt0OiJBREFOSUVOVCIsIG5hbWU6IkFkYW5pIEVudGVycHJpc2VzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJEaXZlcnNpZmllZCIsIGJhc2U6MjkxNH0sCiAge3Q6IlVMVFJBQ0VNQ08iLCBuYW1lOiJVbHRyYVRl",
  "Y2ggQ2VtZW50IiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJDZW1lbnQiLCBiYXNlOjExMjQwfSwKICB7dDoiUE9XRVJHUklEIiwgbmFtZToiUG93ZXIgR3JpZCBDb3JwIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJQb3dlciIsIGJhc2U6MzE4fSwKICB7dDoiTkVTVExFSU5E",
  "IiwgbmFtZToiTmVzdGxlIEluZGlhIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGTUNHIiwgYmFzZToyMjc4fSwKICB7dDoiVEFUQU1PVE9SUyIsIG5hbWU6IlRhdGEgTW90b3JzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJBdXRvbW9iaWxlIiwgYmFzZTo5NDh9LAogIHt0",
  "OiJKU1dTVEVFTCIsIG5hbWU6IkpTVyBTdGVlbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiTWV0YWxzIiwgYmFzZToxMDEyfSwKXTsKCmZ1bmN0aW9uIHNlZWRlZFJhbmQoc2VlZCl7CiAgbGV0IHggPSBNYXRoLnNpbihzZWVkKSAqIDEwMDAwOwogIHJldHVybiB4IC0g",
  "TWF0aC5mbG9vcih4KTsKfQpmdW5jdGlvbiBkYXlPZlllYXIoKXsKICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpOwogIHJldHVybiBNYXRoLmZsb29yKChub3cgLSBuZXcgRGF0ZShub3cuZ2V0RnVsbFllYXIoKSwwLDApKSAvIDg2NDAwMDAwKTsKfQpmdW5jdGlvbiBn",
  "ZW5TZXJpZXMoc2VlZCwgcG9pbnRzLCB2b2xhdGlsaXR5LCBiYXNlKXsKICBjb25zdCBhcnIgPSBbXTsKICBsZXQgdiA9IGJhc2U7CiAgZm9yKGxldCBpPTA7aTxwb2ludHM7aSsrKXsKICAgIGNvbnN0IHIgPSBzZWVkZWRSYW5kKHNlZWQgKiA5Ny43ICsgaSAqIDEz",
  "LjMxKSAtIDAuNTsKICAgIHYgPSB2ICogKDEgKyByICogdm9sYXRpbGl0eSk7CiAgICBhcnIucHVzaCh2KTsKICB9CiAgcmV0dXJuIGFycjsKfQpmdW5jdGlvbiB0aWNrZXJTZWVkKHRpY2tlcil7CiAgbGV0IGggPSAwOwogIGZvcihsZXQgaT0wO2k8dGlja2VyLmxl",
  "bmd0aDtpKyspIGggPSAoaCozMSArIHRpY2tlci5jaGFyQ29kZUF0KGkpKSAlIDEwMDAwMDsKICByZXR1cm4gaCArIGRheU9mWWVhcigpOwp9CgpmdW5jdGlvbiB3aXRoTGF0ZW5jeSh2YWx1ZSl7CiAgcmV0dXJuIG5ldyBQcm9taXNlKHJlcyA9PiBzZXRUaW1lb3V0",
  "KCgpID0+IHJlcyh2YWx1ZSksIE1PQ0tfTEFURU5DWSkpOwp9Cgpjb25zdCBBUEkgPSB7CiAgYXN5bmMgZmV0Y2hJbmRpY2VzKCl7CiAgICBjb25zdCBkZWZzID0gWwogICAgICB7Y29kZToiTklGVFkgNTAiLCBmdWxsOiJOU0UgTmlmdHkgNTAgSW5kZXgiLCBiYXNl",
  "OjI0ODEyfSwKICAgICAge2NvZGU6IlNFTlNFWCIsIGZ1bGw6IkJTRSBTZW5zZXgiLCBiYXNlOjgxNjQwfSwKICAgICAge2NvZGU6Ik5JRlRZIEJBTksiLCBmdWxsOiJOU0UgQmFuayBOaWZ0eSBJbmRleCIsIGJhc2U6NTIxNDB9LAogICAgXTsKICAgIGNvbnN0IG91",
  "dCA9IGRlZnMubWFwKGQ9PnsKICAgICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoZC5jb2RlKTsKICAgICAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNlZWQsIDI0LCAwLjAwNiwgZC5iYXNlKTsKICAgICAgY29uc3QgbGFzdCA9IHNlcmllc1tzZXJpZXMubGVu",
  "Z3RoLTFdOwogICAgICBjb25zdCBwcmV2ID0gZC5iYXNlOwogICAgICBjb25zdCBjaGcgPSBsYXN0IC0gcHJldjsKICAgICAgY29uc3QgcGN0ID0gKGNoZy9wcmV2KSoxMDA7CiAgICAgIHJldHVybiB7Li4uZCwgdmFsdWU6bGFzdCwgY2hhbmdlOmNoZywgcGN0LCBz",
  "ZXJpZXN9OwogICAgfSk7CiAgICByZXR1cm4gd2l0aExhdGVuY3kob3V0KTsKICB9LAoKICBhc3luYyBzZWFyY2hTdG9ja3MocXVlcnkpewogICAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0oKS50b0xvd2VyQ2FzZSgpOwogICAgaWYoIXEpIHJldHVybiB3aXRoTGF0ZW5j",
  "eShbXSk7CiAgICBjb25zdCBtYXRjaGVzID0gVU5JVkVSU0UuZmlsdGVyKHMgPT4gcy50LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkgfHwgcy5uYW1lLnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkpLnNsaWNlKDAsOCk7CiAgICBpZihsaXZlQmFja2VuZEF2YWls",
  "YWJsZSl7CiAgICAgIGNvbnN0IGxpdmUgPSBhd2FpdCBsaXZlRmV0Y2hNYW55KG1hdGNoZXMubWFwKG09Pm0udCkpOwogICAgICBpZihsaXZlLmxlbmd0aCkgcmV0dXJuIGxpdmU7CiAgICB9CiAgICByZXR1cm4gd2l0aExhdGVuY3kobWF0Y2hlcy5tYXAocyA9PiBk",
  "ZWNvcmF0ZVN0b2NrKHMpKSk7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTY3JlZW5lclJlc3VsdHMoZmlsdGVycyl7CiAgICBsZXQgbGlzdDsKICAgIGlmKGxpdmVCYWNrZW5kQXZhaWxhYmxlKXsKICAgICAgY29uc3QgbGl2ZSA9IGF3YWl0IGxpdmVGZXRjaE1hbnkoVU5J",
  "VkVSU0UubWFwKHM9PnMudCkpOwogICAgICBsaXN0ID0gbGl2ZS5sZW5ndGggPyBsaXZlIDogVU5JVkVSU0UubWFwKHM9PmRlY29yYXRlU3RvY2socykpOwogICAgfSBlbHNlIHsKICAgICAgbGlzdCA9IFVOSVZFUlNFLm1hcChkZWNvcmF0ZVN0b2NrKTsKICAgICAg",
  "YXdhaXQgd2l0aExhdGVuY3kobnVsbCk7CiAgICB9CiAgICBpZihmaWx0ZXJzLnF1ZXJ5KXsKICAgICAgY29uc3QgcSA9IGZpbHRlcnMucXVlcnkudG9Mb3dlckNhc2UoKTsKICAgICAgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMudC50b0xvd2VyQ2FzZSgpLmluY2x1",
  "ZGVzKHEpfHxzLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSk7CiAgICB9CiAgICBpZihmaWx0ZXJzLnNlY3RvciAmJiBmaWx0ZXJzLnNlY3RvciAhPT0gIkFsbCIpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnNlY3Rvcj09PWZpbHRlcnMuc2VjdG9yKTsK",
  "ICAgIGlmKGZpbHRlcnMubWluUHJpY2UpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnByaWNlPj1maWx0ZXJzLm1pblByaWNlKTsKICAgIGlmKGZpbHRlcnMubWF4UHJpY2UpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnByaWNlPD1maWx0ZXJzLm1heFByaWNlKTsK",
  "ICAgIGlmKGZpbHRlcnMuZGlyZWN0aW9uPT09ImdhaW5lcnMiKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q+PTApOwogICAgaWYoZmlsdGVycy5kaXJlY3Rpb249PT0ibG9zZXJzIikgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucGN0PDApOwogICAgcmV0dXJu",
  "IGxpc3Q7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTdG9jayh0aWNrZXIpewogICAgaWYobGl2ZUJhY2tlbmRBdmFpbGFibGUpewogICAgICB0cnl7IHJldHVybiBhd2FpdCBsaXZlRmV0Y2hTdG9jayh0aWNrZXIpOyB9CiAgICAgIGNhdGNoKGUpeyAvKiBmYWxsIHRocm91",
  "Z2ggdG8gbW9jayAqLyB9CiAgICB9CiAgICBjb25zdCBkZWYgPSBVTklWRVJTRS5maW5kKHM9PnMudD09PXRpY2tlcik7CiAgICBpZighZGVmKSByZXR1cm4gd2l0aExhdGVuY3kobnVsbCk7CiAgICByZXR1cm4gd2l0aExhdGVuY3koZGVjb3JhdGVTdG9jayhkZWYs",
  "IHRydWUpKTsKICB9LAoKICBhc3luYyBmZXRjaFN0b2NrSGlzdG9yeSh0aWNrZXIsIHJhbmdlKXsKICAgIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKHRpY2tlcik7CiAgICBjb25zdCBjZmcgPSB7CiAgICAgICIxRCI6e3BvaW50czo3OCwgdm9sOjAuMDAxNn0sCiAg",
  "ICAgICIxVyI6e3BvaW50czozNSwgdm9sOjAuMDAzfSwKICAgICAgIjFNIjp7cG9pbnRzOjIyLCB2b2w6MC4wMDh9LAogICAgICAiM00iOntwb2ludHM6NjUsIHZvbDowLjAwOX0sCiAgICAgICI2TSI6e3BvaW50czoxMzAsIHZvbDowLjAxMH0sCiAgICAgICIxWSI6",
  "e3BvaW50czoyNTAsIHZvbDowLjAxMn0sCiAgICB9W3JhbmdlXSB8fCB7cG9pbnRzOjYwLCB2b2w6MC4wMDh9OwogICAgY29uc3QgZGVmID0gVU5JVkVSU0UuZmluZChzPT5zLnQ9PT10aWNrZXIpOwogICAgY29uc3QgYmFzZSA9IGRlZiA/IGRlZi5iYXNlICogMC45",
  "NCA6IDEwMDA7CiAgICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCArIHJhbmdlLmxlbmd0aCwgY2ZnLnBvaW50cywgY2ZnLnZvbCwgYmFzZSk7CiAgICByZXR1cm4gd2l0aExhdGVuY3koc2VyaWVzKTsKICB9LAp9OwoKZnVuY3Rpb24gZGVjb3JhdGVTdG9j",
  "ayhkZWYsIGRldGFpbGVkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkZWYudCk7CiAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNlZWQsIDIwLCAwLjAwNSwgZGVmLmJhc2UpOwogIGNvbnN0IHByaWNlID0gc2VyaWVzW3Nlcmllcy5sZW5ndGgtMV07CiAg",
  "Y29uc3QgcHJldkNsb3NlID0gZGVmLmJhc2U7CiAgY29uc3QgY2hhbmdlID0gcHJpY2UgLSBwcmV2Q2xvc2U7CiAgY29uc3QgcGN0ID0gKGNoYW5nZS9wcmV2Q2xvc2UpKjEwMDsKICBjb25zdCBtYXJrZXRDYXAgPSBwcmljZSAqIChzZWVkZWRSYW5kKHNlZWQqMi4x",
  "KSo0MDAwKzgwMCkgKiAxZTY7CiAgY29uc3Qgdm9sdW1lID0gTWF0aC5yb3VuZChzZWVkZWRSYW5kKHNlZWQqMy4zKSo4XzAwMF8wMDAgKyAyMDBfMDAwKTsKICBjb25zdCBoaWdoNTIgPSBwcmljZSAqICgxICsgc2VlZGVkUmFuZChzZWVkKjQuNCkqMC4zNSArIDAu",
  "MDUpOwogIGNvbnN0IGxvdzUyID0gcHJpY2UgKiAoMSAtIHNlZWRlZFJhbmQoc2VlZCo1LjUpKjAuMzAgLSAwLjA0KTsKICBjb25zdCBvdXQgPSB7CiAgICB0OmRlZi50LCBuYW1lOmRlZi5uYW1lLCBleGNoOmRlZi5leGNoLCBzZWN0b3I6ZGVmLnNlY3RvciwKICAg",
  "IHByaWNlLCBjaGFuZ2UsIHBjdCwgbWFya2V0Q2FwLCB2b2x1bWUsIGhpZ2g1MiwgbG93NTIsIHNlcmllcywKICB9OwogIGlmKGRldGFpbGVkKXsKICAgIG91dC5vcGVuID0gcHJpY2UgLSBjaGFuZ2UqMC42OwogICAgb3V0LmRheUhpZ2ggPSBNYXRoLm1heChwcmlj",
  "ZSwgb3V0Lm9wZW4pICogKDErc2VlZGVkUmFuZChzZWVkKjYuNikqMC4wMTIpOwogICAgb3V0LmRheUxvdyA9IE1hdGgubWluKHByaWNlLCBvdXQub3BlbikgKiAoMS1zZWVkZWRSYW5kKHNlZWQqNy43KSowLjAxMik7CiAgfQogIHJldHVybiBvdXQ7Cn0KCi8qID09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgRk9STUFUIEhFTFBFUlMKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAq",
  "LwpmdW5jdGlvbiBmbXRJTlIodiwgZGVjaW1hbHMpewogIGlmKHY9PT11bmRlZmluZWR8fHY9PT1udWxsfHxpc05hTih2KSkgcmV0dXJuICLigJQiOwogIGNvbnN0IGQgPSBkZWNpbWFscz09PXVuZGVmaW5lZD8yOmRlY2ltYWxzOwogIHJldHVybiAi4oK5IiArIHYu",
  "dG9Mb2NhbGVTdHJpbmcoImVuLUlOIiwge21pbmltdW1GcmFjdGlvbkRpZ2l0czpkLCBtYXhpbXVtRnJhY3Rpb25EaWdpdHM6ZH0pOwp9CmZ1bmN0aW9uIGZtdENvbXBhY3Qodil7CiAgaWYodj09PXVuZGVmaW5lZHx8dj09PW51bGx8fGlzTmFOKHYpKSByZXR1cm4g",
  "IuKAlCI7CiAgaWYodj49MWUxMikgcmV0dXJuICLigrkiKyh2LzFlMTIpLnRvRml4ZWQoMikrIlQiOwogIGlmKHY+PTFlOSkgcmV0dXJuICLigrkiKyh2LzFlOSkudG9GaXhlZCgyKSsiQiI7CiAgaWYodj49MWU3KSByZXR1cm4gIuKCuSIrKHYvMWU3KS50b0ZpeGVk",
  "KDIpKyJDciI7CiAgaWYodj49MWU1KSByZXR1cm4gIuKCuSIrKHYvMWU1KS50b0ZpeGVkKDIpKyJMIjsKICByZXR1cm4gIuKCuSIrdi50b0ZpeGVkKDApOwp9CmZ1bmN0aW9uIGZtdFZvbCh2KXsKICBpZih2Pj0xZTcpIHJldHVybiAodi8xZTcpLnRvRml4ZWQoMikr",
  "IkNyIjsKICBpZih2Pj0xZTUpIHJldHVybiAodi8xZTUpLnRvRml4ZWQoMikrIkwiOwogIGlmKHY+PTFlMykgcmV0dXJuICh2LzFlMykudG9GaXhlZCgxKSsiSyI7CiAgcmV0dXJuIFN0cmluZyh2KTsKfQpmdW5jdGlvbiBwY3RTdHIocCl7IHJldHVybiAocD49MD8i",
  "KyI6IiIpICsgcC50b0ZpeGVkKDIpICsgIiUiOyB9CmZ1bmN0aW9uIGNoZ1N0cihjKXsgcmV0dXJuIChjPj0wPyIrIjoiIikgKyBmbXRJTlIoTWF0aC5hYnMoYykpOyB9CmZ1bmN0aW9uIGVzY2FwZUh0bWwocyl7CiAgcmV0dXJuIFN0cmluZyhzKS5yZXBsYWNlKC9b",
  "Jjw+IiddL2csIG0gPT4gKHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsiLCInIjoiJiMzOTsifVttXSkpOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09CiAgIFNUQVRFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3Qgc3RhdGUgPSB7CiAgdmlldzogImRhc2hib2FyZCIsCiAgd2F0Y2hsaXN0OiBbXSwKICBkZXRhaWxUaWNr",
  "ZXI6ICJUQ1MiLAogIGRldGFpbFJhbmdlOiAiMU0iLAogIHNjcmVlbmVyRmlsdGVyczoge3F1ZXJ5OiIiLCBzZWN0b3I6IkFsbCIsIG1pblByaWNlOjAsIG1heFByaWNlOjE1MDAwLCBkaXJlY3Rpb246ImFsbCJ9LAogIHNjcmVlbmVyU29ydDoge2tleToibWFya2V0",
  "Q2FwIiwgZGlyOiJkZXNjIn0sCn07Cgp0cnl7CiAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgiZXF1aXR5c2Nhbl93YXRjaGxpc3QiKTsKICBpZihzYXZlZCkgc3RhdGUud2F0Y2hsaXN0ID0gSlNPTi5wYXJzZShzYXZlZCk7Cn1jYXRjaChlKXt9",
  "CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGxpc3QoKXsKICB0cnl7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCJlcXVpdHlzY2FuX3dhdGNobGlzdCIsIEpTT04uc3RyaW5naWZ5KHN0YXRlLndhdGNobGlzdCkpOyB9Y2F0Y2goZSl7fQp9CgovKiA9PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNQQVJLTElORSAoaW5saW5lIFNWRykKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5j",
  "dGlvbiBzcGFya2xpbmVTVkcoc2VyaWVzLCBwb3NpdGl2ZSwgdywgaCl7CiAgdyA9IHd8fDEyMDsgaCA9IGh8fDM2OwogIGlmKCFzZXJpZXMgfHwgc2VyaWVzLmxlbmd0aDwyKSByZXR1cm4gIiI7CiAgY29uc3QgbWluID0gTWF0aC5taW4oLi4uc2VyaWVzKSwgbWF4",
  "ID0gTWF0aC5tYXgoLi4uc2VyaWVzKTsKICBjb25zdCByYW5nZSA9IChtYXgtbWluKXx8MTsKICBjb25zdCBzdGVwID0gdy8oc2VyaWVzLmxlbmd0aC0xKTsKICBjb25zdCBwdHMgPSBzZXJpZXMubWFwKCh2LGkpPT5baSpzdGVwLCBoIC0gKCh2LW1pbikvcmFuZ2Up",
  "KmgqMC44NiAtIGgqMC4wN10pOwogIGNvbnN0IHBhdGggPSBwdHMubWFwKChwLGkpPT4oaT09PTA/Ik0iOiJMIikrcFswXS50b0ZpeGVkKDEpKyIsIitwWzFdLnRvRml4ZWQoMSkpLmpvaW4oIiAiKTsKICBjb25zdCBhcmVhUGF0aCA9IHBhdGggKyBgIEwke3d9LCR7",
  "aH0gTDAsJHtofSBaYDsKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8gInZhcigtLXBvcykiIDogInZhcigtLW5lZykiOwogIGNvbnN0IGdpZCA9ICJzZyIrTWF0aC5yYW5kb20oKS50b1N0cmluZygzNikuc2xpY2UoMiw5KTsKICByZXR1cm4gYDxzdmcgdmlld0Jv",
  "eD0iMCAwICR7d30gJHtofSIgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+CiAgICA8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9IiR7Z2lkfSIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPgogICAgICA8c3Rv",
  "cCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIke2NvbG9yfSIgc3RvcC1vcGFjaXR5PSIwLjM1Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iJHtjb2xvcn0iIHN0b3Atb3BhY2l0eT0iMCIvPgogICAgPC9saW5lYXJHcmFkaWVudD48L2Rl",
  "ZnM+CiAgICA8cGF0aCBkPSIke2FyZWFQYXRofSIgZmlsbD0idXJsKCMke2dpZH0pIiBzdHJva2U9Im5vbmUiLz4KICAgIDxwYXRoIGQ9IiR7cGF0aH0iIGZpbGw9Im5vbmUiIHN0cm9rZT0iJHtjb2xvcn0iIHN0cm9rZS13aWR0aD0iMS42IiBzdHJva2UtbGluZWNh",
  "cD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICA8L3N2Zz5gOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEFNQklFTlQgREVDT1JBVElWRSBMSU5FUyAoZHJh",
  "d24gb25jZSkKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwooZnVuY3Rpb24gZHJhd0FtYmllbnRMaW5lcygpewogIGNvbnN0IHN2ZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJh",
  "bWJpZW50TGluZXMiKTsKICBjb25zdCB3ID0gMTQwMCwgaCA9IDgwMDsKICBzdmcuc2V0QXR0cmlidXRlKCJ2aWV3Qm94IiwgYDAgMCAke3d9ICR7aH1gKTsKICBsZXQgaHRtbCA9ICIiOwogIGZvcihsZXQgaT0wO2k8MztpKyspewogICAgY29uc3Qgc2VlZCA9IGkq",
  "MTcrMzsKICAgIGNvbnN0IHB0cyA9IFtdOwogICAgY29uc3QgbiA9IDEyOwogICAgZm9yKGxldCBqPTA7ajw9bjtqKyspewogICAgICBjb25zdCB4ID0gKGovbikqdzsKICAgICAgY29uc3QgeSA9IGgqMC4yNSArIGkqMTMwICsgKHNlZWRlZFJhbmQoc2VlZCtqKS0w",
  "LjUpKjkwOwogICAgICBwdHMucHVzaChbeCx5XSk7CiAgICB9CiAgICBjb25zdCBwYXRoID0gcHRzLm1hcCgocCxpZHgpPT4oaWR4PT09MD8iTSI6IkwiKStwWzBdLnRvRml4ZWQoMCkrIiwiK3BbMV0udG9GaXhlZCgwKSkuam9pbigiICIpOwogICAgY29uc3QgY29s",
  "b3JzID0gWyIjNEM3REZGIiwiIzhCNkJGMCIsIiMzMUQ1RUUiXTsKICAgIGh0bWwgKz0gYDxwYXRoIGQ9IiR7cGF0aH0iIGZpbGw9Im5vbmUiIHN0cm9rZT0iJHtjb2xvcnNbaSUzXX0iIHN0cm9rZS13aWR0aD0iMSIgb3BhY2l0eT0iMC4xMCIvPmA7CiAgfQogIHN2",
  "Zy5pbm5lckhUTUwgPSBodG1sOwp9KSgpOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBIRUFERVIgQkVIQVZJT1IKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCB0b3BiYXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidG9wYmFyIik7CndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJzY3JvbGwiLCAoKT0+ewogIHRvcGJhci5jbGFzc0xpc3QudG9nZ2xl",
  "KCJzY3JvbGxlZCIsIHdpbmRvdy5zY3JvbGxZID4gOCk7Cn0pOwoKZnVuY3Rpb24gc2V0QWN0aXZlTmF2KHZpZXcpewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIiNtYWluTmF2IGJ1dHRvbiwgI2JvdHRvbU5hdiBidXR0b24iKS5mb3JFYWNoKGI9PnsKICAg",
  "IGIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYi5kYXRhc2V0LnZpZXc9PT12aWV3KTsKICB9KTsKfQpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFpbk5hdiIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgZT0+ewogIGNvbnN0IGJ0biA9IGUudGFyZ2V0",
  "LmNsb3Nlc3QoImJ1dHRvbltkYXRhLXZpZXddIik7CiAgaWYoYnRuKSBuYXZpZ2F0ZShidG4uZGF0YXNldC52aWV3KTsKfSk7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJib3R0b21OYXYiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGU9PnsKICBjb25zdCBi",
  "dG4gPSBlLnRhcmdldC5jbG9zZXN0KCJidXR0b25bZGF0YS12aWV3XSIpOwogIGlmKGJ0bikgbmF2aWdhdGUoYnRuLmRhdGFzZXQudmlldyk7Cn0pOwoKZnVuY3Rpb24gbmF2aWdhdGUodmlldywgdGlja2VyKXsKICBzdGF0ZS52aWV3ID0gdmlldzsKICBpZih0aWNr",
  "ZXIpIHN0YXRlLmRldGFpbFRpY2tlciA9IHRpY2tlcjsKICBzZXRBY3RpdmVOYXYodmlldyA9PT0gImRldGFpbCIgPyAibWFya2V0cyIgOiB2aWV3KTsKICB3aW5kb3cuc2Nyb2xsVG8oe3RvcDowLCBiZWhhdmlvcjogd2luZG93Lm1hdGNoTWVkaWEoJyhwcmVmZXJz",
  "LXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpJykubWF0Y2hlcyA/ICJhdXRvIiA6ICJzbW9vdGgifSk7CiAgcmVuZGVyKCk7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgTUFSS0VU",
  "IFNUQVRVUyAoSVNUIGJ1c2luZXNzIGhvdXJzLCBwdXJlbHkgcHJlc2VudGF0aW9uYWwpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KKGZ1bmN0aW9uIG1hcmtldFN0YXR1cygpewog",
  "IGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7CiAgY29uc3QgaXN0SG91ciA9IChub3cuZ2V0VVRDSG91cnMoKSs1KSUyNCArIChub3cuZ2V0VVRDTWludXRlcygpKzMwPj02MD8xOjApOwogIGNvbnN0IG1pbnMgPSAobm93LmdldFVUQ01pbnV0ZXMoKSszMCklNjA7CiAg",
  "Y29uc3QgdG90YWxNaW4gPSAoKG5vdy5nZXRVVENIb3VycygpKzUpJTI0KSo2MCArIG1pbnM7CiAgY29uc3Qgb3BlbiA9IHRvdGFsTWluID49IDU1NSAmJiB0b3RhbE1pbiA8PSA5MzA7IC8vIDk6MTUgLSAxNTozMCBJU1QKICBzZXRUZXh0KCJtYXJrZXRTdGF0dXNU",
  "ZXh0Iiwgb3BlbiA/ICJNYXJrZXQgT3BlbiIgOiAiTWFya2V0IENsb3NlZCIpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5kb3QtbGl2ZSIpLnN0eWxlLmJhY2tncm91bmQgPSBvcGVuID8gInZhcigtLXBvcykiIDogInZhcigtLXRleHQtZmFpbnQpIjsKfSko",
  "KTsKCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgUkVOREVSOiBST09UCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT0gKi8KY29uc3Qgcm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYWluUm9vdCIpOwoKZnVuY3Rpb24gcmVuZGVyKCl7CiAgaWYoc3RhdGUudmlldyA9PT0gImRhc2hib2FyZCIpIHJlbmRlckRhc2hib2FyZCgpOwogIGVsc2UgaWYoc3RhdGUudmll",
  "dyA9PT0gInNjcmVlbmVyIikgcmVuZGVyU2NyZWVuZXIoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJtYXJrZXRzIikgcmVuZGVyTWFya2V0cygpOwogIGVsc2UgaWYoc3RhdGUudmlldyA9PT0gIndhdGNobGlzdCIpIHJlbmRlcldhdGNobGlzdCgpOwogIGVs",
  "c2UgaWYoc3RhdGUudmlldyA9PT0gImRldGFpbCIpIHJlbmRlckRldGFpbCgpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIERBU0hCT0FSRCAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlckRhc2hib2FyZCgpewogIHJvb3QuaW5uZXJIVE1M",
  "ID0gYAogICAgPGRpdiBjbGFzcz0idmlldyIgaWQ9ImRhc2hWaWV3Ij4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+TWFya2V0IE92ZXJ2aWV3PC9oMj48c3BhbiBjbGFzcz0ic3ViIj5SZWFsLXRpbWUgaW5kZXggc25hcHNob3Q8L3NwYW4+PC9k",
  "aXY+CiAgICAgIDxkaXYgY2xhc3M9Imhlcm8tcm93IiBpZD0iaW5kaWNlc1JvdyI+CiAgICAgICAgJHtza2VsZXRvbkNhcmRzKDMpfQogICAgICA8L2Rpdj4KCiAgICAgICR7c2VhcmNoQmxvY2soKX0KCiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgy",
  "Pk1hcmtldCBCcmVhZHRoPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5BZHZhbmNlcnMgdnMgZGVjbGluZXJzLCBmdWxsIHVuaXZlcnNlPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJnbGFzcyBicmVhZHRoLWNhcmQiIGlkPSJicmVhZHRoQ2FyZCIgc3R5bGU9",
  "InBhZGRpbmc6MThweCAyMnB4O21hcmdpbi1ib3R0b206MzRweDsiPiR7c2tlbGV0b25MaW5lcygyKX08L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPlRvcCBNb3ZlcnM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkJ5IGFic29sdXRlIGNo",
  "YW5nZSB0b2RheTwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCBnbGFzcyIgaWQ9Im1vdmVyc1RhYmxlV3JhcCI+PGRpdiBzdHlsZT0icGFkZGluZzoyMHB4OyI+JHtza2VsZXRvbkxpbmVzKDYpfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2",
  "IGNsYXNzPSJzdG9jay1jYXJkcyIgaWQ9Im1vdmVyc0NhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgd2lyZVNlYXJjaCgpOwoKICB0cnl7CiAgICBjb25zdCBpbmRpY2VzID0gYXdhaXQgQVBJLmZldGNoSW5kaWNlcygpOwogICAgZG9jdW1lbnQuZ2V0RWxl",
  "bWVudEJ5SWQoImluZGljZXNSb3ciKS5pbm5lckhUTUwgPSBpbmRpY2VzLm1hcChpbmRleENhcmRIVE1MKS5qb2luKCIiKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5pbmRleC1zcGFyayIpLmZvckVhY2goKGVsLGkpPT57CiAgICAgIGVsLmlubmVy",
  "SFRNTCA9IHNwYXJrbGluZVNWRyhpbmRpY2VzW2ldLnNlcmllcywgaW5kaWNlc1tpXS5jaGFuZ2U+PTApOwogICAgfSk7CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImluZGljZXNSb3ciKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRN",
  "TCgiTWFya2V0IGRhdGEgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUiLCAiV2UgY291bGRuJ3QgcmVhY2ggdGhlIGluZGljZXMgZmVlZC4gUGxlYXNlIHRyeSBhZ2FpbiBzaG9ydGx5LiIpOwogIH0KCiAgdHJ5ewogICAgY29uc3QgZnVsbCA9IGF3YWl0IEFQSS5mZXRj",
  "aFNjcmVlbmVyUmVzdWx0cyh7fSk7CiAgICB0cnl7CiAgICAgIHJlbmRlckJyZWFkdGgoZnVsbCk7CiAgICB9Y2F0Y2goZSl7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJicmVhZHRoQ2FyZCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJCcmVh",
  "ZHRoIGRhdGEgdW5hdmFpbGFibGUiLCAiQ291bGRuJ3QgY29tcHV0ZSBhZHZhbmNlcnMgdnMgZGVjbGluZXJzLiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7CiAgICAgIHNob3dFcnJvckJhbm5lcigicmVuZGVyQnJlYWR0aCBmYWlsZWQ6ICIgKyAo",
  "ZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogICAgfQogICAgdHJ5ewogICAgICBjb25zdCBtb3ZlcnMgPSBmdWxsLnNsaWNlKCkuc29ydCgoYSxiKT0+TWF0aC5hYnMoYi5wY3QpLU1hdGguYWJzKGEucGN0KSkuc2xpY2UoMCw4KTsKICAgICAgcmVuZGVyVGFibGVJbnRv",
  "KCJtb3ZlcnNUYWJsZVdyYXAiLCAibW92ZXJzQ2FyZHMiLCBtb3ZlcnMsIHtrZXk6InBjdCIsIGRpcjoiZGVzYyJ9LCBmYWxzZSk7CiAgICB9Y2F0Y2goZSl7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtb3ZlcnNUYWJsZVdyYXAiKS5pbm5lckhUTUwg",
  "PSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIG1vdmVycyIsICJTb21ldGhpbmcgd2VudCB3cm9uZyBsb2FkaW5nIHRoaXMgbGlzdC4gKCIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkgKyAiKSIpOwogICAgICBzaG93RXJyb3JCYW5uZXIoIm1vdmVy",
  "cyB0YWJsZSByZW5kZXIgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICAgIH0KICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibW92ZXJzVGFibGVXcmFwIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlVuYWJs",
  "ZSB0byByZXRyaWV2ZSBtb3ZlcnMiLCAiU29tZXRoaW5nIHdlbnQgd3JvbmcgbG9hZGluZyB0aGlzIGxpc3QuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJicmVhZHRoQ2FyZCIpLmlubmVySFRN",
  "TCA9IGVycm9yU3RhdGVIVE1MKCJCcmVhZHRoIGRhdGEgdW5hdmFpbGFibGUiLCAiQ291bGRuJ3QgY29tcHV0ZSBhZHZhbmNlcnMgdnMgZGVjbGluZXJzLiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7CiAgICBzaG93RXJyb3JCYW5uZXIoImZldGNo",
  "U2NyZWVuZXJSZXN1bHRzIGZhaWxlZDogIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSk7CiAgfQp9CgpmdW5jdGlvbiByZW5kZXJCcmVhZHRoKGxpc3QpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJyZWFkdGhDYXJkIik7CiAgaWYoIWVs",
  "IHx8ICFsaXN0Lmxlbmd0aCl7IGlmKGVsKSBlbC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gYnJlYWR0aCBkYXRhIiwgIk5vIHN0b2NrcyB3ZXJlIHJldHVybmVkIHRvIGNvbXB1dGUgdGhpcyBmcm9tLiIpOyByZXR1cm47IH0KICBjb25zdCBhZHZhbmNl",
  "cnMgPSBsaXN0LmZpbHRlcihzPT5zLnBjdD4wKS5sZW5ndGg7CiAgY29uc3QgZGVjbGluZXJzID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q8MCkubGVuZ3RoOwogIGNvbnN0IGZsYXQgPSBsaXN0Lmxlbmd0aCAtIGFkdmFuY2VycyAtIGRlY2xpbmVyczsKICBjb25zdCB0",
  "b3RhbCA9IGxpc3QubGVuZ3RoOwogIGNvbnN0IGFkdlBjdCA9IChhZHZhbmNlcnMvdG90YWwpKjEwMCwgZGVjUGN0ID0gKGRlY2xpbmVycy90b3RhbCkqMTAwLCBmbGF0UGN0ID0gKGZsYXQvdG90YWwpKjEwMDsKICBlbC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IHN0",
  "eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6YmFzZWxpbmU7bWFyZ2luLWJvdHRvbToxMnB4O2ZsZXgtd3JhcDp3cmFwO2dhcDo4cHg7Ij4KICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDoy",
  "MHB4OyI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMHB4O2NvbG9yOnZhcigtLXBvcy1zb2Z0KTsiPiR7YWR2YW5jZXJzfTwvc3Bhbj4gPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQt",
  "bG8pO2ZvbnQtc2l6ZToxMnB4OyI+YWR2YW5jaW5nPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjBweDtjb2xvcjp2YXIoLS1uZWctc29mdCk7Ij4ke2RlY2xpbmVyc308",
  "L3NwYW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPmRlY2xpbmluZzwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjIwcHg7",
  "Y29sb3I6dmFyKC0tdGV4dC1taWQpOyI+JHtmbGF0fTwvc3Bhbj4gPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4OyI+dW5jaGFuZ2VkPC9zcGFuPjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0iZm9udC1z",
  "aXplOjExLjVweDtjb2xvcjp2YXIoLS10ZXh0LWZhaW50KTsiPm9mICR7dG90YWx9IHRyYWNrZWQgc3RvY2tzPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtoZWlnaHQ6MTBweDtib3JkZXItcmFkaXVzOjZweDtvdmVyZmxvdzpo",
  "aWRkZW47YmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTsiPgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDoke2FkdlBjdH0lO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLXBvcyksdmFyKC0tcG9zLXNvZnQpKTsiPjwvZGl2PgogICAgICA8ZGl2",
  "IHN0eWxlPSJ3aWR0aDoke2ZsYXRQY3R9JTtiYWNrZ3JvdW5kOnZhcigtLXRleHQtZmFpbnQpOyI+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9IndpZHRoOiR7ZGVjUGN0fSU7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tbmVnLXNvZnQpLHZh",
  "cigtLW5lZykpOyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwp9CgpmdW5jdGlvbiBpbmRleENhcmRIVE1MKGlkeCl7CiAgY29uc3QgcG9zaXRpdmUgPSBpZHguY2hhbmdlID49IDA7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJnbGFzcyBpbmRleC1jYXJkIj4KICAg",
  "IDxkaXYgY2xhc3M9InJvdzEiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImluZGV4LW5hbWUiPiR7aWR4LmNvZGV9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtZnVsbCI+JHtpZHguZnVsbH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICAg",
  "IDxkaXYgY2xhc3M9ImluZGV4LWJhZGdlICR7cG9zaXRpdmU/J3Bvcyc6J25lZyd9Ij4KICAgICAgICAke3Bvc2l0aXZlPyfilrInOifilrwnfSAke3BjdFN0cihpZHgucGN0KX0KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXZh",
  "bHVlIHRhYnVsYXIiPiR7aWR4LnZhbHVlLnRvTG9jYWxlU3RyaW5nKCJlbi1JTiIse21heGltdW1GcmFjdGlvbkRpZ2l0czoyfSl9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1jaGFuZ2UgJHtwb3NpdGl2ZT8ncG9zJzonbmVnJ30gdGFidWxhciI+JHtjaGdT",
  "dHIoaWR4LmNoYW5nZSl9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayI+PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gc2tlbGV0b25DYXJkcyhuKXsKICByZXR1cm4gQXJyYXkuZnJvbSh7bGVuZ3RoOm59KS5tYXAoKCk9PmA8ZGl2IGNsYXNz",
  "PSJnbGFzcyBza2VsLWNhcmQgc2tlbCI+PC9kaXY+YCkuam9pbigiIik7Cn0KZnVuY3Rpb24gc2tlbGV0b25MaW5lcyhuKXsKICByZXR1cm4gQXJyYXkuZnJvbSh7bGVuZ3RoOm59KS5tYXAoKCk9PmA8ZGl2IGNsYXNzPSJza2VsIHNrZWwtbGluZSIgc3R5bGU9Indp",
  "ZHRoOiR7NjArTWF0aC5yYW5kb20oKSozNX0lIj48L2Rpdj5gKS5qb2luKCIiKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBTRUFSQ0ggLS0tLS0tLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiBzZWFyY2hCbG9jaygpewogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0ic2Vh",
  "cmNoLXdyYXAiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDsiPgogICAgPGRpdiBjbGFzcz0ic2VhcmNoLWJveCBnbGFzcyIgaWQ9InNlYXJjaEJveCI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIg",
  "c3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEgMjFsLTQuMy00LjMiLz48L3N2Zz4KICAgICAgPGlucHV0IHR5cGU9InRleHQiIGlkPSJzZWFyY2hJbnB1dCIgcGxh",
  "Y2Vob2xkZXI9IlNlYXJjaCBzdG9ja3MgYnkgbmFtZSBvciB0aWNrZXLigKYiIGF1dG9jb21wbGV0ZT0ib2ZmIj4KICAgICAgPGtiZCBjbGFzcz0ia3Nob3J0Y3V0Ij4vPC9rYmQ+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InNlYXJjaC1kcm9wIGdsYXNzIiBp",
  "ZD0ic2VhcmNoRHJvcCIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPjwvZGl2PgogIDwvZGl2PmA7Cn0KCmxldCBzZWFyY2hEZWJvdW5jZTsKZnVuY3Rpb24gd2lyZVNlYXJjaCgpewogIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaElu",
  "cHV0Iik7CiAgY29uc3QgYm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaEJveCIpOwogIGNvbnN0IGRyb3AgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoRHJvcCIpOwogIGlmKCFpbnB1dCkgcmV0dXJuOwoKICBkb2N1bWVudC5hZGRF",
  "dmVudExpc3RlbmVyKCJrZXlkb3duIiwgKGUpPT57CiAgICBpZihlLmtleSA9PT0gIi8iICYmIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgIT09IGlucHV0KXsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBpbnB1dC5mb2N1cygpOwogICAgfQogICAgaWYo",
  "ZS5rZXkgPT09ICJFc2NhcGUiKXsgaW5wdXQuYmx1cigpOyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyBib3guY2xhc3NMaXN0LnJlbW92ZSgiZm9jdXNlZCIpOyB9CiAgfSk7CgogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImZvY3VzIiwgKCk9PiBib3guY2xh",
  "c3NMaXN0LmFkZCgiZm9jdXNlZCIpKTsKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJibHVyIiwgKCk9PiBzZXRUaW1lb3V0KCgpPT57IGJveC5jbGFzc0xpc3QucmVtb3ZlKCJmb2N1c2VkIik7IGRyb3Auc3R5bGUuZGlzcGxheT0ibm9uZSI7IH0sIDE2MCkpOwoK",
  "ICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsICgpPT57CiAgICBjbGVhclRpbWVvdXQoc2VhcmNoRGVib3VuY2UpOwogICAgY29uc3QgcSA9IGlucHV0LnZhbHVlOwogICAgaWYoIXEudHJpbSgpKXsgZHJvcC5zdHlsZS5kaXNwbGF5PSJub25lIjsgcmV0",
  "dXJuOyB9CiAgICBkcm9wLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjsKICAgIGRyb3AuaW5uZXJIVE1MID0gYDxkaXYgc3R5bGU9InBhZGRpbmc6MTRweCAxNnB4OyI+JHtza2VsZXRvbkxpbmVzKDMpfTwvZGl2PmA7CiAgICBzZWFyY2hEZWJvdW5jZSA9IHNldFRpbWVv",
  "dXQoYXN5bmMgKCk9PnsKICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IEFQSS5zZWFyY2hTdG9ja3MocSk7CiAgICAgIGlmKCFyZXN1bHRzLmxlbmd0aCl7CiAgICAgICAgZHJvcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0ic2VhcmNoLWVtcHR5Ij5ObyBzdG9j",
  "a3MgbWF0Y2gg4oCcJHtlc2NhcGVIdG1sKHEpfeKAnTwvZGl2PmA7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGRyb3AuaW5uZXJIVE1MID0gcmVzdWx0cy5tYXAoKHMsaSk9PmAKICAgICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtcm93IiBzdHlsZT0iYW5p",
  "bWF0aW9uLWRlbGF5OiR7aSoyOH1tcyIgZGF0YS10aWNrZXI9IiR7cy50fSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1sZWZ0Ij4KICAgICAgICAgICAgPGRpdiBjbGFzcz0ic3ItdGlja2VyIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgICAgICA8",
  "ZGl2PgogICAgICAgICAgICAgIDxkaXYgY2xhc3M9InNyLW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgICAgICAgIDxkaXYgY2xhc3M9InNyLW1ldGEiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAg",
  "ICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InNyLXByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICBgKS5qb2luKCIiKTsKICAgICAgZHJvcC5xdWVyeVNlbGVjdG9yQWxsKCIuc2VhcmNo",
  "LXJvdyIpLmZvckVhY2gocm93PT57CiAgICAgICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoIm1vdXNlZG93biIsICgpPT57CiAgICAgICAgICBuYXZpZ2F0ZSgiZGV0YWlsIiwgcm93LmRhdGFzZXQudGlja2VyKTsKICAgICAgICB9KTsKICAgICAgfSk7CiAgICB9LCAy",
  "NjApOwogIH0pOwp9CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hUb2dnbGVCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoSW5wdXQiKTsKICBpZihp",
  "bnB1dCkgaW5wdXQuZm9jdXMoKTsKICBlbHNlIG5hdmlnYXRlKCJkYXNoYm9hcmQiKTsKfSk7CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNIQVJFRCBUQUJMRSBSRU5ERVIgLS0tLS0tLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiByZW5kZXJUYWJsZUludG8od3JhcElkLCBj",
  "YXJkc0lkLCBsaXN0LCBzb3J0LCBzaG93U2VjdG9yQ29sKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQod3JhcElkKTsKICBjb25zdCBjYXJkcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGNhcmRzSWQpOwogIGlmKCFsaXN0Lmxlbmd0",
  "aCl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVtcHR5U3RhdGVIVE1MKCJObyBzdG9ja3MgbWF0Y2ggeW91ciBmaWx0ZXJzIiwgIlRyeSB3aWRlbmluZyB5b3VyIHByaWNlIHJhbmdlIG9yIGNsZWFyaW5nIGEgZmlsdGVyLiIpOwogICAgaWYoY2FyZHMpIGNhcmRzLmlu",
  "bmVySFRNTCA9ICIiOwogICAgcmV0dXJuOwogIH0KICBjb25zdCBzb3J0ZWQgPSBzb3J0U3RvY2tzKGxpc3QsIHNvcnQpOwoKICB3cmFwLmlubmVySFRNTCA9IGAKICAgIDx0YWJsZSBjbGFzcz0ic3RvY2stdGFibGUiPgogICAgICA8dGhlYWQ+PHRyPgogICAgICAg",
  "IDx0aD48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0ibmFtZSI+Q29tcGFueTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJwcmljZSI+UHJpY2U8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bh",
  "bj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0iY2hhbmdlIj5DaGFuZ2U8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0icGN0Ij5DaGFuZ2UgJTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFu",
  "PjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJtYXJrZXRDYXAiPk1hcmtldCBDYXA8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0idm9sdW1lIj5Wb2x1bWU8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKW",
  "vjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0iaGlnaDUyIj41MlcgSGlnaDxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJsb3c1MiI+NTJXIExvdzxzcGFuIGNsYXNzPSJzb3J0LWluZCI+",
  "4pa+PC9zcGFuPjwvdGg+CiAgICAgIDwvdHI+PC90aGVhZD4KICAgICAgPHRib2R5PgogICAgICAgICR7c29ydGVkLm1hcCgocyxpKT0+c3RvY2tSb3dIVE1MKHMsaSkpLmpvaW4oIiIpfQogICAgICA8L3Rib2R5PgogICAgPC90YWJsZT4KICBgOwogIHdyYXAucXVl",
  "cnlTZWxlY3RvckFsbCgidGhbZGF0YS1rZXldIikuZm9yRWFjaCh0aD0+ewogICAgdGguY2xhc3NMaXN0LnRvZ2dsZSgic29ydGVkIiwgdGguZGF0YXNldC5rZXk9PT1zb3J0LmtleSk7CiAgICBpZih0aC5kYXRhc2V0LmtleT09PXNvcnQua2V5KXsgY29uc3QgaW5k",
  "ID0gdGgucXVlcnlTZWxlY3RvcigiLnNvcnQtaW5kIik7IGlmKGluZCkgaW5kLnRleHRDb250ZW50ID0gc29ydC5kaXI9PT0iZGVzYyI/IuKWviI6IuKWtCI7IH0KICAgIHRoLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgICAgY29uc3Qga2V5ID0g",
  "dGguZGF0YXNldC5rZXk7CiAgICAgIGNvbnN0IG5ld0RpciA9IChzb3J0LmtleT09PWtleSAmJiBzb3J0LmRpcj09PSJkZXNjIikgPyAiYXNjIiA6ICJkZXNjIjsKICAgICAgY29uc3QgbmV3U29ydCA9IHtrZXksIGRpcjpuZXdEaXJ9OwogICAgICBpZih3cmFwSWQ9",
  "PT0ic2NyZWVuZXJUYWJsZVdyYXAiKSBzdGF0ZS5zY3JlZW5lclNvcnQgPSBuZXdTb3J0OwogICAgICByZW5kZXJUYWJsZUludG8od3JhcElkLCBjYXJkc0lkLCBsaXN0LCBuZXdTb3J0LCBzaG93U2VjdG9yQ29sKTsKICAgIH0pOwogIH0pOwogIHdpcmVSb3dJbnRl",
  "cmFjdGlvbnMod3JhcCk7CgogIGlmKGNhcmRzKXsKICAgIGNhcmRzLmlubmVySFRNTCA9IHNvcnRlZC5tYXAoKHMsaSk9PnN0b2NrQ2FyZEhUTUwocyxpKSkuam9pbigiIik7CiAgICB3aXJlUm93SW50ZXJhY3Rpb25zKGNhcmRzKTsKICB9Cn0KCmZ1bmN0aW9uIHNv",
  "cnRTdG9ja3MobGlzdCwgc29ydCl7CiAgcmV0dXJuIGxpc3Quc2xpY2UoKS5zb3J0KChhLGIpPT57CiAgICBsZXQgYXY9YVtzb3J0LmtleV0sIGJ2PWJbc29ydC5rZXldOwogICAgaWYoc29ydC5rZXk9PT0ibmFtZSIpeyBhdj1hLm5hbWU7IGJ2PWIubmFtZTsgcmV0",
  "dXJuIHNvcnQuZGlyPT09ImFzYyI/IGF2LmxvY2FsZUNvbXBhcmUoYnYpIDogYnYubG9jYWxlQ29tcGFyZShhdik7IH0KICAgIHJldHVybiBzb3J0LmRpcj09PSJhc2MiID8gYXYtYnYgOiBidi1hdjsKICB9KTsKfQoKZnVuY3Rpb24gc3RvY2tSb3dIVE1MKHMsaSl7",
  "CiAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwogIHJldHVybiBgCiAgPHRyIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjIyfW1zIj4KICAg",
  "IDx0ZCBvbmNsaWNrPSJldmVudC5zdG9wUHJvcGFnYXRpb24oKSI+CiAgICAgIDxidXR0b24gY2xhc3M9InN0YXItYnRuICR7aW5XYXRjaD8nYWN0aXZlJzonJ30iIGRhdGEtc3Rhcj0iJHtzLnR9IiB0aXRsZT0iJHtpbldhdGNoPydSZW1vdmUgZnJvbSB3YXRjaGxp",
  "c3QnOidBZGQgdG8gd2F0Y2hsaXN0J30iPgogICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSIke2luV2F0Y2g/J2N1cnJlbnRDb2xvcic6J25vbmUnfSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEy",
  "IDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgPC9idXR0b24+CiAgICA8L3RkPgogICAgPHRkPgogICAgICA8ZGl2IGNsYXNzPSJjZWxsLWNv",
  "bXBhbnkiPgogICAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgIDxkaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2Pgog",
  "ICAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L3RkPgogICAg",
  "PHRkIGNsYXNzPSJ0YWJ1bGFyIj48c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke2NoZ1N0cihzLmNoYW5nZSl9PC9zcGFuPjwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPjxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bv",
  "cz8ncG9zJzonbmVnJ30iPiR7cGN0U3RyKHMucGN0KX08L3NwYW4+PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRDb21wYWN0KHMubWFya2V0Q2FwKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdFZvbChzLnZvbHVtZSl9PC90ZD4K",
  "ICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRJTlIocy5oaWdoNTIpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMubG93NTIpfTwvdGQ+CiAgPC90cj5gOwp9CgpmdW5jdGlvbiBzdG9ja0NhcmRIVE1MKHMsaSl7CiAgY29uc3QgcG9z",
  "ID0gcy5wY3Q+PTA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0iZ2xhc3Mgc3RvY2stY2FyZCIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheTok",
  "e2kqMjZ9bXMiPgogICAgPGRpdiBjbGFzcz0ibGVmdCI+CiAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJuYW1lLWJsb2NrIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21w",
  "YW55LW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyaWdodCI+CiAgICAg",
  "IDxkaXYgY2xhc3M9InByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICA8c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9IiBzdHlsZT0ibWFyZ2luLXRvcDo0cHg7Ij4ke3BjdFN0cihzLnBjdCl9PC9zcGFu",
  "PgogICAgPC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVJvd0ludGVyYWN0aW9ucyhjb250YWluZXIpewogIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCJ0cltkYXRhLXRpY2tlcl0sIC5zdG9jay1jYXJkW2RhdGEtdGlja2VyXSIpLmZvckVhY2go",
  "ZWw9PnsKICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PiBuYXZpZ2F0ZSgiZGV0YWlsIiwgZWwuZGF0YXNldC50aWNrZXIpKTsKICB9KTsKICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtc3Rhcl0iKS5mb3JFYWNoKGJ0bj0+ewog",
  "ICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICAgIHRvZ2dsZVdhdGNoKGJ0bi5kYXRhc2V0LnN0YXIpOwogICAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIik7CiAgICAgIGJ0",
  "bi5xdWVyeVNlbGVjdG9yKCJzdmciKS5zZXRBdHRyaWJ1dGUoImZpbGwiLCBidG4uY2xhc3NMaXN0LmNvbnRhaW5zKCJhY3RpdmUiKSA/ICJjdXJyZW50Q29sb3IiIDogIm5vbmUiKTsKICAgIH0pOwogIH0pOwp9CgpmdW5jdGlvbiB0b2dnbGVXYXRjaCh0aWNrZXIp",
  "ewogIGNvbnN0IGlkeCA9IHN0YXRlLndhdGNobGlzdC5pbmRleE9mKHRpY2tlcik7CiAgaWYoaWR4Pj0wKSBzdGF0ZS53YXRjaGxpc3Quc3BsaWNlKGlkeCwxKTsKICBlbHNlIHN0YXRlLndhdGNobGlzdC5wdXNoKHRpY2tlcik7CiAgcGVyc2lzdFdhdGNobGlzdCgp",
  "Owp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNDUkVFTkVSIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyU2NyZWVuZXIoKXsKICBjb25zdCBzZWN0b3JzID0gWyJBbGwiLCAuLi5BcnJheS5mcm9tKG5ldyBTZXQoVU5JVkVSU0UubWFwKHM9",
  "PnMuc2VjdG9yKSkpXTsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5TY3JlZW5lcjwvaDI+PHNwYW4gY2xhc3M9InN1YiI+RmlsdGVyIHRoZSBtYXJrZXQgb24geW91",
  "ciB0ZXJtczwvc3Bhbj48L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGZpbHRlcnMtYmFyIj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCIgc3R5bGU9Im1pbi13aWR0aDoyMDBweDsiPgogICAgICAgICAgPGxhYmVsPlNlYXJjaDwvbGFiZWw+",
  "CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImZRdWVyeSIgcGxhY2Vob2xkZXI9IlRpY2tlciBvciBjb21wYW554oCmIiB2YWx1ZT0iJHtlc2NhcGVIdG1sKHN0YXRlLnNjcmVlbmVyRmlsdGVycy5xdWVyeSl9Ij4KICAgICAgICA8L2Rpdj4KICAgICAg",
  "ICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCI+CiAgICAgICAgICA8bGFiZWw+U2VjdG9yPC9sYWJlbD4KICAgICAgICAgIDxzZWxlY3QgaWQ9ImZTZWN0b3IiPiR7c2VjdG9ycy5tYXAocz0+YDxvcHRpb24gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yPT09",
  "cz8nc2VsZWN0ZWQnOicnfT4ke3N9PC9vcHRpb24+YCkuam9pbigiIil9PC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiPgogICAgICAgICAgPGxhYmVsPk1heCBQcmljZSA8c3BhbiBjbGFzcz0icmFuZ2UtdmFs",
  "IiBpZD0iZlByaWNlVmFsIj4ke2ZtdElOUihzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UsMCl9PC9zcGFuPjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0icmFuZ2UiIGNsYXNzPSJyYW5nZS1zbGlkZXIiIGlkPSJmTWF4UHJpY2UiIG1pbj0iNTAw",
  "IiBtYXg9IjE1MDAwIiBzdGVwPSIyNTAiIHZhbHVlPSIke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZX0iPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIiBzdHlsZT0ibWluLXdpZHRoOjE5MHB4OyI+CiAgICAgICAg",
  "ICA8bGFiZWw+RGlyZWN0aW9uPC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1ncm91cCI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuZGlyZWN0aW9uPT09J2FsbCc/J2FjdGl2ZSc6",
  "Jyd9IiBkYXRhLWRpcj0iYWxsIj5BbGw8L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nZ2FpbmVycyc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRpcj0iZ2FpbmVycyI+R2FpbmVy",
  "czwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUtYnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbj09PSdsb3NlcnMnPydhY3RpdmUnOicnfSIgZGF0YS1kaXI9Imxvc2VycyI+TG9zZXJzPC9kaXY+CiAgICAgICAgICA8L2Rpdj4K",
  "ICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZXNldC1maWx0ZXJzIiBpZD0icmVzZXRGaWx0ZXJzIj5SZXNldCBmaWx0ZXJzPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDIgaWQ9InNjcmVlbmVy",
  "Q291bnQiPlJlc3VsdHM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlNvcnRlZCBieSBtYXJrZXQgY2FwPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIGdsYXNzIiBpZD0ic2NyZWVuZXJUYWJsZVdyYXAiPjxkaXYgc3R5bGU9InBhZGRpbmc6",
  "MjBweDsiPiR7c2tlbGV0b25MaW5lcyg4KX08L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2FyZHMiIGlkPSJzY3JlZW5lckNhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CgogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmUXVlcnkiKS5h",
  "ZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsIGRlYm91bmNlKGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5xdWVyeSA9IGUudGFyZ2V0LnZhbHVlOyBydW5TY3JlZW5lcigpOwogIH0sIDI2MCkpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmU2VjdG9y",
  "IikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwgZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3RvciA9IGUudGFyZ2V0LnZhbHVlOyBydW5TY3JlZW5lcigpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmTWF4UHJpY2UiKS5hZGRF",
  "dmVudExpc3RlbmVyKCJpbnB1dCIsIGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZSA9IE51bWJlcihlLnRhcmdldC52YWx1ZSk7CiAgICBzZXRUZXh0KCJmUHJpY2VWYWwiLCBmbXRJTlIoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFByaWNl",
  "LDApKTsKICAgIHJ1blNjcmVlbmVyKCk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtZGlyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgICBzdGF0ZS5zY3JlZW5lckZp",
  "bHRlcnMuZGlyZWN0aW9uID0gYnRuLmRhdGFzZXQuZGlyOwogICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1kaXJdIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGI9PT1idG4pKTsKICAgICAgcnVuU2NyZWVuZXIo",
  "KTsKICAgIH0pOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJyZXNldEZpbHRlcnMiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMgPSB7cXVlcnk6IiIsIHNlY3RvcjoiQWxsIiwgbWluUHJp",
  "Y2U6MCwgbWF4UHJpY2U6MTUwMDAsIGRpcmVjdGlvbjoiYWxsIn07CiAgICByZW5kZXJTY3JlZW5lcigpOwogIH0pOwoKICBydW5TY3JlZW5lcigpOwp9CgpmdW5jdGlvbiBkZWJvdW5jZShmbiwgbXMpewogIGxldCBoOwogIHJldHVybiAoLi4uYXJncyk9PnsgY2xl",
  "YXJUaW1lb3V0KGgpOyBoPXNldFRpbWVvdXQoKCk9PmZuKC4uLmFyZ3MpLCBtcyk7IH07Cn0KCmFzeW5jIGZ1bmN0aW9uIHJ1blNjcmVlbmVyKCl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzY3JlZW5lclRhYmxlV3JhcCIpOwogIGlm",
  "KCF3cmFwIHx8IHN0YXRlLnZpZXcgIT09ICJzY3JlZW5lciIpIHJldHVybjsgLy8gdmlldyBub3QgYWN0aXZlIOKAlCBub3RoaW5nIHRvIHVwZGF0ZQogIHdyYXAuc3R5bGUub3BhY2l0eSA9ICIwLjU1IjsKICB0cnl7CiAgICBjb25zdCByZXN1bHRzID0gYXdhaXQg",
  "QVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHN0YXRlLnNjcmVlbmVyRmlsdGVycyk7CiAgICBpZihzdGF0ZS52aWV3ICE9PSAic2NyZWVuZXIiKSByZXR1cm47IC8vIG5hdmlnYXRlZCBhd2F5IHdoaWxlIHRoZSBmZXRjaCB3YXMgaW4gZmxpZ2h0CiAgICBzZXRUZXh0",
  "KCJzY3JlZW5lckNvdW50IiwgYFJlc3VsdHMgKCR7cmVzdWx0cy5sZW5ndGh9KWApOwogICAgLy8gT25lLXRpbWUgZGlhZ25vc3RpYzogaWYgYSBzZWN0b3IgZmlsdGVyIHlpZWxkcyB6ZXJvLCBzaG93IGV4YWN0bHkgd2hhdAogICAgLy8gc2VjdG9yIHZhbHVlcyBh",
  "Y3R1YWxseSBleGlzdCBpbiB0aGUgbG9hZGVkIGRhdGEgc28gYSBtaXNtYXRjaCAodHlwbywKICAgIC8vIGNhc2luZywgc3RhbGUgZmllbGQpIGlzIHZpc2libGUgaW5zdGVhZCBvZiBndWVzc2VkIGF0LgogICAgaWYocmVzdWx0cy5sZW5ndGggPT09IDAgJiYgc3Rh",
  "dGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3RvciAmJiBzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yICE9PSAiQWxsIil7CiAgICAgIHRyeXsKICAgICAgICBjb25zdCB1bmZpbHRlcmVkID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHsuLi5zdGF0ZS5z",
  "Y3JlZW5lckZpbHRlcnMsIHNlY3RvcjoiQWxsIn0pOwogICAgICAgIGNvbnN0IHNlZW5TZWN0b3JzID0gQXJyYXkuZnJvbShuZXcgU2V0KHVuZmlsdGVyZWQubWFwKHM9PnMuc2VjdG9yKSkpOwogICAgICAgIHNob3dFcnJvckJhbm5lcihgREVCVUc6IDAgcmVzdWx0",
  "cyBmb3Igc2VjdG9yICIke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3J9Ii4gJHt1bmZpbHRlcmVkLmxlbmd0aH0gc3RvY2tzIGxvYWRlZCB0b3RhbC4gU2VjdG9yIHZhbHVlcyBhY3R1YWxseSBwcmVzZW50OiAke0pTT04uc3RyaW5naWZ5KHNlZW5TZWN0b3Jz",
  "KX1gKTsKICAgICAgfWNhdGNoKGUpeyAvKiBkaWFnbm9zdGljIG9ubHksIGlnbm9yZSBmYWlsdXJlcyBoZXJlICovIH0KICAgIH0KICAgIHJlbmRlclRhYmxlSW50bygic2NyZWVuZXJUYWJsZVdyYXAiLCAic2NyZWVuZXJDYXJkcyIsIHJlc3VsdHMsIHN0YXRlLnNj",
  "cmVlbmVyU29ydCwgdHJ1ZSk7CiAgfWNhdGNoKGUpewogICAgd3JhcC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiU2NyZWVuZXIgZGF0YSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4ndCBsb2FkIG1hdGNoaW5nIHN0b2NrcyByaWdodCBub3cuICgiICsgKGUg",
  "JiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIHNob3dFcnJvckJhbm5lcigicnVuU2NyZWVuZXIgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICB9CiAgd3JhcC5zdHlsZS5vcGFjaXR5ID0gIjEiOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0t",
  "IE1BUktFVFMgKGZ1bGwgdW5pdmVyc2UgdGFibGUgKyB0cmVuZGluZyBoaWdobGlnaHRzKSAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlck1hcmtldHMoKXsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgog",
  "ICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXRzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5GdWxsIE5TRSB1bml2ZXJzZSBzbmFwc2hvdDwvc3Bhbj48L2Rpdj4KICAgICAgJHtzZWFyY2hCbG9jaygpfQoKICAgICAgPGRpdiBjbGFzcz0ic2Vj",
  "dGlvbi1oZWFkIj48aDI+VHJlbmRpbmcgTm93PC9oMj48c3BhbiBjbGFzcz0ic3ViIj5Ub2RheSdzIGJpZ2dlc3QgbW92ZXJzLCB1cCBvciBkb3duPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0cmVuZGluZy1yb3ciIGlkPSJ0cmVuZGluZ1JvdyI+JHtz",
  "a2VsZXRvbkNhcmRzKDQpfTwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7Ij48aDI+QWxsIFN0b2NrczwvaDI+PHNwYW4gY2xhc3M9InN1YiI+U29ydGVkIGJ5IG1hcmtldCBjYXA8L3NwYW4+PC9kaXY+",
  "CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJtYXJrZXRzVGFibGVXcmFwIj48ZGl2IHN0eWxlPSJwYWRkaW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoMTApfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdG9jay1jYXJkcyIg",
  "aWQ9Im1hcmtldHNDYXJkcyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIHdpcmVTZWFyY2goKTsKICB0cnl7CiAgICBjb25zdCBsaXN0ID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHt9KTsKICAgIHJlbmRlclRyZW5kaW5nKGxpc3QpOwogICAgcmVu",
  "ZGVyVGFibGVJbnRvKCJtYXJrZXRzVGFibGVXcmFwIiwgIm1hcmtldHNDYXJkcyIsIGxpc3QsIHtrZXk6Im1hcmtldENhcCIsIGRpcjoiZGVzYyJ9LCB0cnVlKTsKICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFya2V0c1RhYmxlV3Jh",
  "cCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJNYXJrZXQgZGF0YSB0ZW1wb3JhcmlseSB1bmF2YWlsYWJsZSIsICJQbGVhc2UgdHJ5IGFnYWluIGluIGEgbW9tZW50LiIpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRyZW5kaW5nUm93IikuaW5u",
  "ZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlRyZW5kaW5nIGRhdGEgdW5hdmFpbGFibGUiLCAiUGxlYXNlIHRyeSBhZ2FpbiBpbiBhIG1vbWVudC4iKTsKICB9Cn0KCmZ1bmN0aW9uIHJlbmRlclRyZW5kaW5nKGxpc3QpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0",
  "RWxlbWVudEJ5SWQoInRyZW5kaW5nUm93Iik7CiAgaWYoIWVsKSByZXR1cm47CiAgaWYoIWxpc3QubGVuZ3RoKXsgZWwuaW5uZXJIVE1MID0gZW1wdHlTdGF0ZUhUTUwoIk5vIHRyZW5kaW5nIGRhdGEiLCAiTm8gc3RvY2tzIHdlcmUgcmV0dXJuZWQgdG8gcmFuay4i",
  "KTsgcmV0dXJuOyB9CiAgY29uc3QgaG90ID0gbGlzdC5zbGljZSgpLnNvcnQoKGEsYik9Pk1hdGguYWJzKGIucGN0KS1NYXRoLmFicyhhLnBjdCkpLnNsaWNlKDAsNik7CiAgZWwuaW5uZXJIVE1MID0gaG90Lm1hcCgocyxpKT0+ewogICAgY29uc3QgcG9zID0gcy5w",
  "Y3Q+PTA7CiAgICByZXR1cm4gYAogICAgPGRpdiBjbGFzcz0iZ2xhc3MgdHJlbmRpbmctY2FyZCIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqNDB9bXMiPgogICAgICA8ZGl2IGNsYXNzPSJ0cmVuZGluZy10b3AiPgogICAg",
  "ICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImluZGV4LWJhZGdlICR7cG9zPydwb3MnOiduZWcnfSI+JHtwb3M/J+KWsic6J+KWvCd9ICR7cGN0U3RyKHMucGN0KX08L2Rp",
  "dj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSIgc3R5bGU9Im1hcmdpbi10b3A6MTBweDsiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNo",
  "fTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjE5cHg7bWFyZ2luLXRvcDo4cHg7Ij4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiIHN0eWxlPSJo",
  "ZWlnaHQ6MjhweDttYXJnaW4tdG9wOjhweDsiPiR7c3BhcmtsaW5lU1ZHKHMuc2VyaWVzLCBwb3MpfTwvZGl2PgogICAgPC9kaXY+YDsKICB9KS5qb2luKCIiKTsKICBlbC5xdWVyeVNlbGVjdG9yQWxsKCIudHJlbmRpbmctY2FyZCIpLmZvckVhY2goY2FyZD0+ewog",
  "ICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT4gbmF2aWdhdGUoImRldGFpbCIsIGNhcmQuZGF0YXNldC50aWNrZXIpKTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBXQVRDSExJU1QgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5j",
  "dGlvbiByZW5kZXJXYXRjaGxpc3QoKXsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5XYXRjaGxpc3Q8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPiR7c3RhdGUud2F0Y2hs",
  "aXN0Lmxlbmd0aH0gc3RvY2ske3N0YXRlLndhdGNobGlzdC5sZW5ndGg9PT0xPycnOidzJ30gdHJhY2tlZDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0id2F0Y2hsaXN0LWdyaWQiIGlkPSJ3YXRjaEdyaWQiPiR7c2tlbGV0b25DYXJkcyhNYXRoLm1heChz",
  "dGF0ZS53YXRjaGxpc3QubGVuZ3RoLDMpKX08L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgaWYoIXN0YXRlLndhdGNobGlzdC5sZW5ndGgpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIndhdGNoR3JpZCIpLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ3YXRj",
  "aC1lbXB0eSBnbGFzcyI+JHtlbXB0eVN0YXRlSW5uZXIoIllvdXIgd2F0Y2hsaXN0IGlzIGVtcHR5IiwgIlN0YXIgYW55IHN0b2NrIGZyb20gdGhlIGRhc2hib2FyZCwgc2NyZWVuZXIgb3IgbWFya2V0cyB2aWV3IHRvIHRyYWNrIGl0IGhlcmUuIil9PC9kaXY+YDsK",
  "ICAgIHJldHVybjsKICB9CiAgdHJ5ewogICAgY29uc3Qgc3RvY2tzID0gYXdhaXQgUHJvbWlzZS5hbGwoc3RhdGUud2F0Y2hsaXN0Lm1hcCh0PT5BUEkuZmV0Y2hTdG9jayh0KSkpOwogICAgY29uc3QgZ3JpZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ3YXRj",
  "aEdyaWQiKTsKICAgIGdyaWQuaW5uZXJIVE1MID0gc3RvY2tzLmZpbHRlcihCb29sZWFuKS5tYXAoKHMsaSk9PndhdGNoQ2FyZEhUTUwocyxpKSkuam9pbigiIik7CiAgICB3aXJlV2F0Y2hDYXJkcygpOwogIH1jYXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1l",
  "bnRCeUlkKCJ3YXRjaEdyaWQiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIGxvYWQgd2F0Y2hsaXN0IiwgIlBsZWFzZSB0cnkgYWdhaW4uIik7CiAgfQp9CgpmdW5jdGlvbiB3YXRjaENhcmRIVE1MKHMsaSl7CiAgY29uc3QgcG9zID0gcy5w",
  "Y3Q+PTA7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJnbGFzcyB3YXRjaC1jYXJkIGVudGVyaW5nIiBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSo0MH1tcyI+CiAgICA8ZGl2IGNsYXNzPSJ3YXRjaC10b3AiPgogICAgICA8",
  "ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxidXR0",
  "b24gY2xhc3M9InN0YXItYnRuIGFjdGl2ZSIgZGF0YS11bnN0YXI9IiR7cy50fSIgdGl0bGU9IlJlbW92ZSI+CiAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9ImN1cnJlbnRDb2xvciIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0",
  "aD0iMiI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgPC9idXR0b24+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9",
  "ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjJweDsiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtY2hhbmdlICR7cG9zPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihzLmNoYW5nZSl9ICgk",
  "e3BjdFN0cihzLnBjdCl9KTwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiPiR7c3BhcmtsaW5lU1ZHKHMuc2VyaWVzLCBwb3MpfTwvZGl2PgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHdpcmVXYXRjaENhcmRzKCl7CiAgZG9jdW1lbnQucXVlcnlTZWxl",
  "Y3RvckFsbCgiLndhdGNoLWNhcmQiKS5mb3JFYWNoKGNhcmQ9PnsKICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAgaWYoZS50YXJnZXQuY2xvc2VzdCgiW2RhdGEtdW5zdGFyXSIpKSByZXR1cm47CiAgICAgIG5hdmlnYXRlKCJk",
  "ZXRhaWwiLCBjYXJkLmRhdGFzZXQudGlja2VyKTsKICAgIH0pOwogIH0pOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLXVuc3Rhcl0iKS5mb3JFYWNoKGJ0bj0+ewogICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAg",
  "IGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICAgIGNvbnN0IGNhcmQgPSBidG4uY2xvc2VzdCgiLndhdGNoLWNhcmQiKTsKICAgICAgY2FyZC5jbGFzc0xpc3QuYWRkKCJyZW1vdmluZyIpOwogICAgICB0b2dnbGVXYXRjaChidG4uZGF0YXNldC51bnN0YXIpOwogICAg",
  "ICBzZXRUaW1lb3V0KCgpPT57CiAgICAgICAgaWYoIXN0YXRlLndhdGNobGlzdC5sZW5ndGgpIHJlbmRlcldhdGNobGlzdCgpOwogICAgICAgIGVsc2UgY2FyZC5yZW1vdmUoKTsKICAgICAgICBjb25zdCBzdWJFbCA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5z",
  "ZWN0aW9uLWhlYWQgLnN1YiIpOwogICAgICAgIGlmKHN1YkVsKSBzdWJFbC50ZXh0Q29udGVudCA9IGAke3N0YXRlLndhdGNobGlzdC5sZW5ndGh9IHN0b2NrJHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RoPT09MT8nJzoncyd9IHRyYWNrZWRgOwogICAgICB9LCAyODAp",
  "OwogICAgfSk7CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gU1RPQ0sgREVUQUlMIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyRGV0YWlsKCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0idmlldyIgaWQ9ImRldGFp",
  "bFNrZWxldG9uIj4KICAgIDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwtY2FyZCBza2VsIiBzdHlsZT0iaGVpZ2h0Ojg4cHg7bWFyZ2luLWJvdHRvbToyNHB4OyI+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPiR7c2tlbGV0b25DYXJkcyg2KX08L2Rp",
  "dj4KICAgIDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwtY2FyZCBza2VsIiBzdHlsZT0iaGVpZ2h0OjMyMHB4OyI+PC9kaXY+CiAgPC9kaXY+YDsKCiAgbGV0IHM7CiAgdHJ5eyBzID0gYXdhaXQgQVBJLmZldGNoU3RvY2soc3RhdGUuZGV0YWlsVGlja2VyKTsgfWNhdGNo",
  "KGUpeyBzID0gbnVsbDsgfQogIGlmKCFzKXsKICAgIHJvb3QuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byByZXRyaWV2ZSB0aGlzIHN0b2NrIiwgIlRoZSB0aWNrZXIgeW91J3JlIGxvb2tpbmcgZm9yIGlzbid0IGF2YWlsYWJsZSByaWdodCBu",
  "b3cuIik7CiAgICByZXR1cm47CiAgfQogIGNvbnN0IHBvcyA9IHMucGN0ID49IDA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwoKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8",
  "ZGl2IGNsYXNzPSJkZXRhaWwtaGVhZCI+CiAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXRpdGxlLXJvdyI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgICAgPGRpdj4KICAg",
  "ICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9IMK3ICR7cy5zZWN0b3J9PC9kaXY+CiAgICAgICAgICA8",
  "L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxNHB4OyI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtcHJpY2UtYmxvY2siPgogICAgICAgICAgICA8ZGl2IGNsYXNz",
  "PSJkZXRhaWwtcHJpY2UgdGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1jaGFuZ2UgJHtwb3M/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKHMuY2hhbmdlKX0gKCR7cGN0U3RyKHMucGN0",
  "KX0pIHRvZGF5PC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiBpZD0iZGV0YWlsU3RhciIgc3R5bGU9IndpZHRoOjQ0cHg7aGVpZ2h0OjQ0cHg7Y29sb3I6JHtpbldhdGNoPycjRkZDODU3JzondmFyKC0tdGV4",
  "dC1taWQpJ30iPgogICAgICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iJHtpbldhdGNoPydjdXJyZW50Q29sb3InOidub25lJ30iIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0eWxlPSJ3aWR0aDoxOXB4O2hlaWdo",
  "dDoxOXB4OyI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48L3N2Zz4KICAgICAgICAgIDwvYnV0dG9uPgogICAgICAgIDwvZGl2PgogICAg",
  "ICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+CiAgICAgICAgJHttZXRyaWNDYXJkKCJPcGVuIiwgZm10SU5SKHMub3BlbikpfQogICAgICAgICR7bWV0cmljQ2FyZCgiRGF5IEhpZ2giLCBmbXRJTlIocy5kYXlIaWdoKSl9CiAgICAgICAg",
  "JHttZXRyaWNDYXJkKCJEYXkgTG93IiwgZm10SU5SKHMuZGF5TG93KSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCJNYXJrZXQgQ2FwIiwgZm10Q29tcGFjdChzLm1hcmtldENhcCkpfQogICAgICAgICR7bWV0cmljQ2FyZCgiVm9sdW1lIiwgZm10Vm9sKHMudm9sdW1l",
  "KSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCI1MlcgSGlnaCAvIExvdyIsIGZtdElOUihzLmhpZ2g1MiwwKSsiIC8gIitmbXRJTlIocy5sb3c1MiwwKSl9CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgY2hhcnQtY2FyZCI+CiAgICAgICAgPGRp",
  "diBjbGFzcz0iY2hhcnQtaGVhZCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiIHN0eWxlPSJtYXJnaW46MDsiPjxoMj5QcmljZSBDaGFydDwvaDI+PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJyYW5nZS10YWJzIiBpZD0icmFuZ2VUYWJz",
  "Ij4KICAgICAgICAgICAgJHtbIjFEIiwiMVciLCIxTSIsIjNNIiwiNk0iLCIxWSJdLm1hcChyPT5gPGJ1dHRvbiBkYXRhLXJhbmdlPSIke3J9IiBjbGFzcz0iJHtzdGF0ZS5kZXRhaWxSYW5nZT09PXI/J2FjdGl2ZSc6Jyd9Ij4ke3J9PC9idXR0b24+YCkuam9pbigi",
  "Iil9CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC1jYW52YXMtd3JhcCIgaWQ9ImNoYXJ0V3JhcCI+CiAgICAgICAgICA8Y2FudmFzIGlkPSJwcmljZUNoYXJ0Ij48L2NhbnZhcz4KICAgICAgICAgIDxkaXYg",
  "Y2xhc3M9ImNoYXJ0LXRvb2x0aXAiIGlkPSJjaGFydFRvb2x0aXAiPjwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InZvbHVtZS13cmFwIiBpZD0idm9sdW1lV3JhcCI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJ2b2x1bWUtbGFiZWwiPlZv",
  "bHVtZSA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1mYWludCk7Zm9udC13ZWlnaHQ6NjAwOyI+KHJlbGF0aXZlLCBkZXJpdmVkIGZyb20gcHJpY2UgbW92ZW1lbnQpPC9zcGFuPjwvZGl2PgogICAgICAgICAgPGNhbnZhcyBpZD0idm9sdW1lQ2hhcnQiPjwv",
  "Y2FudmFzPgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgc3R5bGU9Im1hcmdpbi1ib3R0b206MjhweDsiPgogICAgICAgIDxidXR0b24gY2xhc3M9ImV4cGxhaW4tYnRuIiBpZD0iZXhwbGFpbkJ0biI+CiAgICAgICAgICA8c3ZnIHZpZXdC",
  "b3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgOFY0SDgiLz48cmVjdCB4PSI0IiB5PSI4",
  "IiB3aWR0aD0iMTYiIGhlaWdodD0iMTIiIHJ4PSIyIi8+PHBhdGggZD0iTTIgMTRoMk0yMCAxNGgyTTkgMTN2Mk0xNSAxM3YyIi8+PC9zdmc+CiAgICAgICAgICBFeHBsYWluIHRoaXMgc3RvY2sKICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8ZGl2IGNsYXNzPSJn",
  "bGFzcyBleHBsYWluLWNhcmQiIGlkPSJleHBsYWluQ2FyZCIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPjwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogIGA7CgogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJkZXRhaWxTdGFyIikuYWRkRXZlbnRMaXN0ZW5l",
  "cigiY2xpY2siLCAoKT0+ewogICAgdG9nZ2xlV2F0Y2gocy50KTsKICAgIHJlbmRlckRldGFpbCgpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJyYW5nZVRhYnMiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChlKT0+ewogICAgY29uc3QgYnRu",
  "ID0gZS50YXJnZXQuY2xvc2VzdCgiYnV0dG9uW2RhdGEtcmFuZ2VdIik7CiAgICBpZighYnRuKSByZXR1cm47CiAgICBzdGF0ZS5kZXRhaWxSYW5nZSA9IGJ0bi5kYXRhc2V0LnJhbmdlOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiI3JhbmdlVGFicyBi",
  "dXR0b24iKS5mb3JFYWNoKGI9PmIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYj09PWJ0bikpOwogICAgbG9hZENoYXJ0KHMudCwgcy5wY3Q+PTApOwogIH0pOwogIHdpcmVFeHBsYWluQnV0dG9uKHMudCk7CgogIGxvYWRDaGFydChzLnQsIHBvcyk7Cn0KCmZ1",
  "bmN0aW9uIG1ldHJpY0NhcmQobGFiZWwsIHZhbHVlKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9ImdsYXNzIG1ldHJpYy1jYXJkIj48ZGl2IGNsYXNzPSJtZXRyaWMtbGFiZWwiPiR7bGFiZWx9PC9kaXY+PGRpdiBjbGFzcz0ibWV0cmljLXZhbHVlIHRhYnVsYXIiPiR7",
  "dmFsdWV9PC9kaXY+PC9kaXY+YDsKfQoKYXN5bmMgZnVuY3Rpb24gbG9hZENoYXJ0KHRpY2tlciwgcG9zaXRpdmUpewogIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiY2hhcnRXcmFwIik7CiAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQuZ2V0",
  "RWxlbWVudEJ5SWQoInByaWNlQ2hhcnQiKTsKICBpZighd3JhcCB8fCAhY2FudmFzKSByZXR1cm47CiAgY2FudmFzLnN0eWxlLm9wYWNpdHkgPSAiMC4yNSI7CiAgbGV0IHNlcmllczsKICB0cnl7CiAgICBzZXJpZXMgPSBhd2FpdCBBUEkuZmV0Y2hTdG9ja0hpc3Rv",
  "cnkodGlja2VyLCBzdGF0ZS5kZXRhaWxSYW5nZSk7CiAgfWNhdGNoKGUpewogICAgd3JhcC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiQ2hhcnQgZGF0YSB1bmF2YWlsYWJsZSIsICJUaGlzIHRpbWVmcmFtZSBjb3VsZG4ndCBiZSBsb2FkZWQuIFRyeSBhIGRp",
  "ZmZlcmVudCByYW5nZS4iKTsKICAgIHJldHVybjsKICB9CiAgY2FudmFzLnN0eWxlLm9wYWNpdHkgPSAiMSI7CiAgZHJhd0NoYXJ0KGNhbnZhcywgc2VyaWVzLCBwb3NpdGl2ZSwgdGlja2VyKTsKICBkcmF3Vm9sdW1lQ2hhcnQoc2VyaWVzLCBwb3NpdGl2ZSk7Cn0K",
  "CmZ1bmN0aW9uIGRyYXdWb2x1bWVDaGFydChzZXJpZXMsIHBvc2l0aXZlKXsKICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidm9sdW1lQ2hhcnQiKTsKICBpZighY2FudmFzKSByZXR1cm47CiAgY29uc3QgcmVjdCA9IGNhbnZhcy5nZXRC",
  "b3VuZGluZ0NsaWVudFJlY3QoKTsKICBjb25zdCBkcHIgPSB3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxOwogIGNhbnZhcy53aWR0aCA9IHJlY3Qud2lkdGggKiBkcHI7CiAgY2FudmFzLmhlaWdodCA9IHJlY3QuaGVpZ2h0ICogZHByOwogIGNvbnN0IGN0eCA9",
  "IGNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOwogIGN0eC5zY2FsZShkcHIsZHByKTsKICBjb25zdCBXID0gcmVjdC53aWR0aCwgSCA9IHJlY3QuaGVpZ2h0OwogIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7CgogIC8vIERlcml2ZSBhIHBsYXVzaWJsZSByZWxhdGl2ZSB2",
  "b2x1bWUgcHJvZmlsZSBmcm9tIHRoZSBwcmljZSBzZXJpZXMnCiAgLy8gcG9pbnQtdG8tcG9pbnQgdm9sYXRpbGl0eSAoYmlnZ2VyIG1vdmVzIHRlbmQgdG8gY29pbmNpZGUgd2l0aCBoaWdoZXIKICAvLyB2b2x1bWUpIOKAlCBpbGx1c3RyYXRpdmUgb25seTsgdGhl",
  "IGJhY2tlbmQgaGFzIG5vIGhpc3RvcmljYWwgdm9sdW1lIGZlZWQuCiAgY29uc3QgZGVsdGFzID0gc2VyaWVzLm1hcCgodixpKT0+IGk9PT0wID8gMCA6IE1hdGguYWJzKHYtc2VyaWVzW2ktMV0pKTsKICBjb25zdCBtYXhEID0gTWF0aC5tYXgoLi4uZGVsdGFzLCAx",
  "ZS02KTsKICBjb25zdCBiYXJXID0gVy9zZXJpZXMubGVuZ3RoOwogIGNvbnN0IGNvbG9yID0gcG9zaXRpdmUgPyAiIzMzRDZBNiIgOiAiI0ZCNkI2QiI7CiAgc2VyaWVzLmZvckVhY2goKHYsaSk9PnsKICAgIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKHN0YXRlLmRl",
  "dGFpbFRpY2tlcikraSo3OwogICAgY29uc3QgaCA9IE1hdGgubWF4KDMsIChkZWx0YXNbaV0vbWF4RCkgKiBIICogMC44NSAqICgwLjU1ICsgc2VlZGVkUmFuZChzZWVkKSowLjYpKTsKICAgIGNvbnN0IHVwID0gaT09PTAgPyB0cnVlIDogc2VyaWVzW2ldID49IHNl",
  "cmllc1tpLTFdOwogICAgY3R4LmZpbGxTdHlsZSA9IHVwID8gInJnYmEoNTEsMjE0LDE2NiwwLjU1KSIgOiAicmdiYSgyNTEsMTA3LDEwNywwLjU1KSI7CiAgICBjdHguZmlsbFJlY3QoaSpiYXJXK2JhclcqMC4xNSwgSC1oLCBNYXRoLm1heCgxLGJhclcqMC43KSwg",
  "aCk7CiAgfSk7Cn0KCmZ1bmN0aW9uIGRyYXdDaGFydChjYW52YXMsIHNlcmllcywgcG9zaXRpdmUsIHRpY2tlcil7CiAgY29uc3Qgd3JhcCA9IGNhbnZhcy5wYXJlbnRFbGVtZW50OwogIGNvbnN0IGRwciA9IHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDE7CiAg",
  "Y29uc3QgcmVjdCA9IHdyYXAuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgY2FudmFzLndpZHRoID0gcmVjdC53aWR0aCAqIGRwcjsKICBjYW52YXMuaGVpZ2h0ID0gcmVjdC5oZWlnaHQgKiBkcHI7CiAgY2FudmFzLnN0eWxlLndpZHRoID0gcmVjdC53aWR0aCsi",
  "cHgiOwogIGNhbnZhcy5zdHlsZS5oZWlnaHQgPSByZWN0LmhlaWdodCsicHgiOwogIGNvbnN0IGN0eCA9IGNhbnZhcy5nZXRDb250ZXh0KCIyZCIpOwogIGN0eC5zY2FsZShkcHIsZHByKTsKCiAgY29uc3QgVyA9IHJlY3Qud2lkdGgsIEggPSByZWN0LmhlaWdodDsK",
  "ICBjb25zdCBwYWQgPSB7dG9wOjE2LCByaWdodDo4LCBib3R0b206MjQsIGxlZnQ6OH07CiAgY29uc3QgbWluID0gTWF0aC5taW4oLi4uc2VyaWVzKSwgbWF4ID0gTWF0aC5tYXgoLi4uc2VyaWVzKTsKICBjb25zdCByYW5nZVYgPSAobWF4LW1pbikgfHwgMTsKICBj",
  "b25zdCBpbm5lclcgPSBXIC0gcGFkLmxlZnQgLSBwYWQucmlnaHQ7CiAgY29uc3QgaW5uZXJIID0gSCAtIHBhZC50b3AgLSBwYWQuYm90dG9tOwogIGNvbnN0IHN0ZXAgPSBpbm5lclcvKHNlcmllcy5sZW5ndGgtMSk7CgogIGZ1bmN0aW9uIHh5KGksdil7CiAgICBy",
  "ZXR1cm4gW3BhZC5sZWZ0ICsgaSpzdGVwLCBwYWQudG9wICsgaW5uZXJIIC0gKCh2LW1pbikvcmFuZ2VWKSppbm5lckhdOwogIH0KICBjb25zdCBwdHMgPSBzZXJpZXMubWFwKCh2LGkpPT54eShpLHYpKTsKCiAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKCiAgLy8g",
  "Z3JpZGxpbmVzCiAgY3R4LnN0cm9rZVN0eWxlID0gInJnYmEoMTU4LDE3MSwyMTQsMC4wOCkiOwogIGN0eC5saW5lV2lkdGggPSAxOwogIGZvcihsZXQgaT0wO2k8PTM7aSsrKXsKICAgIGNvbnN0IHkgPSBwYWQudG9wICsgKGlubmVySC8zKSppOwogICAgY3R4LmJl",
  "Z2luUGF0aCgpOyBjdHgubW92ZVRvKHBhZC5sZWZ0LHkpOyBjdHgubGluZVRvKFctcGFkLnJpZ2h0LHkpOyBjdHguc3Ryb2tlKCk7CiAgfQoKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8gIiMzM0Q2QTYiIDogIiNGQjZCNkIiOwoKICAvLyBzbW9vdGggcGF0aAog",
  "IGZ1bmN0aW9uIHNtb290aFBhdGgocG9pbnRzKXsKICAgIGlmKHBvaW50cy5sZW5ndGg8MykgcmV0dXJuIGBNJHtwb2ludHNbMF1bMF19LCR7cG9pbnRzWzBdWzFdfSBMJHtwb2ludHNbMV1bMF19LCR7cG9pbnRzWzFdWzFdfWA7CiAgICBsZXQgZCA9IGBNJHtwb2lu",
  "dHNbMF1bMF19LCR7cG9pbnRzWzBdWzFdfWA7CiAgICBmb3IobGV0IGk9MDtpPHBvaW50cy5sZW5ndGgtMTtpKyspewogICAgICBjb25zdCBwMCA9IHBvaW50c1tpPT09MD8wOmktMV07CiAgICAgIGNvbnN0IHAxID0gcG9pbnRzW2ldOwogICAgICBjb25zdCBwMiA9",
  "IHBvaW50c1tpKzFdOwogICAgICBjb25zdCBwMyA9IHBvaW50c1tpKzI8cG9pbnRzLmxlbmd0aD9pKzI6aSsxXTsKICAgICAgY29uc3QgY3AxeCA9IHAxWzBdICsgKHAyWzBdLXAwWzBdKS82OwogICAgICBjb25zdCBjcDF5ID0gcDFbMV0gKyAocDJbMV0tcDBbMV0p",
  "LzY7CiAgICAgIGNvbnN0IGNwMnggPSBwMlswXSAtIChwM1swXS1wMVswXSkvNjsKICAgICAgY29uc3QgY3AyeSA9IHAyWzFdIC0gKHAzWzFdLXAxWzFdKS82OwogICAgICBkICs9IGAgQyR7Y3AxeH0sJHtjcDF5fSAke2NwMnh9LCR7Y3AyeX0gJHtwMlswXX0sJHtw",
  "MlsxXX1gOwogICAgfQogICAgcmV0dXJuIGQ7CiAgfQogIGNvbnN0IGxpbmVQYXRoID0gbmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpOwoKICAvLyBhcmVhIGZpbGwKICBjb25zdCBncmFkID0gY3R4LmNyZWF0ZUxpbmVhckdyYWRpZW50KDAscGFkLnRvcCwwLHBh",
  "ZC50b3AraW5uZXJIKTsKICBncmFkLmFkZENvbG9yU3RvcCgwLCBjb2xvcisiNTUiKTsKICBncmFkLmFkZENvbG9yU3RvcCgxLCBjb2xvcisiMDIiKTsKICBjdHguc2F2ZSgpOwogIGNvbnN0IGFyZWFQYXRoID0gbmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpOwog",
  "IGFyZWFQYXRoLmxpbmVUbyhwdHNbcHRzLmxlbmd0aC0xXVswXSwgcGFkLnRvcCtpbm5lckgpOwogIGFyZWFQYXRoLmxpbmVUbyhwdHNbMF1bMF0sIHBhZC50b3AraW5uZXJIKTsKICBhcmVhUGF0aC5jbG9zZVBhdGgoKTsKICBjdHguZmlsbFN0eWxlID0gZ3JhZDsK",
  "ICBjdHguZmlsbChhcmVhUGF0aCk7CiAgY3R4LnJlc3RvcmUoKTsKCiAgLy8gbGluZQogIGN0eC5zdHJva2VTdHlsZSA9IGNvbG9yOwogIGN0eC5saW5lV2lkdGggPSAyOwogIGN0eC5saW5lSm9pbiA9ICJyb3VuZCI7CiAgY3R4LmxpbmVDYXAgPSAicm91bmQiOwog",
  "IGN0eC5zdHJva2UobGluZVBhdGgpOwoKICAvLyBlbnRyYW5jZSBhbmltYXRpb24gdmlhIGNsaXAgcmV2ZWFsCiAgY2FudmFzLl9jaGFydE1ldGEgPSB7cHRzLCBzZXJpZXMsIFcsIEgsIHBhZCwgY29sb3J9OwoKICAvLyBjcm9zc2hhaXIgaW50ZXJhY3Rpdml0eQog",
  "IGNvbnN0IHRvb2x0aXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiY2hhcnRUb29sdGlwIik7CiAgY2FudmFzLm9ubW91c2Vtb3ZlID0gKGUpPT57CiAgICBjb25zdCByID0gY2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogICAgY29uc3QgbXggPSBl",
  "LmNsaWVudFggLSByLmxlZnQ7CiAgICBsZXQgaWR4ID0gTWF0aC5yb3VuZCgobXgtcGFkLmxlZnQpL3N0ZXApOwogICAgaWR4ID0gTWF0aC5tYXgoMCwgTWF0aC5taW4oc2VyaWVzLmxlbmd0aC0xLCBpZHgpKTsKICAgIGNvbnN0IFtweCxweV0gPSBwdHNbaWR4XTsK",
  "CiAgICByZWRyYXdXaXRoQ3Jvc3NoYWlyKGN0eCwgY2FudmFzLl9jaGFydE1ldGEsIHB4LCBweSk7CgogICAgdG9vbHRpcC5zdHlsZS5vcGFjaXR5ID0gIjEiOwogICAgdG9vbHRpcC5zdHlsZS5sZWZ0ID0gcHgrInB4IjsKICAgIHRvb2x0aXAuc3R5bGUudG9wID0g",
  "cHkrInB4IjsKICAgIHRvb2x0aXAuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InR0LXByaWNlIj4ke2ZtdElOUihzZXJpZXNbaWR4XSl9PC9kaXY+PGRpdiBjbGFzcz0idHQtZGF0ZSI+UG9pbnQgJHtpZHgrMX0gb2YgJHtzZXJpZXMubGVuZ3RofTwvZGl2PmA7CiAg",
  "fTsKICBjYW52YXMub25tb3VzZWxlYXZlID0gKCk9PnsKICAgIHRvb2x0aXAuc3R5bGUub3BhY2l0eSA9ICIwIjsKICAgIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7CiAgICByZWRyYXcoY3R4LCBjYW52YXMuX2NoYXJ0TWV0YSk7CiAgfTsKCiAgZnVuY3Rpb24gcmVk",
  "cmF3KGN0eCwgbWV0YSl7CiAgICBjb25zdCB7cHRzLCBXLCBILCBwYWQsIGNvbG9yfSA9IG1ldGE7CiAgICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gInJnYmEoMTU4LDE3MSwyMTQsMC4wOCkiOwogICAgY3R4LmxpbmVXaWR0",
  "aCA9IDE7CiAgICBjb25zdCBpbm5lckgyID0gSC1wYWQudG9wLXBhZC5ib3R0b207CiAgICBmb3IobGV0IGk9MDtpPD0zO2krKyl7CiAgICAgIGNvbnN0IHkgPSBwYWQudG9wICsgKGlubmVySDIvMykqaTsKICAgICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRv",
  "KHBhZC5sZWZ0LHkpOyBjdHgubGluZVRvKFctcGFkLnJpZ2h0LHkpOyBjdHguc3Ryb2tlKCk7CiAgICB9CiAgICBjb25zdCBncmFkMiA9IGN0eC5jcmVhdGVMaW5lYXJHcmFkaWVudCgwLHBhZC50b3AsMCxwYWQudG9wK2lubmVySDIpOwogICAgZ3JhZDIuYWRkQ29s",
  "b3JTdG9wKDAsIGNvbG9yKyI1NSIpOyBncmFkMi5hZGRDb2xvclN0b3AoMSwgY29sb3IrIjAyIik7CiAgICBjb25zdCBhcmVhUGF0aDIgPSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7CiAgICBhcmVhUGF0aDIubGluZVRvKHB0c1twdHMubGVuZ3RoLTFdWzBd",
  "LCBwYWQudG9wK2lubmVySDIpOwogICAgYXJlYVBhdGgyLmxpbmVUbyhwdHNbMF1bMF0sIHBhZC50b3AraW5uZXJIMik7CiAgICBhcmVhUGF0aDIuY2xvc2VQYXRoKCk7CiAgICBjdHguZmlsbFN0eWxlID0gZ3JhZDI7IGN0eC5maWxsKGFyZWFQYXRoMik7CiAgICBj",
  "dHguc3Ryb2tlU3R5bGUgPSBjb2xvcjsgY3R4LmxpbmVXaWR0aCA9IDI7IGN0eC5saW5lSm9pbj0icm91bmQiOyBjdHgubGluZUNhcD0icm91bmQiOwogICAgY3R4LnN0cm9rZShuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSkpOwogIH0KICBmdW5jdGlvbiByZWRy",
  "YXdXaXRoQ3Jvc3NoYWlyKGN0eCwgbWV0YSwgcHgsIHB5KXsKICAgIHJlZHJhdyhjdHgsIG1ldGEpOwogICAgY29uc3Qge0gsIHBhZCwgY29sb3J9ID0gbWV0YTsKICAgIGN0eC5zYXZlKCk7CiAgICBjdHguc3Ryb2tlU3R5bGUgPSAicmdiYSgxNTgsMTcxLDIxNCww",
  "LjM1KSI7CiAgICBjdHgubGluZVdpZHRoID0gMTsKICAgIGN0eC5zZXRMaW5lRGFzaChbMywzXSk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8ocHgsIHBhZC50b3ApOyBjdHgubGluZVRvKHB4LCBILXBhZC5ib3R0b20pOyBjdHguc3Ryb2tlKCk7CiAg",
  "ICBjdHguc2V0TGluZURhc2goW10pOwogICAgY3R4LmJlZ2luUGF0aCgpOyBjdHguYXJjKHB4LHB5LDQsMCxNYXRoLlBJKjIpOwogICAgY3R4LmZpbGxTdHlsZSA9IGNvbG9yOyBjdHguZmlsbCgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gIiMwNTA2MEIiOyBjdHgu",
  "bGluZVdpZHRoPTI7IGN0eC5zdHJva2UoKTsKICAgIGN0eC5yZXN0b3JlKCk7CiAgfQp9Cgp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigicmVzaXplIiwgZGVib3VuY2UoKCk9PnsKICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicHJpY2VD",
  "aGFydCIpOwogIGlmKGNhbnZhcyAmJiBzdGF0ZS52aWV3PT09ImRldGFpbCIpIGxvYWRDaGFydChzdGF0ZS5kZXRhaWxUaWNrZXIsIHRydWUpOwp9LCAyMDApKTsKCi8qIC0tLS0tLS0tLS0tLS0tLS0gU1RBVEUgSEVMUEVSUyAtLS0tLS0tLS0tLS0tLS0tICovCmZ1",
  "bmN0aW9uIGVtcHR5U3RhdGVJbm5lcih0aXRsZSwgc3ViKXsKICByZXR1cm4gYAogICAgPGRpdiBjbGFzcz0ic3RhdGUtaWNvbiI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50",
  "Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNyIvPjxwYXRoIGQ9Ik0yMSAyMWwtNC4zLTQuMyIvPjwvc3ZnPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtdGl0bGUiPiR7dGl0bGV9PC9kaXY+CiAgICA8ZGl2IGNs",
  "YXNzPSJzdGF0ZS1zdWIiPiR7c3VifTwvZGl2PgogIGA7Cn0KZnVuY3Rpb24gZW1wdHlTdGF0ZUhUTUwodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJzdGF0ZS1ib3giPiR7ZW1wdHlTdGF0ZUlubmVyKHRpdGxlLCBzdWIpfTwvZGl2PmA7Cn0KZnVu",
  "Y3Rpb24gZXJyb3JTdGF0ZUhUTUwodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJzdGF0ZS1ib3giPgogICAgPGRpdiBjbGFzcz0ic3RhdGUtaWNvbiI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIHdpZHRoPSIyMiIgaGVpZ2h0PSIyMiIgZmlsbD0i",
  "bm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDl2NE0xMiAxN2guMDFNMTAuMjkgMy44NkwxLjgyIDE4YTIgMiAwIDAwMS43MSAzaDE2Ljk0YTIgMiAwIDAwMS43MS0zTDEzLjcxIDMuODZhMiAyIDAgMDAtMy40",
  "MiAweiIvPjwvc3ZnPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtdGl0bGUiPiR7dGl0bGV9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1zdWIiPiR7c3VifTwvZGl2PgogIDwvZGl2PmA7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQk9PVAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQUkgQVNTSVNUQU5UIOKAlCBjaGF0IHBhbmVsICsgcGVyLXN0b2NrIGV4cGxhaW4KICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PSAqLwpjb25zdCBhaVN0YXRlID0geyBvcGVuOiBmYWxzZSwgaGlzdG9yeTogW10sIGNvbmZpZ3VyZWQ6IG51bGwsIGJ1c3k6IGZhbHNlIH07CgpmdW5jdGlvbiBhaVNldFN0YXR1c0xpbmUodGV4dCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJ",
  "ZCgiYWlTdGF0dXNMaW5lIik7CiAgaWYoZWwpIGVsLnRleHRDb250ZW50ID0gdGV4dDsKfQoKYXN5bmMgZnVuY3Rpb24gY2hlY2tBaVN0YXR1cygpewogIHRyeXsKICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KENPTkZJRy5BUElfQkFTRSArICIv",
  "YWkvc3RhdHVzIiwgQ09ORklHLkxJVkVfVElNRU9VVF9NUyk7CiAgICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCJiYWQgc3RhdHVzIik7CiAgICBjb25zdCBqc29uID0gYXdhaXQgci5qc29uKCk7CiAgICBhaVN0YXRlLmNvbmZpZ3VyZWQgPSAhIWpzb24uY29u",
  "ZmlndXJlZDsKICAgIGFpU2V0U3RhdHVzTGluZShhaVN0YXRlLmNvbmZpZ3VyZWQgPyAiUmVhZHkiIDogIk5vdCBjb25maWd1cmVkIG9uIHNlcnZlciIpOwogIH1jYXRjaChlKXsKICAgIGFpU3RhdGUuY29uZmlndXJlZCA9IGZhbHNlOwogICAgYWlTZXRTdGF0dXNM",
  "aW5lKGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gIlVuYXZhaWxhYmxlIiA6ICJCYWNrZW5kIG5vdCBjb25uZWN0ZWQiKTsKICB9Cn0KCmZ1bmN0aW9uIGJ1aWxkQWlDb250ZXh0KCl7CiAgLy8gQ29tcGFjdCwgcmVsZXZhbnQgc25hcHNob3Qgb2Ygd2hhdCdzIGN1cnJl",
  "bnRseSBsb2FkZWQg4oCUIGtlcHQgc21hbGwgb24KICAvLyBwdXJwb3NlIHNpbmNlIHRoaXMgZ2V0cyBzZW50IChhbmQgYmlsbGVkKSBvbiBldmVyeSBxdWVzdGlvbi4KICBjb25zdCBjdHggPSB7IHZpZXc6IHN0YXRlLnZpZXcsIHdhdGNobGlzdDogW10gfTsKICBp",
  "ZihzdGF0ZS52aWV3ID09PSAiZGV0YWlsIikgY3R4LmN1cnJlbnRTdG9jayA9IHsgdGlja2VyOiBzdGF0ZS5kZXRhaWxUaWNrZXIgfTsKICBpZihzdGF0ZS53YXRjaGxpc3QubGVuZ3RoKXsKICAgIGN0eC53YXRjaGxpc3QgPSBzdGF0ZS53YXRjaGxpc3Quc2xpY2Uo",
  "MCwgMTApOwogIH0KICByZXR1cm4gY3R4Owp9CgpmdW5jdGlvbiBhcHBlbmRBaU1lc3NhZ2Uocm9sZSwgdGV4dCwgZXh0cmFDbGFzcyl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaU1lc3NhZ2VzIik7CiAgaWYoIXdyYXApIHJldHVy",
  "biBudWxsOwogIGNvbnN0IGRpdiA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImRpdiIpOwogIGRpdi5jbGFzc05hbWUgPSAiYWktbXNnICIgKyByb2xlICsgKGV4dHJhQ2xhc3MgPyAiICIgKyBleHRyYUNsYXNzIDogIiIpOwogIGRpdi50ZXh0Q29udGVudCA9IHRl",
  "eHQ7CiAgd3JhcC5hcHBlbmRDaGlsZChkaXYpOwogIHdyYXAuc2Nyb2xsVG9wID0gd3JhcC5zY3JvbGxIZWlnaHQ7CiAgcmV0dXJuIGRpdjsKfQoKYXN5bmMgZnVuY3Rpb24gc2VuZEFpTWVzc2FnZShxdWVzdGlvbil7CiAgaWYoIXF1ZXN0aW9uLnRyaW0oKSB8fCBh",
  "aVN0YXRlLmJ1c3kpIHJldHVybjsKICBhcHBlbmRBaU1lc3NhZ2UoInVzZXIiLCBxdWVzdGlvbik7CiAgYWlTdGF0ZS5idXN5ID0gdHJ1ZTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlTZW5kQnRuIikuZGlzYWJsZWQgPSB0cnVlOwogIGNvbnN0IHBlbmRp",
  "bmcgPSBhcHBlbmRBaU1lc3NhZ2UoImFzc2lzdGFudCIsICJUaGlua2luZ+KApiIsICJwZW5kaW5nIik7CgogIHRyeXsKICAgIGlmKCFsaXZlQmFja2VuZEF2YWlsYWJsZSkgYXdhaXQgY2hlY2tMaXZlQmFja2VuZCgpOyAvLyBtYXkganVzdCBiZSB3YWtpbmcgZnJv",
  "bSBhIGNvbGQgc3RhcnQKICAgIGlmKCFsaXZlQmFja2VuZEF2YWlsYWJsZSkgdGhyb3cgbmV3IEVycm9yKCJCYWNrZW5kIG5vdCBjb25uZWN0ZWQg4oCUIHRoZSBBSSBhc3Npc3RhbnQgbmVlZHMgdGhlIGxpdmUgYmFja2VuZCBydW5uaW5nLiBJZiBpdCB3YXMganVz",
  "dCBpZGxlLCB0cnkgYWdhaW4gaW4gYSBtb21lbnQuIik7CiAgICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogICAgY29uc3QgaWQgPSBzZXRUaW1lb3V0KCgpPT5jdHJsLmFib3J0KCksIDIwMDAwKTsKICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZl",
  "dGNoKENPTkZJRy5BUElfQkFTRSArICIvY2hhdCIsIHsKICAgICAgbWV0aG9kOiAiUE9TVCIsCiAgICAgIGhlYWRlcnM6IHsiQ29udGVudC1UeXBlIjogImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHF1ZXN0",
  "aW9uOiBxdWVzdGlvbi50cmltKCksCiAgICAgICAgY29udGV4dDogYnVpbGRBaUNvbnRleHQoKSwKICAgICAgICBoaXN0b3J5OiBhaVN0YXRlLmhpc3Rvcnkuc2xpY2UoLTYpLAogICAgICB9KSwKICAgICAgc2lnbmFsOiBjdHJsLnNpZ25hbCwKICAgIH0pLmZpbmFs",
  "bHkoKCk9PmNsZWFyVGltZW91dChpZCkpOwoKICAgIGNvbnN0IGpzb24gPSBhd2FpdCByZXMuanNvbigpOwogICAgaWYoIXJlcy5vayB8fCAhanNvbi5zdWNjZXNzKSB0aHJvdyBuZXcgRXJyb3IoKGpzb24uZXJyb3IgJiYganNvbi5lcnJvci5tZXNzYWdlKSB8fCAo",
  "IlJlcXVlc3QgZmFpbGVkICgiICsgcmVzLnN0YXR1cyArICIpIikpOwoKICAgIHBlbmRpbmcucmVtb3ZlKCk7CiAgICBhcHBlbmRBaU1lc3NhZ2UoImFzc2lzdGFudCIsIGpzb24uZGF0YS5hbnN3ZXIpOwogICAgYWlTdGF0ZS5oaXN0b3J5LnB1c2goe3JvbGU6InVz",
  "ZXIiLCBjb250ZW50OiBxdWVzdGlvbi50cmltKCl9KTsKICAgIGFpU3RhdGUuaGlzdG9yeS5wdXNoKHtyb2xlOiJhc3Npc3RhbnQiLCBjb250ZW50OiBqc29uLmRhdGEuYW5zd2VyfSk7CiAgfWNhdGNoKGUpewogICAgcGVuZGluZy5yZW1vdmUoKTsKICAgIGFwcGVu",
  "ZEFpTWVzc2FnZSgiYXNzaXN0YW50IiwgIkNvdWxkbid0IGdldCBhIHJlc3BvbnNlOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpLCAiZXJyb3IiKTsKICB9ZmluYWxseXsKICAgIGFpU3RhdGUuYnVzeSA9IGZhbHNlOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5",
  "SWQoImFpU2VuZEJ0biIpLmRpc2FibGVkID0gZmFsc2U7CiAgfQp9CgpmdW5jdGlvbiB3aXJlQWlQYW5lbCgpewogIGNvbnN0IGZhYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaUZhYiIpOwogIGNvbnN0IHBhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5",
  "SWQoImFpUGFuZWwiKTsKICBjb25zdCBjbG9zZUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaUNsb3NlQnRuIik7CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlJbnB1dCIpOwogIGNvbnN0IHNlbmRCdG4gPSBkb2N1bWVu",
  "dC5nZXRFbGVtZW50QnlJZCgiYWlTZW5kQnRuIik7CgogIHBhbmVsLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOwoKICBmYWIuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgYWlTdGF0ZS5vcGVuID0gIWFpU3RhdGUub3BlbjsKICAgIHBhbmVsLmNs",
  "YXNzTGlzdC50b2dnbGUoImhpZGRlbiIsICFhaVN0YXRlLm9wZW4pOwogICAgaWYoYWlTdGF0ZS5vcGVuKXsgY2hlY2tBaVN0YXR1cygpOyBpbnB1dC5mb2N1cygpOyB9CiAgfSk7CiAgY2xvc2VCdG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAg",
  "YWlTdGF0ZS5vcGVuID0gZmFsc2U7CiAgICBwYW5lbC5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsKICB9KTsKICBjb25zdCBzZW5kID0gKCk9PnsKICAgIGNvbnN0IHEgPSBpbnB1dC52YWx1ZTsKICAgIGlucHV0LnZhbHVlID0gIiI7CiAgICBzZW5kQWlNZXNzYWdl",
  "KHEpOwogIH07CiAgc2VuZEJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIHNlbmQpOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24iLCAoZSk9PnsgaWYoZS5rZXkgPT09ICJFbnRlciIpIHNlbmQoKTsgfSk7Cn0KCi8vICJFeHBsYWluIHRoaXMg",
  "c3RvY2siIOKAlCBjYWxsZWQgZnJvbSByZW5kZXJEZXRhaWwgb25jZSBzdG9jayBkYXRhIGlzIGxvYWRlZC4KYXN5bmMgZnVuY3Rpb24gd2lyZUV4cGxhaW5CdXR0b24odGlja2VyKXsKICBjb25zdCBidG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXhwbGFp",
  "bkJ0biIpOwogIGNvbnN0IGNhcmQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXhwbGFpbkNhcmQiKTsKICBpZighYnRuKSByZXR1cm47CiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgYXN5bmMgKCk9PnsKICAgIGJ0bi5kaXNhYmxlZCA9IHRydWU7",
  "CiAgICBidG4udGV4dENvbnRlbnQgPSAiVGhpbmtpbmfigKYiOwogICAgY2FyZC5zdHlsZS5kaXNwbGF5ID0gImJsb2NrIjsKICAgIGNhcmQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImV4cGxhaW4taGVhZCI+PGRpdiBjbGFzcz0iYWktYXZhdGFyIj7inKY8L2Rp",
  "dj48ZGl2IHN0eWxlPSJmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7Ij5BSSBFeHBsYW5hdGlvbjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImV4cGxhaW4tdGV4dCI+JHtza2VsZXRvbkxpbmVzKDMpfTwvZGl2PmA7CiAgICB0cnl7CiAgICAgIGlmKCFsaXZl",
  "QmFja2VuZEF2YWlsYWJsZSkgYXdhaXQgY2hlY2tMaXZlQmFja2VuZCgpOyAvLyBtYXkganVzdCBiZSB3YWtpbmcgZnJvbSBhIGNvbGQgc3RhcnQKICAgICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSB0aHJvdyBuZXcgRXJyb3IoIkJhY2tlbmQgbm90IGNvbm5l",
  "Y3RlZC4gSWYgaXQgd2FzIGp1c3QgaWRsZSwgdHJ5IGFnYWluIGluIGEgbW9tZW50LiIpOwogICAgICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChgJHtDT05GSUcuQVBJX0JBU0V9L2V4cGxhaW4vJHtlbmNvZGVVUklDb21wb25lbnQodGlja2VyKX1g",
  "LCAyMDAwMCk7CiAgICAgIGNvbnN0IGpzb24gPSBhd2FpdCByLmpzb24oKTsKICAgICAgaWYoIXIub2sgfHwgIWpzb24uc3VjY2VzcykgdGhyb3cgbmV3IEVycm9yKChqc29uLmVycm9yICYmIGpzb24uZXJyb3IubWVzc2FnZSkgfHwgKCJSZXF1ZXN0IGZhaWxlZCAo",
  "IiArIHIuc3RhdHVzICsgIikiKSk7CiAgICAgIGNhcmQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImV4cGxhaW4taGVhZCI+PGRpdiBjbGFzcz0iYWktYXZhdGFyIj7inKY8L2Rpdj48ZGl2IHN0eWxlPSJmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7Ij5B",
  "SSBFeHBsYW5hdGlvbjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImV4cGxhaW4tdGV4dCI+JHtlc2NhcGVIdG1sKGpzb24uZGF0YS5leHBsYW5hdGlvbil9PC9kaXY+YDsKICAgIH1jYXRjaChlKXsKICAgICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZXhw",
  "bGFpbi1oZWFkIj48ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTNweDsiPkFJIEV4cGxhbmF0aW9uPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iZXhwbGFpbi10ZXh0IiBzdHlsZT0iY29s",
  "b3I6dmFyKC0tbmVnLXNvZnQpOyI+Q291bGRuJ3QgZ2VuZXJhdGUgYW4gZXhwbGFuYXRpb246ICR7ZXNjYXBlSHRtbChlICYmIGUubWVzc2FnZSB8fCBTdHJpbmcoZSkpfTwvZGl2PmA7CiAgICB9ZmluYWxseXsKICAgICAgYnRuLmRpc2FibGVkID0gZmFsc2U7CiAg",
  "ICAgIGJ0bi50ZXh0Q29udGVudCA9ICLinKYgRXhwbGFpbiB0aGlzIHN0b2NrIjsKICAgIH0KICB9KTsKfQoKc2V0QWN0aXZlTmF2KCJkYXNoYm9hcmQiKTsKd2lyZUFpUGFuZWwoKTsKY2hlY2tMaXZlQmFja2VuZCgpLmZpbmFsbHkocmVuZGVyKTsKc2V0SW50ZXJ2",
  "YWwoY2hlY2tMaXZlQmFja2VuZCwgNDUwMDApOwo8L3NjcmlwdD4KPC9ib2R5Pgo8L2h0bWw+Cg=="
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
