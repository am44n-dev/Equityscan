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
  "VVRfTVM6IDgwMDAsCn07CmxldCBsaXZlQmFja2VuZEF2YWlsYWJsZSA9IGZhbHNlOwpjb25zdCBNT0NLX0xBVEVOQ1kgPSA0MjA7CgpmdW5jdGlvbiBmZXRjaFdpdGhUaW1lb3V0KHVybCwgbXMpewogIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7",
  "CiAgY29uc3QgaWQgPSBzZXRUaW1lb3V0KCgpPT5jdHJsLmFib3J0KCksIG1zKTsKICByZXR1cm4gZmV0Y2godXJsLCB7c2lnbmFsOiBjdHJsLnNpZ25hbH0pLmZpbmFsbHkoKCk9PmNsZWFyVGltZW91dChpZCkpOwp9Cgphc3luYyBmdW5jdGlvbiBjaGVja0xpdmVC",
  "YWNrZW5kKCl7CiAgdHJ5ewogICAgY29uc3QgciA9IGF3YWl0IGZldGNoV2l0aFRpbWVvdXQoQ09ORklHLkFQSV9CQVNFICsgIi9oZWFsdGgiLCBDT05GSUcuTElWRV9USU1FT1VUX01TKTsKICAgIGxpdmVCYWNrZW5kQXZhaWxhYmxlID0gISEociAmJiByLm9rKTsK",
  "ICB9Y2F0Y2goZSl7CiAgICBsaXZlQmFja2VuZEF2YWlsYWJsZSA9IGZhbHNlOwogIH0KICB1cGRhdGVCYWNrZW5kQmFkZ2UoKTsKICByZXR1cm4gbGl2ZUJhY2tlbmRBdmFpbGFibGU7Cn0KCmZ1bmN0aW9uIHVwZGF0ZUJhY2tlbmRCYWRnZSgpewogIGNvbnN0IGVs",
  "ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJhY2tlbmRCYWRnZSIpOwogIGlmKCFlbCkgcmV0dXJuOwogIGVsLmNsYXNzTGlzdC50b2dnbGUoImxpdmUiLCBsaXZlQmFja2VuZEF2YWlsYWJsZSk7CiAgZWwucXVlcnlTZWxlY3RvcigiLmRvdC1saXZlIikuc3R5",
  "bGUuYmFja2dyb3VuZCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gInZhcigtLXBvcykiIDogInZhcigtLXRleHQtZmFpbnQpIjsKICBlbC5xdWVyeVNlbGVjdG9yKCJzcGFuOmxhc3QtY2hpbGQiKS50ZXh0Q29udGVudCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8g",
  "IkxpdmUgTlNFIERhdGEiIDogIkRlbW8gRGF0YSI7CiAgZWwudGl0bGUgPSBsaXZlQmFja2VuZEF2YWlsYWJsZQogICAgPyAiQ29ubmVjdGVkIHRvIHRoZSBFcXVpdHlTY2FuIGJhY2tlbmQg4oCUIHByaWNlcyBhcmUgcmVhbCBOU0UgcXVvdGVzLiIKICAgIDogIkJh",
  "Y2tlbmQgbm90IHJlYWNoYWJsZSBhdCAiICsgQ09ORklHLkFQSV9CQVNFICsgIiDigJQgc2hvd2luZyBkZXRlcm1pbmlzdGljIGRlbW8gZGF0YS4iOwp9CgpmdW5jdGlvbiBtYXBCYWNrZW5kVG9Gcm9udGVuZChkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChk",
  "LnN5bWJvbCk7CiAgY29uc3QgYmFzaXMgPSBkLmN1cnJlbnRQcmljZSB8fCAxMDAwOwogIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkLCAyMCwgMC4wMDUsIGJhc2lzKTsKICBjb25zdCBrbm93bkRlZiA9IFVOSVZFUlNFLmZpbmQodT0+dS50PT09ZC5zeW1i",
  "b2wpOwogIHJldHVybiB7CiAgICB0OiBkLnN5bWJvbCwKICAgIG5hbWU6IGQuY29tcGFueU5hbWUgfHwgKGtub3duRGVmICYmIGtub3duRGVmLm5hbWUpIHx8IGQuc3ltYm9sLAogICAgZXhjaDogZC5leGNoYW5nZSB8fCAiTlNFIiwKICAgIC8vIFRoZSBsaXZlIGJh",
  "Y2tlbmQncyBpbmR1c3RyeSBsYWJlbCBkb2Vzbid0IHJlbGlhYmx5IG1hdGNoIG91ciBmaWx0ZXIKICAgIC8vIGRyb3Bkb3duJ3Mgdm9jYWJ1bGFyeSAob3IgbWF5IGJlIG1pc3NpbmcpLCBzbyBwcmVmZXIgb3VyIGtub3duIG1hcHBpbmcKICAgIC8vIGZvciBmaWx0",
  "ZXJpbmcgcHVycG9zZXMgYW5kIG9ubHkgZmFsbCBiYWNrIHRvIHRoZSBiYWNrZW5kJ3MgcmF3IHZhbHVlLgogICAgc2VjdG9yOiAoa25vd25EZWYgJiYga25vd25EZWYuc2VjdG9yKSB8fCBkLnNlY3RvciB8fCAi4oCUIiwKICAgIHByaWNlOiBkLmN1cnJlbnRQcmlj",
  "ZSwKICAgIGNoYW5nZTogZC5jaGFuZ2UsCiAgICBwY3Q6IGQucGVyY2VudENoYW5nZSwKICAgIG1hcmtldENhcDogZC5tYXJrZXRDYXAsCiAgICB2b2x1bWU6IGQudm9sdW1lLAogICAgaGlnaDUyOiBkLndlZWs1MkhpZ2gsCiAgICBsb3c1MjogZC53ZWVrNTJMb3cs",
  "CiAgICBvcGVuOiBkLm9wZW4sCiAgICBkYXlIaWdoOiBkLmRheUhpZ2gsCiAgICBkYXlMb3c6IGQuZGF5TG93LAogICAgc2VyaWVzLAogICAgbGl2ZTogdHJ1ZSwKICAgIGRhdGFTdGF0dXM6IGQuZGF0YVN0YXR1cywKICB9Owp9Cgphc3luYyBmdW5jdGlvbiBsaXZl",
  "RmV0Y2hTdG9jayh0aWNrZXIpewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KGAke0NPTkZJRy5BUElfQkFTRX0vc3RvY2svJHtlbmNvZGVVUklDb21wb25lbnQodGlja2VyKX1gLCBDT05GSUcuTElWRV9USU1FT1VUX01TKTsKICBpZighci5vaykg",
  "dGhyb3cgbmV3IEVycm9yKCJiYWNrZW5kIHN0YXR1cyAiK3Iuc3RhdHVzKTsKICBjb25zdCBqc29uID0gYXdhaXQgci5qc29uKCk7CiAgaWYoIWpzb24uc3VjY2VzcyB8fCAhanNvbi5kYXRhKSB0aHJvdyBuZXcgRXJyb3IoImJhY2tlbmQgcGF5bG9hZCBlcnJvciIp",
  "OwogIHJldHVybiBtYXBCYWNrZW5kVG9Gcm9udGVuZChqc29uLmRhdGEpOwp9Cgphc3luYyBmdW5jdGlvbiBsaXZlRmV0Y2hNYW55KHRpY2tlcnMpewogIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNlLmFsbFNldHRsZWQodGlja2Vycy5tYXAobGl2ZUZldGNo",
  "U3RvY2spKTsKICByZXR1cm4gc2V0dGxlZC5maWx0ZXIocz0+cy5zdGF0dXM9PT0iZnVsZmlsbGVkIikubWFwKHM9PnMudmFsdWUpOwp9Cgpjb25zdCBVTklWRVJTRSA9IFsKICB7dDoiVENTIiwgbmFtZToiVGF0YSBDb25zdWx0YW5jeSBTZXJ2aWNlcyIsIGV4Y2g6",
  "Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjM4NDJ9LAogIHt0OiJSRUxJQU5DRSIsIG5hbWU6IlJlbGlhbmNlIEluZHVzdHJpZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkVuZXJneSIsIGJhc2U6Mjk1MX0sCiAge3Q6IkhERkNCQU5LIiwgbmFtZToi",
  "SERGQyBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxNjg3fSwKICB7dDoiSU5GWSIsIG5hbWU6IkluZm9zeXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IklUIFNlcnZpY2VzIiwgYmFzZToxODQxfSwKICB7dDoiSUNJQ0lCQU5LIiwgbmFt",
  "ZToiSUNJQ0kgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTI2NH0sCiAge3Q6IkJIQVJUSUFSVEwiLCBuYW1lOiJCaGFydGkgQWlydGVsIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJUZWxlY29tIiwgYmFzZToxNjk4fSwKICB7dDoiU0JJ",
  "TiIsIG5hbWU6IlN0YXRlIEJhbmsgb2YgSW5kaWEiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjgyNH0sCiAge3Q6IklUQyIsIG5hbWU6IklUQyBMaW1pdGVkIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGTUNHIiwgYmFzZTo0Nzh9LAogIHt0OiJM",
  "VCIsIG5hbWU6IkxhcnNlbiAmIFRvdWJybyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSW5mcmFzdHJ1Y3R1cmUiLCBiYXNlOjM2MTJ9LAogIHt0OiJLT1RBS0JBTksiLCBuYW1lOiJLb3RhayBNYWhpbmRyYSBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5n",
  "IiwgYmFzZToxNzg5fSwKICB7dDoiSElORFVOSUxWUiIsIG5hbWU6IkhpbmR1c3RhbiBVbmlsZXZlciIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRk1DRyIsIGJhc2U6MjU0N30sCiAge3Q6IkFYSVNCQU5LIiwgbmFtZToiQXhpcyBCYW5rIiwgZXhjaDoiTlNFIiwgc2Vj",
  "dG9yOiJCYW5raW5nIiwgYmFzZToxMTQyfSwKICB7dDoiQkFKRklOQU5DRSIsIG5hbWU6IkJhamFqIEZpbmFuY2UiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZpbmFuY2lhbCBTZXJ2aWNlcyIsIGJhc2U6NzI4NH0sCiAge3Q6Ik1BUlVUSSIsIG5hbWU6Ik1hcnV0aSBT",
  "dXp1a2kiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkF1dG9tb2JpbGUiLCBiYXNlOjEyNDgwfSwKICB7dDoiQVNJQU5QQUlOVCIsIG5hbWU6IkFzaWFuIFBhaW50cyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQ29uc3VtZXIgR29vZHMiLCBiYXNlOjI4OTR9LAogIHt0OiJX",
  "SVBSTyIsIG5hbWU6IldpcHJvIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6NTEyfSwKICB7dDoiVElUQU4iLCBuYW1lOiJUaXRhbiBDb21wYW55IiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJDb25zdW1lciBHb29kcyIsIGJhc2U6MzQyMX0s",
  "CiAge3Q6IlNVTlBIQVJNQSIsIG5hbWU6IlN1biBQaGFybWFjZXV0aWNhbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUGhhcm1hIiwgYmFzZToxNzg2fSwKICB7dDoiTlRQQyIsIG5hbWU6Ik5UUEMgTGltaXRlZCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUG93ZXIiLCBi",
  "YXNlOjM2Mn0sCiAge3Q6IkFEQU5JRU5UIiwgbmFtZToiQWRhbmkgRW50ZXJwcmlzZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkRpdmVyc2lmaWVkIiwgYmFzZToyOTE0fSwKICB7dDoiVUxUUkFDRU1DTyIsIG5hbWU6IlVsdHJhVGVjaCBDZW1lbnQiLCBleGNoOiJO",
  "U0UiLCBzZWN0b3I6IkNlbWVudCIsIGJhc2U6MTEyNDB9LAogIHt0OiJQT1dFUkdSSUQiLCBuYW1lOiJQb3dlciBHcmlkIENvcnAiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBvd2VyIiwgYmFzZTozMTh9LAogIHt0OiJORVNUTEVJTkQiLCBuYW1lOiJOZXN0bGUgSW5k",
  "aWEiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ciLCBiYXNlOjIyNzh9LAogIHt0OiJUQVRBTU9UT1JTIiwgbmFtZToiVGF0YSBNb3RvcnMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkF1dG9tb2JpbGUiLCBiYXNlOjk0OH0sCiAge3Q6IkpTV1NURUVMIiwgbmFtZToi",
  "SlNXIFN0ZWVsIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJNZXRhbHMiLCBiYXNlOjEwMTJ9LApdOwoKZnVuY3Rpb24gc2VlZGVkUmFuZChzZWVkKXsKICBsZXQgeCA9IE1hdGguc2luKHNlZWQpICogMTAwMDA7CiAgcmV0dXJuIHggLSBNYXRoLmZsb29yKHgpOwp9CmZ1",
  "bmN0aW9uIGRheU9mWWVhcigpewogIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7CiAgcmV0dXJuIE1hdGguZmxvb3IoKG5vdyAtIG5ldyBEYXRlKG5vdy5nZXRGdWxsWWVhcigpLDAsMCkpIC8gODY0MDAwMDApOwp9CmZ1bmN0aW9uIGdlblNlcmllcyhzZWVkLCBwb2lu",
  "dHMsIHZvbGF0aWxpdHksIGJhc2UpewogIGNvbnN0IGFyciA9IFtdOwogIGxldCB2ID0gYmFzZTsKICBmb3IobGV0IGk9MDtpPHBvaW50cztpKyspewogICAgY29uc3QgciA9IHNlZWRlZFJhbmQoc2VlZCAqIDk3LjcgKyBpICogMTMuMzEpIC0gMC41OwogICAgdiA9",
  "IHYgKiAoMSArIHIgKiB2b2xhdGlsaXR5KTsKICAgIGFyci5wdXNoKHYpOwogIH0KICByZXR1cm4gYXJyOwp9CmZ1bmN0aW9uIHRpY2tlclNlZWQodGlja2VyKXsKICBsZXQgaCA9IDA7CiAgZm9yKGxldCBpPTA7aTx0aWNrZXIubGVuZ3RoO2krKykgaCA9IChoKjMx",
  "ICsgdGlja2VyLmNoYXJDb2RlQXQoaSkpICUgMTAwMDAwOwogIHJldHVybiBoICsgZGF5T2ZZZWFyKCk7Cn0KCmZ1bmN0aW9uIHdpdGhMYXRlbmN5KHZhbHVlKXsKICByZXR1cm4gbmV3IFByb21pc2UocmVzID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzKHZhbHVlKSwg",
  "TU9DS19MQVRFTkNZKSk7Cn0KCmNvbnN0IEFQSSA9IHsKICBhc3luYyBmZXRjaEluZGljZXMoKXsKICAgIGNvbnN0IGRlZnMgPSBbCiAgICAgIHtjb2RlOiJOSUZUWSA1MCIsIGZ1bGw6Ik5TRSBOaWZ0eSA1MCBJbmRleCIsIGJhc2U6MjQ4MTJ9LAogICAgICB7Y29k",
  "ZToiU0VOU0VYIiwgZnVsbDoiQlNFIFNlbnNleCIsIGJhc2U6ODE2NDB9LAogICAgICB7Y29kZToiTklGVFkgQkFOSyIsIGZ1bGw6Ik5TRSBCYW5rIE5pZnR5IEluZGV4IiwgYmFzZTo1MjE0MH0sCiAgICBdOwogICAgY29uc3Qgb3V0ID0gZGVmcy5tYXAoZD0+ewog",
  "ICAgICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkLmNvZGUpOwogICAgICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjQsIDAuMDA2LCBkLmJhc2UpOwogICAgICBjb25zdCBsYXN0ID0gc2VyaWVzW3Nlcmllcy5sZW5ndGgtMV07CiAgICAgIGNvbnN0",
  "IHByZXYgPSBkLmJhc2U7CiAgICAgIGNvbnN0IGNoZyA9IGxhc3QgLSBwcmV2OwogICAgICBjb25zdCBwY3QgPSAoY2hnL3ByZXYpKjEwMDsKICAgICAgcmV0dXJuIHsuLi5kLCB2YWx1ZTpsYXN0LCBjaGFuZ2U6Y2hnLCBwY3QsIHNlcmllc307CiAgICB9KTsKICAg",
  "IHJldHVybiB3aXRoTGF0ZW5jeShvdXQpOwogIH0sCgogIGFzeW5jIHNlYXJjaFN0b2NrcyhxdWVyeSl7CiAgICBjb25zdCBxID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7CiAgICBpZighcSkgcmV0dXJuIHdpdGhMYXRlbmN5KFtdKTsKICAgIGNvbnN0IG1h",
  "dGNoZXMgPSBVTklWRVJTRS5maWx0ZXIocyA9PiBzLnQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSB8fCBzLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSkuc2xpY2UoMCw4KTsKICAgIGlmKGxpdmVCYWNrZW5kQXZhaWxhYmxlKXsKICAgICAgY29uc3Qg",
  "bGl2ZSA9IGF3YWl0IGxpdmVGZXRjaE1hbnkobWF0Y2hlcy5tYXAobT0+bS50KSk7CiAgICAgIGlmKGxpdmUubGVuZ3RoKSByZXR1cm4gbGl2ZTsKICAgIH0KICAgIHJldHVybiB3aXRoTGF0ZW5jeShtYXRjaGVzLm1hcChzID0+IGRlY29yYXRlU3RvY2socykpKTsK",
  "ICB9LAoKICBhc3luYyBmZXRjaFNjcmVlbmVyUmVzdWx0cyhmaWx0ZXJzKXsKICAgIGxldCBsaXN0OwogICAgaWYobGl2ZUJhY2tlbmRBdmFpbGFibGUpewogICAgICBjb25zdCBsaXZlID0gYXdhaXQgbGl2ZUZldGNoTWFueShVTklWRVJTRS5tYXAocz0+cy50KSk7",
  "CiAgICAgIGxpc3QgPSBsaXZlLmxlbmd0aCA/IGxpdmUgOiBVTklWRVJTRS5tYXAocz0+ZGVjb3JhdGVTdG9jayhzKSk7CiAgICB9IGVsc2UgewogICAgICBsaXN0ID0gVU5JVkVSU0UubWFwKGRlY29yYXRlU3RvY2spOwogICAgICBhd2FpdCB3aXRoTGF0ZW5jeShu",
  "dWxsKTsKICAgIH0KICAgIGlmKGZpbHRlcnMucXVlcnkpewogICAgICBjb25zdCBxID0gZmlsdGVycy5xdWVyeS50b0xvd2VyQ2FzZSgpOwogICAgICBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy50LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSl8fHMubmFtZS50b0xv",
  "d2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTsKICAgIH0KICAgIGlmKGZpbHRlcnMuc2VjdG9yICYmIGZpbHRlcnMuc2VjdG9yICE9PSAiQWxsIikgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMuc2VjdG9yPT09ZmlsdGVycy5zZWN0b3IpOwogICAgaWYoZmlsdGVycy5taW5Q",
  "cmljZSkgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucHJpY2U+PWZpbHRlcnMubWluUHJpY2UpOwogICAgaWYoZmlsdGVycy5tYXhQcmljZSkgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucHJpY2U8PWZpbHRlcnMubWF4UHJpY2UpOwogICAgaWYoZmlsdGVycy5kaXJl",
  "Y3Rpb249PT0iZ2FpbmVycyIpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnBjdD49MCk7CiAgICBpZihmaWx0ZXJzLmRpcmVjdGlvbj09PSJsb3NlcnMiKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q8MCk7CiAgICByZXR1cm4gbGlzdDsKICB9LAoKICBhc3lu",
  "YyBmZXRjaFN0b2NrKHRpY2tlcil7CiAgICBpZihsaXZlQmFja2VuZEF2YWlsYWJsZSl7CiAgICAgIHRyeXsgcmV0dXJuIGF3YWl0IGxpdmVGZXRjaFN0b2NrKHRpY2tlcik7IH0KICAgICAgY2F0Y2goZSl7IC8qIGZhbGwgdGhyb3VnaCB0byBtb2NrICovIH0KICAg",
  "IH0KICAgIGNvbnN0IGRlZiA9IFVOSVZFUlNFLmZpbmQocz0+cy50PT09dGlja2VyKTsKICAgIGlmKCFkZWYpIHJldHVybiB3aXRoTGF0ZW5jeShudWxsKTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShkZWNvcmF0ZVN0b2NrKGRlZiwgdHJ1ZSkpOwogIH0sCgogIGFz",
  "eW5jIGZldGNoU3RvY2tIaXN0b3J5KHRpY2tlciwgcmFuZ2UpewogICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQodGlja2VyKTsKICAgIGNvbnN0IGNmZyA9IHsKICAgICAgIjFEIjp7cG9pbnRzOjc4LCB2b2w6MC4wMDE2fSwKICAgICAgIjFXIjp7cG9pbnRzOjM1",
  "LCB2b2w6MC4wMDN9LAogICAgICAiMU0iOntwb2ludHM6MjIsIHZvbDowLjAwOH0sCiAgICAgICIzTSI6e3BvaW50czo2NSwgdm9sOjAuMDA5fSwKICAgICAgIjZNIjp7cG9pbnRzOjEzMCwgdm9sOjAuMDEwfSwKICAgICAgIjFZIjp7cG9pbnRzOjI1MCwgdm9sOjAu",
  "MDEyfSwKICAgIH1bcmFuZ2VdIHx8IHtwb2ludHM6NjAsIHZvbDowLjAwOH07CiAgICBjb25zdCBkZWYgPSBVTklWRVJTRS5maW5kKHM9PnMudD09PXRpY2tlcik7CiAgICBjb25zdCBiYXNlID0gZGVmID8gZGVmLmJhc2UgKiAwLjk0IDogMTAwMDsKICAgIGNvbnN0",
  "IHNlcmllcyA9IGdlblNlcmllcyhzZWVkICsgcmFuZ2UubGVuZ3RoLCBjZmcucG9pbnRzLCBjZmcudm9sLCBiYXNlKTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShzZXJpZXMpOwogIH0sCn07CgpmdW5jdGlvbiBkZWNvcmF0ZVN0b2NrKGRlZiwgZGV0YWlsZWQpewog",
  "IGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKGRlZi50KTsKICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjAsIDAuMDA1LCBkZWYuYmFzZSk7CiAgY29uc3QgcHJpY2UgPSBzZXJpZXNbc2VyaWVzLmxlbmd0aC0xXTsKICBjb25zdCBwcmV2Q2xvc2UgPSBk",
  "ZWYuYmFzZTsKICBjb25zdCBjaGFuZ2UgPSBwcmljZSAtIHByZXZDbG9zZTsKICBjb25zdCBwY3QgPSAoY2hhbmdlL3ByZXZDbG9zZSkqMTAwOwogIGNvbnN0IG1hcmtldENhcCA9IHByaWNlICogKHNlZWRlZFJhbmQoc2VlZCoyLjEpKjQwMDArODAwKSAqIDFlNjsK",
  "ICBjb25zdCB2b2x1bWUgPSBNYXRoLnJvdW5kKHNlZWRlZFJhbmQoc2VlZCozLjMpKjhfMDAwXzAwMCArIDIwMF8wMDApOwogIGNvbnN0IGhpZ2g1MiA9IHByaWNlICogKDEgKyBzZWVkZWRSYW5kKHNlZWQqNC40KSowLjM1ICsgMC4wNSk7CiAgY29uc3QgbG93NTIg",
  "PSBwcmljZSAqICgxIC0gc2VlZGVkUmFuZChzZWVkKjUuNSkqMC4zMCAtIDAuMDQpOwogIGNvbnN0IG91dCA9IHsKICAgIHQ6ZGVmLnQsIG5hbWU6ZGVmLm5hbWUsIGV4Y2g6ZGVmLmV4Y2gsIHNlY3RvcjpkZWYuc2VjdG9yLAogICAgcHJpY2UsIGNoYW5nZSwgcGN0",
  "LCBtYXJrZXRDYXAsIHZvbHVtZSwgaGlnaDUyLCBsb3c1Miwgc2VyaWVzLAogIH07CiAgaWYoZGV0YWlsZWQpewogICAgb3V0Lm9wZW4gPSBwcmljZSAtIGNoYW5nZSowLjY7CiAgICBvdXQuZGF5SGlnaCA9IE1hdGgubWF4KHByaWNlLCBvdXQub3BlbikgKiAoMStz",
  "ZWVkZWRSYW5kKHNlZWQqNi42KSowLjAxMik7CiAgICBvdXQuZGF5TG93ID0gTWF0aC5taW4ocHJpY2UsIG91dC5vcGVuKSAqICgxLXNlZWRlZFJhbmQoc2VlZCo3LjcpKjAuMDEyKTsKICB9CiAgcmV0dXJuIG91dDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBGT1JNQVQgSEVMUEVSUwogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9uIGZtdElOUih2",
  "LCBkZWNpbWFscyl7CiAgaWYodj09PXVuZGVmaW5lZHx8dj09PW51bGx8fGlzTmFOKHYpKSByZXR1cm4gIuKAlCI7CiAgY29uc3QgZCA9IGRlY2ltYWxzPT09dW5kZWZpbmVkPzI6ZGVjaW1hbHM7CiAgcmV0dXJuICLigrkiICsgdi50b0xvY2FsZVN0cmluZygiZW4t",
  "SU4iLCB7bWluaW11bUZyYWN0aW9uRGlnaXRzOmQsIG1heGltdW1GcmFjdGlvbkRpZ2l0czpkfSk7Cn0KZnVuY3Rpb24gZm10Q29tcGFjdCh2KXsKICBpZih2PT09dW5kZWZpbmVkfHx2PT09bnVsbHx8aXNOYU4odikpIHJldHVybiAi4oCUIjsKICBpZih2Pj0xZTEy",
  "KSByZXR1cm4gIuKCuSIrKHYvMWUxMikudG9GaXhlZCgyKSsiVCI7CiAgaWYodj49MWU5KSByZXR1cm4gIuKCuSIrKHYvMWU5KS50b0ZpeGVkKDIpKyJCIjsKICBpZih2Pj0xZTcpIHJldHVybiAi4oK5Iisodi8xZTcpLnRvRml4ZWQoMikrIkNyIjsKICBpZih2Pj0x",
  "ZTUpIHJldHVybiAi4oK5Iisodi8xZTUpLnRvRml4ZWQoMikrIkwiOwogIHJldHVybiAi4oK5Iit2LnRvRml4ZWQoMCk7Cn0KZnVuY3Rpb24gZm10Vm9sKHYpewogIGlmKHY+PTFlNykgcmV0dXJuICh2LzFlNykudG9GaXhlZCgyKSsiQ3IiOwogIGlmKHY+PTFlNSkg",
  "cmV0dXJuICh2LzFlNSkudG9GaXhlZCgyKSsiTCI7CiAgaWYodj49MWUzKSByZXR1cm4gKHYvMWUzKS50b0ZpeGVkKDEpKyJLIjsKICByZXR1cm4gU3RyaW5nKHYpOwp9CmZ1bmN0aW9uIHBjdFN0cihwKXsgcmV0dXJuIChwPj0wPyIrIjoiIikgKyBwLnRvRml4ZWQo",
  "MikgKyAiJSI7IH0KZnVuY3Rpb24gY2hnU3RyKGMpeyByZXR1cm4gKGM+PTA/IisiOiIiKSArIGZtdElOUihNYXRoLmFicyhjKSk7IH0KZnVuY3Rpb24gZXNjYXBlSHRtbChzKXsKICByZXR1cm4gU3RyaW5nKHMpLnJlcGxhY2UoL1smPD4iJ10vZywgbSA9PiAoeyIm",
  "IjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzM5OyJ9W21dKSk7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU1RBVEUKICAgPT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCBzdGF0ZSA9IHsKICB2aWV3OiAiZGFzaGJvYXJkIiwKICB3YXRjaGxpc3Q6IFtdLAogIGRldGFpbFRpY2tlcjogIlRDUyIsCiAgZGV0YWls",
  "UmFuZ2U6ICIxTSIsCiAgc2NyZWVuZXJGaWx0ZXJzOiB7cXVlcnk6IiIsIHNlY3RvcjoiQWxsIiwgbWluUHJpY2U6MCwgbWF4UHJpY2U6MTUwMDAsIGRpcmVjdGlvbjoiYWxsIn0sCiAgc2NyZWVuZXJTb3J0OiB7a2V5OiJtYXJrZXRDYXAiLCBkaXI6ImRlc2MifSwK",
  "fTsKCnRyeXsKICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCJlcXVpdHlzY2FuX3dhdGNobGlzdCIpOwogIGlmKHNhdmVkKSBzdGF0ZS53YXRjaGxpc3QgPSBKU09OLnBhcnNlKHNhdmVkKTsKfWNhdGNoKGUpe30KZnVuY3Rpb24gcGVyc2lzdFdh",
  "dGNobGlzdCgpewogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oImVxdWl0eXNjYW5fd2F0Y2hsaXN0IiwgSlNPTi5zdHJpbmdpZnkoc3RhdGUud2F0Y2hsaXN0KSk7IH1jYXRjaChlKXt9Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU1BBUktMSU5FIChpbmxpbmUgU1ZHKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9uIHNwYXJrbGluZVNWRyhz",
  "ZXJpZXMsIHBvc2l0aXZlLCB3LCBoKXsKICB3ID0gd3x8MTIwOyBoID0gaHx8MzY7CiAgaWYoIXNlcmllcyB8fCBzZXJpZXMubGVuZ3RoPDIpIHJldHVybiAiIjsKICBjb25zdCBtaW4gPSBNYXRoLm1pbiguLi5zZXJpZXMpLCBtYXggPSBNYXRoLm1heCguLi5zZXJp",
  "ZXMpOwogIGNvbnN0IHJhbmdlID0gKG1heC1taW4pfHwxOwogIGNvbnN0IHN0ZXAgPSB3LyhzZXJpZXMubGVuZ3RoLTEpOwogIGNvbnN0IHB0cyA9IHNlcmllcy5tYXAoKHYsaSk9PltpKnN0ZXAsIGggLSAoKHYtbWluKS9yYW5nZSkqaCowLjg2IC0gaCowLjA3XSk7",
  "CiAgY29uc3QgcGF0aCA9IHB0cy5tYXAoKHAsaSk9PihpPT09MD8iTSI6IkwiKStwWzBdLnRvRml4ZWQoMSkrIiwiK3BbMV0udG9GaXhlZCgxKSkuam9pbigiICIpOwogIGNvbnN0IGFyZWFQYXRoID0gcGF0aCArIGAgTCR7d30sJHtofSBMMCwke2h9IFpgOwogIGNv",
  "bnN0IGNvbG9yID0gcG9zaXRpdmUgPyAidmFyKC0tcG9zKSIgOiAidmFyKC0tbmVnKSI7CiAgY29uc3QgZ2lkID0gInNnIitNYXRoLnJhbmRvbSgpLnRvU3RyaW5nKDM2KS5zbGljZSgyLDkpOwogIHJldHVybiBgPHN2ZyB2aWV3Qm94PSIwIDAgJHt3fSAke2h9IiB3",
  "aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBwcmVzZXJ2ZUFzcGVjdFJhdGlvPSJub25lIj4KICAgIDxkZWZzPjxsaW5lYXJHcmFkaWVudCBpZD0iJHtnaWR9IiB4MT0iMCIgeTE9IjAiIHgyPSIwIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCUiIHN0b3At",
  "Y29sb3I9IiR7Y29sb3J9IiBzdG9wLW9wYWNpdHk9IjAuMzUiLz4KICAgICAgPHN0b3Agb2Zmc2V0PSIxMDAlIiBzdG9wLWNvbG9yPSIke2NvbG9yfSIgc3RvcC1vcGFjaXR5PSIwIi8+CiAgICA8L2xpbmVhckdyYWRpZW50PjwvZGVmcz4KICAgIDxwYXRoIGQ9IiR7",
  "YXJlYVBhdGh9IiBmaWxsPSJ1cmwoIyR7Z2lkfSkiIHN0cm9rZT0ibm9uZSIvPgogICAgPHBhdGggZD0iJHtwYXRofSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIke2NvbG9yfSIgc3Ryb2tlLXdpZHRoPSIxLjYiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxp",
  "bmVqb2luPSJyb3VuZCIvPgogIDwvc3ZnPmA7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgQU1CSUVOVCBERUNPUkFUSVZFIExJTkVTIChkcmF3biBvbmNlKQogICA9PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCihmdW5jdGlvbiBkcmF3QW1iaWVudExpbmVzKCl7CiAgY29uc3Qgc3ZnID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFtYmllbnRMaW5lcyIpOwogIGNv",
  "bnN0IHcgPSAxNDAwLCBoID0gODAwOwogIHN2Zy5zZXRBdHRyaWJ1dGUoInZpZXdCb3giLCBgMCAwICR7d30gJHtofWApOwogIGxldCBodG1sID0gIiI7CiAgZm9yKGxldCBpPTA7aTwzO2krKyl7CiAgICBjb25zdCBzZWVkID0gaSoxNyszOwogICAgY29uc3QgcHRz",
  "ID0gW107CiAgICBjb25zdCBuID0gMTI7CiAgICBmb3IobGV0IGo9MDtqPD1uO2orKyl7CiAgICAgIGNvbnN0IHggPSAoai9uKSp3OwogICAgICBjb25zdCB5ID0gaCowLjI1ICsgaSoxMzAgKyAoc2VlZGVkUmFuZChzZWVkK2opLTAuNSkqOTA7CiAgICAgIHB0cy5w",
  "dXNoKFt4LHldKTsKICAgIH0KICAgIGNvbnN0IHBhdGggPSBwdHMubWFwKChwLGlkeCk9PihpZHg9PT0wPyJNIjoiTCIpK3BbMF0udG9GaXhlZCgwKSsiLCIrcFsxXS50b0ZpeGVkKDApKS5qb2luKCIgIik7CiAgICBjb25zdCBjb2xvcnMgPSBbIiM0QzdERkYiLCIj",
  "OEI2QkYwIiwiIzMxRDVFRSJdOwogICAgaHRtbCArPSBgPHBhdGggZD0iJHtwYXRofSIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIke2NvbG9yc1tpJTNdfSIgc3Ryb2tlLXdpZHRoPSIxIiBvcGFjaXR5PSIwLjEwIi8+YDsKICB9CiAgc3ZnLmlubmVySFRNTCA9IGh0bWw7",
  "Cn0pKCk7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEhFQURFUiBCRUhBVklPUgogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09ICovCmNvbnN0IHRvcGJhciA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0b3BiYXIiKTsKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInNjcm9sbCIsICgpPT57CiAgdG9wYmFyLmNsYXNzTGlzdC50b2dnbGUoInNjcm9sbGVkIiwgd2luZG93",
  "LnNjcm9sbFkgPiA4KTsKfSk7CgpmdW5jdGlvbiBzZXRBY3RpdmVOYXYodmlldyl7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiI21haW5OYXYgYnV0dG9uLCAjYm90dG9tTmF2IGJ1dHRvbiIpLmZvckVhY2goYj0+ewogICAgYi5jbGFzc0xpc3QudG9nZ2xl",
  "KCJhY3RpdmUiLCBiLmRhdGFzZXQudmlldz09PXZpZXcpOwogIH0pOwp9CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYWluTmF2IikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCBlPT57CiAgY29uc3QgYnRuID0gZS50YXJnZXQuY2xvc2VzdCgiYnV0dG9uW2Rh",
  "dGEtdmlld10iKTsKICBpZihidG4pIG5hdmlnYXRlKGJ0bi5kYXRhc2V0LnZpZXcpOwp9KTsKZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJvdHRvbU5hdiIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgZT0+ewogIGNvbnN0IGJ0biA9IGUudGFyZ2V0LmNsb3Nl",
  "c3QoImJ1dHRvbltkYXRhLXZpZXddIik7CiAgaWYoYnRuKSBuYXZpZ2F0ZShidG4uZGF0YXNldC52aWV3KTsKfSk7CgpmdW5jdGlvbiBuYXZpZ2F0ZSh2aWV3LCB0aWNrZXIpewogIHN0YXRlLnZpZXcgPSB2aWV3OwogIGlmKHRpY2tlcikgc3RhdGUuZGV0YWlsVGlj",
  "a2VyID0gdGlja2VyOwogIHNldEFjdGl2ZU5hdih2aWV3ID09PSAiZGV0YWlsIiA/ICJtYXJrZXRzIiA6IHZpZXcpOwogIHdpbmRvdy5zY3JvbGxUbyh7dG9wOjAsIGJlaGF2aW9yOiB3aW5kb3cubWF0Y2hNZWRpYSgnKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246IHJl",
  "ZHVjZSknKS5tYXRjaGVzID8gImF1dG8iIDogInNtb290aCJ9KTsKICByZW5kZXIoKTsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBNQVJLRVQgU1RBVFVTIChJU1QgYnVzaW5l",
  "c3MgaG91cnMsIHB1cmVseSBwcmVzZW50YXRpb25hbCkKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwooZnVuY3Rpb24gbWFya2V0U3RhdHVzKCl7CiAgY29uc3Qgbm93ID0gbmV3IERh",
  "dGUoKTsKICBjb25zdCBpc3RIb3VyID0gKG5vdy5nZXRVVENIb3VycygpKzUpJTI0ICsgKG5vdy5nZXRVVENNaW51dGVzKCkrMzA+PTYwPzE6MCk7CiAgY29uc3QgbWlucyA9IChub3cuZ2V0VVRDTWludXRlcygpKzMwKSU2MDsKICBjb25zdCB0b3RhbE1pbiA9ICgo",
  "bm93LmdldFVUQ0hvdXJzKCkrNSklMjQpKjYwICsgbWluczsKICBjb25zdCBvcGVuID0gdG90YWxNaW4gPj0gNTU1ICYmIHRvdGFsTWluIDw9IDkzMDsgLy8gOToxNSAtIDE1OjMwIElTVAogIHNldFRleHQoIm1hcmtldFN0YXR1c1RleHQiLCBvcGVuID8gIk1hcmtl",
  "dCBPcGVuIiA6ICJNYXJrZXQgQ2xvc2VkIik7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvcigiLmRvdC1saXZlIikuc3R5bGUuYmFja2dyb3VuZCA9IG9wZW4gPyAidmFyKC0tcG9zKSIgOiAidmFyKC0tdGV4dC1mYWludCkiOwp9KSgpOwoKLyogPT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBSRU5ERVI6IFJPT1QKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCByb290",
  "ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1haW5Sb290Iik7CgpmdW5jdGlvbiByZW5kZXIoKXsKICBpZihzdGF0ZS52aWV3ID09PSAiZGFzaGJvYXJkIikgcmVuZGVyRGFzaGJvYXJkKCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAic2NyZWVuZXIiKSBy",
  "ZW5kZXJTY3JlZW5lcigpOwogIGVsc2UgaWYoc3RhdGUudmlldyA9PT0gIm1hcmtldHMiKSByZW5kZXJNYXJrZXRzKCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAid2F0Y2hsaXN0IikgcmVuZGVyV2F0Y2hsaXN0KCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09",
  "PSAiZGV0YWlsIikgcmVuZGVyRGV0YWlsKCk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gREFTSEJPQVJEIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyRGFzaGJvYXJkKCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNz",
  "PSJ2aWV3IiBpZD0iZGFzaFZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXQgT3ZlcnZpZXc8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlJlYWwtdGltZSBpbmRleCBzbmFwc2hvdDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFz",
  "cz0iaGVyby1yb3ciIGlkPSJpbmRpY2VzUm93Ij4KICAgICAgICAke3NrZWxldG9uQ2FyZHMoMyl9CiAgICAgIDwvZGl2PgoKICAgICAgJHtzZWFyY2hCbG9jaygpfQoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+TWFya2V0IEJyZWFkdGg8L2gy",
  "PjxzcGFuIGNsYXNzPSJzdWIiPkFkdmFuY2VycyB2cyBkZWNsaW5lcnMsIGZ1bGwgdW5pdmVyc2U8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGJyZWFkdGgtY2FyZCIgaWQ9ImJyZWFkdGhDYXJkIiBzdHlsZT0icGFkZGluZzoxOHB4IDIycHg7",
  "bWFyZ2luLWJvdHRvbTozNHB4OyI+JHtza2VsZXRvbkxpbmVzKDIpfTwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+VG9wIE1vdmVyczwvaDI+PHNwYW4gY2xhc3M9InN1YiI+QnkgYWJzb2x1dGUgY2hhbmdlIHRvZGF5PC9zcGFuPjwv",
  "ZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIGdsYXNzIiBpZD0ibW92ZXJzVGFibGVXcmFwIj48ZGl2IHN0eWxlPSJwYWRkaW5nOjIwcHg7Ij4ke3NrZWxldG9uTGluZXMoNil9PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0b2NrLWNhcmRz",
  "IiBpZD0ibW92ZXJzQ2FyZHMiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKICB3aXJlU2VhcmNoKCk7CgogIHRyeXsKICAgIGNvbnN0IGluZGljZXMgPSBhd2FpdCBBUEkuZmV0Y2hJbmRpY2VzKCk7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiaW5kaWNlc1Jv",
  "dyIpLmlubmVySFRNTCA9IGluZGljZXMubWFwKGluZGV4Q2FyZEhUTUwpLmpvaW4oIiIpOwogICAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiLmluZGV4LXNwYXJrIikuZm9yRWFjaCgoZWwsaSk9PnsKICAgICAgZWwuaW5uZXJIVE1MID0gc3BhcmtsaW5lU1ZH",
  "KGluZGljZXNbaV0uc2VyaWVzLCBpbmRpY2VzW2ldLmNoYW5nZT49MCk7CiAgICB9KTsKICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiaW5kaWNlc1JvdyIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJNYXJrZXQgZGF0YSB0ZW1w",
  "b3JhcmlseSB1bmF2YWlsYWJsZSIsICJXZSBjb3VsZG4ndCByZWFjaCB0aGUgaW5kaWNlcyBmZWVkLiBQbGVhc2UgdHJ5IGFnYWluIHNob3J0bHkuIik7CiAgfQoKICB0cnl7CiAgICBjb25zdCBmdWxsID0gYXdhaXQgQVBJLmZldGNoU2NyZWVuZXJSZXN1bHRzKHt9",
  "KTsKICAgIHRyeXsKICAgICAgcmVuZGVyQnJlYWR0aChmdWxsKTsKICAgIH1jYXRjaChlKXsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJyZWFkdGhDYXJkIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIkJyZWFkdGggZGF0YSB1bmF2YWlsYWJs",
  "ZSIsICJDb3VsZG4ndCBjb21wdXRlIGFkdmFuY2VycyB2cyBkZWNsaW5lcnMuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgICAgc2hvd0Vycm9yQmFubmVyKCJyZW5kZXJCcmVhZHRoIGZhaWxlZDogIiArIChlICYmIGUubWVzc2FnZSB8fCBl",
  "KSk7CiAgICB9CiAgICB0cnl7CiAgICAgIGNvbnN0IG1vdmVycyA9IGZ1bGwuc2xpY2UoKS5zb3J0KChhLGIpPT5NYXRoLmFicyhiLnBjdCktTWF0aC5hYnMoYS5wY3QpKS5zbGljZSgwLDgpOwogICAgICByZW5kZXJUYWJsZUludG8oIm1vdmVyc1RhYmxlV3JhcCIs",
  "ICJtb3ZlcnNDYXJkcyIsIG1vdmVycywge2tleToicGN0IiwgZGlyOiJkZXNjIn0sIGZhbHNlKTsKICAgIH1jYXRjaChlKXsKICAgICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1vdmVyc1RhYmxlV3JhcCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJV",
  "bmFibGUgdG8gcmV0cmlldmUgbW92ZXJzIiwgIlNvbWV0aGluZyB3ZW50IHdyb25nIGxvYWRpbmcgdGhpcyBsaXN0LiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7CiAgICAgIHNob3dFcnJvckJhbm5lcigibW92ZXJzIHRhYmxlIHJlbmRlciBmYWls",
  "ZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogICAgfQogIH1jYXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtb3ZlcnNUYWJsZVdyYXAiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIG1vdmVy",
  "cyIsICJTb21ldGhpbmcgd2VudCB3cm9uZyBsb2FkaW5nIHRoaXMgbGlzdC4gKCIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkgKyAiKSIpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJyZWFkdGhDYXJkIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwo",
  "IkJyZWFkdGggZGF0YSB1bmF2YWlsYWJsZSIsICJDb3VsZG4ndCBjb21wdXRlIGFkdmFuY2VycyB2cyBkZWNsaW5lcnMuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIHNob3dFcnJvckJhbm5lcigiZmV0Y2hTY3JlZW5lclJlc3VsdHMgZmFp",
  "bGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICB9Cn0KCmZ1bmN0aW9uIHJlbmRlckJyZWFkdGgobGlzdCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYnJlYWR0aENhcmQiKTsKICBpZighZWwgfHwgIWxpc3QubGVuZ3RoKXsg",
  "aWYoZWwpIGVsLmlubmVySFRNTCA9IGVtcHR5U3RhdGVIVE1MKCJObyBicmVhZHRoIGRhdGEiLCAiTm8gc3RvY2tzIHdlcmUgcmV0dXJuZWQgdG8gY29tcHV0ZSB0aGlzIGZyb20uIik7IHJldHVybjsgfQogIGNvbnN0IGFkdmFuY2VycyA9IGxpc3QuZmlsdGVyKHM9",
  "PnMucGN0PjApLmxlbmd0aDsKICBjb25zdCBkZWNsaW5lcnMgPSBsaXN0LmZpbHRlcihzPT5zLnBjdDwwKS5sZW5ndGg7CiAgY29uc3QgZmxhdCA9IGxpc3QubGVuZ3RoIC0gYWR2YW5jZXJzIC0gZGVjbGluZXJzOwogIGNvbnN0IHRvdGFsID0gbGlzdC5sZW5ndGg7",
  "CiAgY29uc3QgYWR2UGN0ID0gKGFkdmFuY2Vycy90b3RhbCkqMTAwLCBkZWNQY3QgPSAoZGVjbGluZXJzL3RvdGFsKSoxMDAsIGZsYXRQY3QgPSAoZmxhdC90b3RhbCkqMTAwOwogIGVsLmlubmVySFRNTCA9IGAKICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDtq",
  "dXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpiYXNlbGluZTttYXJnaW4tYm90dG9tOjEycHg7ZmxleC13cmFwOndyYXA7Z2FwOjhweDsiPgogICAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7Z2FwOjIwcHg7Ij4KICAgICAgICA8ZGl2",
  "PjxzcGFuIGNsYXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjIwcHg7Y29sb3I6dmFyKC0tcG9zLXNvZnQpOyI+JHthZHZhbmNlcnN9PC9zcGFuPiA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEycHg7",
  "Ij5hZHZhbmNpbmc8L3NwYW4+PC9kaXY+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMHB4O2NvbG9yOnZhcigtLW5lZy1zb2Z0KTsiPiR7ZGVjbGluZXJzfTwvc3Bhbj4gPHNwYW4gc3R5bGU9",
  "ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4OyI+ZGVjbGluaW5nPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjBweDtjb2xvcjp2YXIoLS10ZXh0LW1p",
  "ZCk7Ij4ke2ZsYXR9PC9zcGFuPiA8c3BhbiBzdHlsZT0iY29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEycHg7Ij51bmNoYW5nZWQ8L3NwYW4+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJmb250LXNpemU6MTEuNXB4O2NvbG9yOnZh",
  "cigtLXRleHQtZmFpbnQpOyI+b2YgJHt0b3RhbH0gdHJhY2tlZCBzdG9ja3M8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2hlaWdodDoxMHB4O2JvcmRlci1yYWRpdXM6NnB4O292ZXJmbG93OmhpZGRlbjtiYWNrZ3JvdW5kOnZh",
  "cigtLWJnLWJhc2UpOyI+CiAgICAgIDxkaXYgc3R5bGU9IndpZHRoOiR7YWR2UGN0fSU7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tcG9zKSx2YXIoLS1wb3Mtc29mdCkpOyI+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9IndpZHRoOiR7Zmxh",
  "dFBjdH0lO2JhY2tncm91bmQ6dmFyKC0tdGV4dC1mYWludCk7Ij48L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0id2lkdGg6JHtkZWNQY3R9JTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZyx2YXIoLS1uZWctc29mdCksdmFyKC0tbmVnKSk7Ij48L2Rpdj4K",
  "ICAgIDwvZGl2PgogIGA7Cn0KCmZ1bmN0aW9uIGluZGV4Q2FyZEhUTUwoaWR4KXsKICBjb25zdCBwb3NpdGl2ZSA9IGlkeC5jaGFuZ2UgPj0gMDsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImdsYXNzIGluZGV4LWNhcmQiPgogICAgPGRpdiBjbGFzcz0icm93MSI+",
  "CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtbmFtZSI+JHtpZHguY29kZX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJpbmRleC1mdWxsIj4ke2lkeC5mdWxsfTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaW5kZXgt",
  "YmFkZ2UgJHtwb3NpdGl2ZT8ncG9zJzonbmVnJ30iPgogICAgICAgICR7cG9zaXRpdmU/J+KWsic6J+KWvCd9ICR7cGN0U3RyKGlkeC5wY3QpfQogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciI+JHtpZHgu",
  "dmFsdWUudG9Mb2NhbGVTdHJpbmcoImVuLUlOIix7bWF4aW11bUZyYWN0aW9uRGlnaXRzOjJ9KX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LWNoYW5nZSAke3Bvc2l0aXZlPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihpZHguY2hhbmdlKX08L2Rp",
  "dj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXNwYXJrIj48L2Rpdj4KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiBza2VsZXRvbkNhcmRzKG4pewogIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6bn0pLm1hcCgoKT0+YDxkaXYgY2xhc3M9ImdsYXNzIHNrZWwtY2FyZCBz",
  "a2VsIj48L2Rpdj5gKS5qb2luKCIiKTsKfQpmdW5jdGlvbiBza2VsZXRvbkxpbmVzKG4pewogIHJldHVybiBBcnJheS5mcm9tKHtsZW5ndGg6bn0pLm1hcCgoKT0+YDxkaXYgY2xhc3M9InNrZWwgc2tlbC1saW5lIiBzdHlsZT0id2lkdGg6JHs2MCtNYXRoLnJhbmRv",
  "bSgpKjM1fSUiPjwvZGl2PmApLmpvaW4oIiIpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNFQVJDSCAtLS0tLS0tLS0tLS0tLS0tICovCmZ1bmN0aW9uIHNlYXJjaEJsb2NrKCl7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJzZWFyY2gtd3JhcCIgc3R5bGU9Im1h",
  "cmdpbi10b3A6OHB4OyI+CiAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtYm94IGdsYXNzIiBpZD0ic2VhcmNoQm94Ij4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0",
  "cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTEiIGN5PSIxMSIgcj0iNyIvPjxwYXRoIGQ9Ik0yMSAyMWwtNC4zLTQuMyIvPjwvc3ZnPgogICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9InNlYXJjaElucHV0IiBwbGFjZWhvbGRlcj0iU2VhcmNoIHN0",
  "b2NrcyBieSBuYW1lIG9yIHRpY2tlcuKApiIgYXV0b2NvbXBsZXRlPSJvZmYiPgogICAgICA8a2JkIGNsYXNzPSJrc2hvcnRjdXQiPi88L2tiZD4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0ic2VhcmNoLWRyb3AgZ2xhc3MiIGlkPSJzZWFyY2hEcm9wIiBzdHls",
  "ZT0iZGlzcGxheTpub25lOyI+PC9kaXY+CiAgPC9kaXY+YDsKfQoKbGV0IHNlYXJjaERlYm91bmNlOwpmdW5jdGlvbiB3aXJlU2VhcmNoKCl7CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoSW5wdXQiKTsKICBjb25zdCBib3gg",
  "PSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoQm94Iik7CiAgY29uc3QgZHJvcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hEcm9wIik7CiAgaWYoIWlucHV0KSByZXR1cm47CgogIGRvY3VtZW50LmFkZEV2ZW50TGlzdGVuZXIoImtleWRv",
  "d24iLCAoZSk9PnsKICAgIGlmKGUua2V5ID09PSAiLyIgJiYgZG9jdW1lbnQuYWN0aXZlRWxlbWVudCAhPT0gaW5wdXQpewogICAgICBlLnByZXZlbnREZWZhdWx0KCk7CiAgICAgIGlucHV0LmZvY3VzKCk7CiAgICB9CiAgICBpZihlLmtleSA9PT0gIkVzY2FwZSIp",
  "eyBpbnB1dC5ibHVyKCk7IGRyb3Auc3R5bGUuZGlzcGxheT0ibm9uZSI7IGJveC5jbGFzc0xpc3QucmVtb3ZlKCJmb2N1c2VkIik7IH0KICB9KTsKCiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiZm9jdXMiLCAoKT0+IGJveC5jbGFzc0xpc3QuYWRkKCJmb2N1c2Vk",
  "IikpOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImJsdXIiLCAoKT0+IHNldFRpbWVvdXQoKCk9PnsgYm94LmNsYXNzTGlzdC5yZW1vdmUoImZvY3VzZWQiKTsgZHJvcC5zdHlsZS5kaXNwbGF5PSJub25lIjsgfSwgMTYwKSk7CgogIGlucHV0LmFkZEV2ZW50TGlz",
  "dGVuZXIoImlucHV0IiwgKCk9PnsKICAgIGNsZWFyVGltZW91dChzZWFyY2hEZWJvdW5jZSk7CiAgICBjb25zdCBxID0gaW5wdXQudmFsdWU7CiAgICBpZighcS50cmltKCkpeyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyByZXR1cm47IH0KICAgIGRyb3Auc3R5",
  "bGUuZGlzcGxheT0iYmxvY2siOwogICAgZHJvcC5pbm5lckhUTUwgPSBgPGRpdiBzdHlsZT0icGFkZGluZzoxNHB4IDE2cHg7Ij4ke3NrZWxldG9uTGluZXMoMyl9PC9kaXY+YDsKICAgIHNlYXJjaERlYm91bmNlID0gc2V0VGltZW91dChhc3luYyAoKT0+ewogICAg",
  "ICBjb25zdCByZXN1bHRzID0gYXdhaXQgQVBJLnNlYXJjaFN0b2NrcyhxKTsKICAgICAgaWYoIXJlc3VsdHMubGVuZ3RoKXsKICAgICAgICBkcm9wLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJzZWFyY2gtZW1wdHkiPk5vIHN0b2NrcyBtYXRjaCDigJwke2VzY2Fw",
  "ZUh0bWwocSl94oCdPC9kaXY+YDsKICAgICAgICByZXR1cm47CiAgICAgIH0KICAgICAgZHJvcC5pbm5lckhUTUwgPSByZXN1bHRzLm1hcCgocyxpKT0+YAogICAgICAgIDxkaXYgY2xhc3M9InNlYXJjaC1yb3ciIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjI4",
  "fW1zIiBkYXRhLXRpY2tlcj0iJHtzLnR9Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InNyLWxlZnQiPgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJzci10aWNrZXIiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgICAg",
  "PGRpdiBjbGFzcz0ic3ItbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgICAgICAgPGRpdiBjbGFzcz0ic3ItbWV0YSI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAg",
  "ICAgICAgPGRpdiBjbGFzcz0ic3ItcHJpY2UgdGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIGApLmpvaW4oIiIpOwogICAgICBkcm9wLnF1ZXJ5U2VsZWN0b3JBbGwoIi5zZWFyY2gtcm93IikuZm9yRWFjaChyb3c9",
  "PnsKICAgICAgICByb3cuYWRkRXZlbnRMaXN0ZW5lcigibW91c2Vkb3duIiwgKCk9PnsKICAgICAgICAgIG5hdmlnYXRlKCJkZXRhaWwiLCByb3cuZGF0YXNldC50aWNrZXIpOwogICAgICAgIH0pOwogICAgICB9KTsKICAgIH0sIDI2MCk7CiAgfSk7Cn0KZG9jdW1l",
  "bnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaFRvZ2dsZUJ0biIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hJbnB1dCIpOwogIGlmKGlucHV0KSBpbnB1dC5mb2N1cygp",
  "OwogIGVsc2UgbmF2aWdhdGUoImRhc2hib2FyZCIpOwp9KTsKCi8qIC0tLS0tLS0tLS0tLS0tLS0gU0hBUkVEIFRBQkxFIFJFTkRFUiAtLS0tLS0tLS0tLS0tLS0tICovCmZ1bmN0aW9uIHJlbmRlclRhYmxlSW50byh3cmFwSWQsIGNhcmRzSWQsIGxpc3QsIHNvcnQs",
  "IHNob3dTZWN0b3JDb2wpewogIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCh3cmFwSWQpOwogIGNvbnN0IGNhcmRzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoY2FyZHNJZCk7CiAgaWYoIWxpc3QubGVuZ3RoKXsKICAgIHdyYXAuaW5uZXJI",
  "VE1MID0gZW1wdHlTdGF0ZUhUTUwoIk5vIHN0b2NrcyBtYXRjaCB5b3VyIGZpbHRlcnMiLCAiVHJ5IHdpZGVuaW5nIHlvdXIgcHJpY2UgcmFuZ2Ugb3IgY2xlYXJpbmcgYSBmaWx0ZXIuIik7CiAgICBpZihjYXJkcykgY2FyZHMuaW5uZXJIVE1MID0gIiI7CiAgICBy",
  "ZXR1cm47CiAgfQogIGNvbnN0IHNvcnRlZCA9IHNvcnRTdG9ja3MobGlzdCwgc29ydCk7CgogIHdyYXAuaW5uZXJIVE1MID0gYAogICAgPHRhYmxlIGNsYXNzPSJzdG9jay10YWJsZSI+CiAgICAgIDx0aGVhZD48dHI+CiAgICAgICAgPHRoPjwvdGg+CiAgICAgICAg",
  "PHRoIGRhdGEta2V5PSJuYW1lIj5Db21wYW55PHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9InByaWNlIj5QcmljZTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRo",
  "IGRhdGEta2V5PSJjaGFuZ2UiPkNoYW5nZTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJwY3QiPkNoYW5nZSAlPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGgg",
  "ZGF0YS1rZXk9Im1hcmtldENhcCI+TWFya2V0IENhcDxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJ2b2x1bWUiPlZvbHVtZTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAg",
  "ICAgPHRoIGRhdGEta2V5PSJoaWdoNTIiPjUyVyBIaWdoPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImxvdzUyIj41MlcgTG93PHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAg",
  "ICAgPC90cj48L3RoZWFkPgogICAgICA8dGJvZHk+CiAgICAgICAgJHtzb3J0ZWQubWFwKChzLGkpPT5zdG9ja1Jvd0hUTUwocyxpKSkuam9pbigiIil9CiAgICAgIDwvdGJvZHk+CiAgICA8L3RhYmxlPgogIGA7CiAgd3JhcC5xdWVyeVNlbGVjdG9yQWxsKCJ0aFtk",
  "YXRhLWtleV0iKS5mb3JFYWNoKHRoPT57CiAgICB0aC5jbGFzc0xpc3QudG9nZ2xlKCJzb3J0ZWQiLCB0aC5kYXRhc2V0LmtleT09PXNvcnQua2V5KTsKICAgIGlmKHRoLmRhdGFzZXQua2V5PT09c29ydC5rZXkpeyBjb25zdCBpbmQgPSB0aC5xdWVyeVNlbGVjdG9y",
  "KCIuc29ydC1pbmQiKTsgaWYoaW5kKSBpbmQudGV4dENvbnRlbnQgPSBzb3J0LmRpcj09PSJkZXNjIj8i4pa+Ijoi4pa0IjsgfQogICAgdGguYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgICBjb25zdCBrZXkgPSB0aC5kYXRhc2V0LmtleTsKICAg",
  "ICAgY29uc3QgbmV3RGlyID0gKHNvcnQua2V5PT09a2V5ICYmIHNvcnQuZGlyPT09ImRlc2MiKSA/ICJhc2MiIDogImRlc2MiOwogICAgICBjb25zdCBuZXdTb3J0ID0ge2tleSwgZGlyOm5ld0Rpcn07CiAgICAgIGlmKHdyYXBJZD09PSJzY3JlZW5lclRhYmxlV3Jh",
  "cCIpIHN0YXRlLnNjcmVlbmVyU29ydCA9IG5ld1NvcnQ7CiAgICAgIHJlbmRlclRhYmxlSW50byh3cmFwSWQsIGNhcmRzSWQsIGxpc3QsIG5ld1NvcnQsIHNob3dTZWN0b3JDb2wpOwogICAgfSk7CiAgfSk7CiAgd2lyZVJvd0ludGVyYWN0aW9ucyh3cmFwKTsKCiAg",
  "aWYoY2FyZHMpewogICAgY2FyZHMuaW5uZXJIVE1MID0gc29ydGVkLm1hcCgocyxpKT0+c3RvY2tDYXJkSFRNTChzLGkpKS5qb2luKCIiKTsKICAgIHdpcmVSb3dJbnRlcmFjdGlvbnMoY2FyZHMpOwogIH0KfQoKZnVuY3Rpb24gc29ydFN0b2NrcyhsaXN0LCBzb3J0",
  "KXsKICByZXR1cm4gbGlzdC5zbGljZSgpLnNvcnQoKGEsYik9PnsKICAgIGxldCBhdj1hW3NvcnQua2V5XSwgYnY9Yltzb3J0LmtleV07CiAgICBpZihzb3J0LmtleT09PSJuYW1lIil7IGF2PWEubmFtZTsgYnY9Yi5uYW1lOyByZXR1cm4gc29ydC5kaXI9PT0iYXNj",
  "Ij8gYXYubG9jYWxlQ29tcGFyZShidikgOiBidi5sb2NhbGVDb21wYXJlKGF2KTsgfQogICAgcmV0dXJuIHNvcnQuZGlyPT09ImFzYyIgPyBhdi1idiA6IGJ2LWF2OwogIH0pOwp9CgpmdW5jdGlvbiBzdG9ja1Jvd0hUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBj",
  "dD49MDsKICBjb25zdCBpbldhdGNoID0gc3RhdGUud2F0Y2hsaXN0LmluY2x1ZGVzKHMudCk7CiAgcmV0dXJuIGAKICA8dHIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjJ9bXMiPgogICAgPHRkIG9uY2xpY2s9ImV2ZW50",
  "LnN0b3BQcm9wYWdhdGlvbigpIj4KICAgICAgPGJ1dHRvbiBjbGFzcz0ic3Rhci1idG4gJHtpbldhdGNoPydhY3RpdmUnOicnfSIgZGF0YS1zdGFyPSIke3MudH0iIHRpdGxlPSIke2luV2F0Y2g/J1JlbW92ZSBmcm9tIHdhdGNobGlzdCc6J0FkZCB0byB3YXRjaGxp",
  "c3QnfSI+CiAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9IiR7aW5XYXRjaD8nY3VycmVudENvbG9yJzonbm9uZSd9IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgMTcuM2wtNi4xNiAzLjYgMS42",
  "NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICA8L2J1dHRvbj4KICAgIDwvdGQ+CiAgICA8dGQ+CiAgICAgIDxkaXYgY2xhc3M9ImNlbGwtY29tcGFueSI+CiAgICAgICAgPGRp",
  "diBjbGFzcz0iY2VsbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgPGRpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNz",
  "PSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIi",
  "PjxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8ncG9zJzonbmVnJ30iPiR7Y2hnU3RyKHMuY2hhbmdlKX08L3NwYW4+PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+PHNwYW4gY2xhc3M9ImNoYW5nZS1waWxsICR7cG9zPydwb3MnOiduZWcnfSI+JHtw",
  "Y3RTdHIocy5wY3QpfTwvc3Bhbj48L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdENvbXBhY3Qocy5tYXJrZXRDYXApfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10Vm9sKHMudm9sdW1lKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1",
  "bGFyIj4ke2ZtdElOUihzLmhpZ2g1Mil9PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRJTlIocy5sb3c1Mil9PC90ZD4KICA8L3RyPmA7Cn0KCmZ1bmN0aW9uIHN0b2NrQ2FyZEhUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICBjb25z",
  "dCBpbldhdGNoID0gc3RhdGUud2F0Y2hsaXN0LmluY2x1ZGVzKHMudCk7CiAgcmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJnbGFzcyBzdG9jay1jYXJkIiBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSoyNn1tcyI+CiAgICA8ZGl2",
  "IGNsYXNzPSJsZWZ0Ij4KICAgICAgPGRpdiBjbGFzcz0iY2VsbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Im5hbWUtYmxvY2siPgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktbmFtZSI+JHtlc2NhcGVI",
  "dG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InJpZ2h0Ij4KICAgICAgPGRpdiBjbGFzcz0icHJpY2Ug",
  "dGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICAgIDxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8ncG9zJzonbmVnJ30iIHN0eWxlPSJtYXJnaW4tdG9wOjRweDsiPiR7cGN0U3RyKHMucGN0KX08L3NwYW4+CiAgICA8L2Rpdj4KICA8L2Rp",
  "dj5gOwp9CgpmdW5jdGlvbiB3aXJlUm93SW50ZXJhY3Rpb25zKGNvbnRhaW5lcil7CiAgY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoInRyW2RhdGEtdGlja2VyXSwgLnN0b2NrLWNhcmRbZGF0YS10aWNrZXJdIikuZm9yRWFjaChlbD0+ewogICAgZWwuYWRkRXZl",
  "bnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+IG5hdmlnYXRlKCJkZXRhaWwiLCBlbC5kYXRhc2V0LnRpY2tlcikpOwogIH0pOwogIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1zdGFyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0",
  "ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTsKICAgICAgdG9nZ2xlV2F0Y2goYnRuLmRhdGFzZXQuc3Rhcik7CiAgICAgIGJ0bi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiKTsKICAgICAgYnRuLnF1ZXJ5U2VsZWN0b3IoInN2",
  "ZyIpLnNldEF0dHJpYnV0ZSgiZmlsbCIsIGJ0bi5jbGFzc0xpc3QuY29udGFpbnMoImFjdGl2ZSIpID8gImN1cnJlbnRDb2xvciIgOiAibm9uZSIpOwogICAgfSk7CiAgfSk7Cn0KCmZ1bmN0aW9uIHRvZ2dsZVdhdGNoKHRpY2tlcil7CiAgY29uc3QgaWR4ID0gc3Rh",
  "dGUud2F0Y2hsaXN0LmluZGV4T2YodGlja2VyKTsKICBpZihpZHg+PTApIHN0YXRlLndhdGNobGlzdC5zcGxpY2UoaWR4LDEpOwogIGVsc2Ugc3RhdGUud2F0Y2hsaXN0LnB1c2godGlja2VyKTsKICBwZXJzaXN0V2F0Y2hsaXN0KCk7Cn0KCi8qIC0tLS0tLS0tLS0t",
  "LS0tLS0gU0NSRUVORVIgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJTY3JlZW5lcigpewogIGNvbnN0IHNlY3RvcnMgPSBbIkFsbCIsIC4uLkFycmF5LmZyb20obmV3IFNldChVTklWRVJTRS5tYXAocz0+cy5zZWN0b3IpKSldOwogIHJv",
  "b3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPlNjcmVlbmVyPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5GaWx0ZXIgdGhlIG1hcmtldCBvbiB5b3VyIHRlcm1zPC9zcGFuPjwvZGl2",
  "PgoKICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgZmlsdGVycy1iYXIiPgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIiBzdHlsZT0ibWluLXdpZHRoOjIwMHB4OyI+CiAgICAgICAgICA8bGFiZWw+U2VhcmNoPC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCB0",
  "eXBlPSJ0ZXh0IiBpZD0iZlF1ZXJ5IiBwbGFjZWhvbGRlcj0iVGlja2VyIG9yIGNvbXBhbnnigKYiIHZhbHVlPSIke2VzY2FwZUh0bWwoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnF1ZXJ5KX0iPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRl",
  "ci1jaGlwIj4KICAgICAgICAgIDxsYWJlbD5TZWN0b3I8L2xhYmVsPgogICAgICAgICAgPHNlbGVjdCBpZD0iZlNlY3RvciI+JHtzZWN0b3JzLm1hcChzPT5gPG9wdGlvbiAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3I9PT1zPydzZWxlY3RlZCc6Jyd9PiR7",
  "c308L29wdGlvbj5gKS5qb2luKCIiKX08L3NlbGVjdD4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCI+CiAgICAgICAgICA8bGFiZWw+TWF4IFByaWNlIDxzcGFuIGNsYXNzPSJyYW5nZS12YWwiIGlkPSJmUHJpY2VWYWwiPiR7",
  "Zm10SU5SKHN0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZSwwKX08L3NwYW4+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJyYW5nZSIgY2xhc3M9InJhbmdlLXNsaWRlciIgaWQ9ImZNYXhQcmljZSIgbWluPSI1MDAiIG1heD0iMTUwMDAiIHN0ZXA9",
  "IjI1MCIgdmFsdWU9IiR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFByaWNlfSI+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiIHN0eWxlPSJtaW4td2lkdGg6MTkwcHg7Ij4KICAgICAgICAgIDxsYWJlbD5EaXJlY3Rpb248",
  "L2xhYmVsPgogICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWdyb3VwIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nYWxsJz8nYWN0aXZlJzonJ30iIGRhdGEtZGlyPSJhbGwi",
  "PkFsbDwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUtYnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbj09PSdnYWluZXJzJz8nYWN0aXZlJzonJ30iIGRhdGEtZGlyPSJnYWluZXJzIj5HYWluZXJzPC9kaXY+CiAgICAgICAgICAg",
  "IDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuZGlyZWN0aW9uPT09J2xvc2Vycyc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRpcj0ibG9zZXJzIj5Mb3NlcnM8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAg",
  "ICAgIDxkaXYgY2xhc3M9InJlc2V0LWZpbHRlcnMiIGlkPSJyZXNldEZpbHRlcnMiPlJlc2V0IGZpbHRlcnM8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMiBpZD0ic2NyZWVuZXJDb3VudCI+UmVzdWx0czwvaDI+",
  "PHNwYW4gY2xhc3M9InN1YiI+U29ydGVkIGJ5IG1hcmtldCBjYXA8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJzY3JlZW5lclRhYmxlV3JhcCI+PGRpdiBzdHlsZT0icGFkZGluZzoyMHB4OyI+JHtza2VsZXRvbkxp",
  "bmVzKDgpfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdG9jay1jYXJkcyIgaWQ9InNjcmVlbmVyQ2FyZHMiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZRdWVyeSIpLmFkZEV2ZW50TGlzdGVuZXIoImlu",
  "cHV0IiwgZGVib3VuY2UoZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7IHJ1blNjcmVlbmVyKCk7CiAgfSwgMjYwKSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZTZWN0b3IiKS5hZGRFdmVudExpc3RlbmVy",
  "KCJjaGFuZ2UiLCBlPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yID0gZS50YXJnZXQudmFsdWU7IHJ1blNjcmVlbmVyKCk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZNYXhQcmljZSIpLmFkZEV2ZW50TGlzdGVuZXIoImlucHV0",
  "IiwgZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFByaWNlID0gTnVtYmVyKGUudGFyZ2V0LnZhbHVlKTsKICAgIHNldFRleHQoImZQcmljZVZhbCIsIGZtdElOUihzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UsMCkpOwogICAgcnVuU2NyZWVu",
  "ZXIoKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1kaXJdIikuZm9yRWFjaChidG49PnsKICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb24gPSBi",
  "dG4uZGF0YXNldC5kaXI7CiAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLWRpcl0iKS5mb3JFYWNoKGI9PmIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYj09PWJ0bikpOwogICAgICBydW5TY3JlZW5lcigpOwogICAgfSk7CiAgfSk7CiAg",
  "ZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInJlc2V0RmlsdGVycyIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycyA9IHtxdWVyeToiIiwgc2VjdG9yOiJBbGwiLCBtaW5QcmljZTowLCBtYXhQcmljZToxNTAw",
  "MCwgZGlyZWN0aW9uOiJhbGwifTsKICAgIHJlbmRlclNjcmVlbmVyKCk7CiAgfSk7CgogIHJ1blNjcmVlbmVyKCk7Cn0KCmZ1bmN0aW9uIGRlYm91bmNlKGZuLCBtcyl7CiAgbGV0IGg7CiAgcmV0dXJuICguLi5hcmdzKT0+eyBjbGVhclRpbWVvdXQoaCk7IGg9c2V0",
  "VGltZW91dCgoKT0+Zm4oLi4uYXJncyksIG1zKTsgfTsKfQoKYXN5bmMgZnVuY3Rpb24gcnVuU2NyZWVuZXIoKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNjcmVlbmVyVGFibGVXcmFwIik7CiAgaWYoIXdyYXAgfHwgc3RhdGUudmll",
  "dyAhPT0gInNjcmVlbmVyIikgcmV0dXJuOyAvLyB2aWV3IG5vdCBhY3RpdmUg4oCUIG5vdGhpbmcgdG8gdXBkYXRlCiAgd3JhcC5zdHlsZS5vcGFjaXR5ID0gIjAuNTUiOwogIHRyeXsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJl",
  "c3VsdHMoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzKTsKICAgIGlmKHN0YXRlLnZpZXcgIT09ICJzY3JlZW5lciIpIHJldHVybjsgLy8gbmF2aWdhdGVkIGF3YXkgd2hpbGUgdGhlIGZldGNoIHdhcyBpbiBmbGlnaHQKICAgIHNldFRleHQoInNjcmVlbmVyQ291bnQiLCBg",
  "UmVzdWx0cyAoJHtyZXN1bHRzLmxlbmd0aH0pYCk7CiAgICAvLyBPbmUtdGltZSBkaWFnbm9zdGljOiBpZiBhIHNlY3RvciBmaWx0ZXIgeWllbGRzIHplcm8sIHNob3cgZXhhY3RseSB3aGF0CiAgICAvLyBzZWN0b3IgdmFsdWVzIGFjdHVhbGx5IGV4aXN0IGluIHRo",
  "ZSBsb2FkZWQgZGF0YSBzbyBhIG1pc21hdGNoICh0eXBvLAogICAgLy8gY2FzaW5nLCBzdGFsZSBmaWVsZCkgaXMgdmlzaWJsZSBpbnN0ZWFkIG9mIGd1ZXNzZWQgYXQuCiAgICBpZihyZXN1bHRzLmxlbmd0aCA9PT0gMCAmJiBzdGF0ZS5zY3JlZW5lckZpbHRlcnMu",
  "c2VjdG9yICYmIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3IgIT09ICJBbGwiKXsKICAgICAgdHJ5ewogICAgICAgIGNvbnN0IHVuZmlsdGVyZWQgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoey4uLnN0YXRlLnNjcmVlbmVyRmlsdGVycywgc2Vj",
  "dG9yOiJBbGwifSk7CiAgICAgICAgY29uc3Qgc2VlblNlY3RvcnMgPSBBcnJheS5mcm9tKG5ldyBTZXQodW5maWx0ZXJlZC5tYXAocz0+cy5zZWN0b3IpKSk7CiAgICAgICAgc2hvd0Vycm9yQmFubmVyKGBERUJVRzogMCByZXN1bHRzIGZvciBzZWN0b3IgIiR7c3Rh",
  "dGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3Rvcn0iLiAke3VuZmlsdGVyZWQubGVuZ3RofSBzdG9ja3MgbG9hZGVkIHRvdGFsLiBTZWN0b3IgdmFsdWVzIGFjdHVhbGx5IHByZXNlbnQ6ICR7SlNPTi5zdHJpbmdpZnkoc2VlblNlY3RvcnMpfWApOwogICAgICB9Y2F0Y2go",
  "ZSl7IC8qIGRpYWdub3N0aWMgb25seSwgaWdub3JlIGZhaWx1cmVzIGhlcmUgKi8gfQogICAgfQogICAgcmVuZGVyVGFibGVJbnRvKCJzY3JlZW5lclRhYmxlV3JhcCIsICJzY3JlZW5lckNhcmRzIiwgcmVzdWx0cywgc3RhdGUuc2NyZWVuZXJTb3J0LCB0cnVlKTsK",
  "ICB9Y2F0Y2goZSl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJTY3JlZW5lciBkYXRhIHVuYXZhaWxhYmxlIiwgIldlIGNvdWxkbid0IGxvYWQgbWF0Y2hpbmcgc3RvY2tzIHJpZ2h0IG5vdy4gKCIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkg",
  "KyAiKSIpOwogICAgc2hvd0Vycm9yQmFubmVyKCJydW5TY3JlZW5lciBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogIH0KICB3cmFwLnN0eWxlLm9wYWNpdHkgPSAiMSI7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gTUFSS0VUUyAoZnVsbCB1bml2",
  "ZXJzZSB0YWJsZSArIHRyZW5kaW5nIGhpZ2hsaWdodHMpIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyTWFya2V0cygpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNl",
  "Y3Rpb24taGVhZCI+PGgyPk1hcmtldHM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkZ1bGwgTlNFIHVuaXZlcnNlIHNuYXBzaG90PC9zcGFuPjwvZGl2PgogICAgICAke3NlYXJjaEJsb2NrKCl9CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5UcmVu",
  "ZGluZyBOb3c8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlRvZGF5J3MgYmlnZ2VzdCBtb3ZlcnMsIHVwIG9yIGRvd248L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRyZW5kaW5nLXJvdyIgaWQ9InRyZW5kaW5nUm93Ij4ke3NrZWxldG9uQ2FyZHMoNCl9PC9k",
  "aXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDsiPjxoMj5BbGwgU3RvY2tzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5Tb3J0ZWQgYnkgbWFya2V0IGNhcDwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0i",
  "dGFibGUtd3JhcCBnbGFzcyIgaWQ9Im1hcmtldHNUYWJsZVdyYXAiPjxkaXYgc3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tlbGV0b25MaW5lcygxMCl9PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0b2NrLWNhcmRzIiBpZD0ibWFya2V0c0NhcmRzIj48",
  "L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgd2lyZVNlYXJjaCgpOwogIHRyeXsKICAgIGNvbnN0IGxpc3QgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoe30pOwogICAgcmVuZGVyVHJlbmRpbmcobGlzdCk7CiAgICByZW5kZXJUYWJsZUludG8oIm1hcmtl",
  "dHNUYWJsZVdyYXAiLCAibWFya2V0c0NhcmRzIiwgbGlzdCwge2tleToibWFya2V0Q2FwIiwgZGlyOiJkZXNjIn0sIHRydWUpOwogIH1jYXRjaChlKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYXJrZXRzVGFibGVXcmFwIikuaW5uZXJIVE1MID0gZXJy",
  "b3JTdGF0ZUhUTUwoIk1hcmtldCBkYXRhIHRlbXBvcmFyaWx5IHVuYXZhaWxhYmxlIiwgIlBsZWFzZSB0cnkgYWdhaW4gaW4gYSBtb21lbnQuIik7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidHJlbmRpbmdSb3ciKS5pbm5lckhUTUwgPSBlcnJvclN0YXRl",
  "SFRNTCgiVHJlbmRpbmcgZGF0YSB1bmF2YWlsYWJsZSIsICJQbGVhc2UgdHJ5IGFnYWluIGluIGEgbW9tZW50LiIpOwogIH0KfQoKZnVuY3Rpb24gcmVuZGVyVHJlbmRpbmcobGlzdCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidHJlbmRp",
  "bmdSb3ciKTsKICBpZighZWwpIHJldHVybjsKICBpZighbGlzdC5sZW5ndGgpeyBlbC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gdHJlbmRpbmcgZGF0YSIsICJObyBzdG9ja3Mgd2VyZSByZXR1cm5lZCB0byByYW5rLiIpOyByZXR1cm47IH0KICBjb25z",
  "dCBob3QgPSBsaXN0LnNsaWNlKCkuc29ydCgoYSxiKT0+TWF0aC5hYnMoYi5wY3QpLU1hdGguYWJzKGEucGN0KSkuc2xpY2UoMCw2KTsKICBlbC5pbm5lckhUTUwgPSBob3QubWFwKChzLGkpPT57CiAgICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICAgIHJldHVybiBg",
  "CiAgICA8ZGl2IGNsYXNzPSJnbGFzcyB0cmVuZGluZy1jYXJkIiBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSo0MH1tcyI+CiAgICAgIDxkaXYgY2xhc3M9InRyZW5kaW5nLXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2Vs",
  "bC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtYmFkZ2UgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke3Bvcz8n4payJzon4pa8J30gJHtwY3RTdHIocy5wY3QpfTwvZGl2PgogICAgICA8L2Rpdj4KICAg",
  "ICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4OyI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgIDxkaXYg",
  "Y2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MTlweDttYXJnaW4tdG9wOjhweDsiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayIgc3R5bGU9ImhlaWdodDoyOHB4O21hcmdpbi10",
  "b3A6OHB4OyI+JHtzcGFya2xpbmVTVkcocy5zZXJpZXMsIHBvcyl9PC9kaXY+CiAgICA8L2Rpdj5gOwogIH0pLmpvaW4oIiIpOwogIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoIi50cmVuZGluZy1jYXJkIikuZm9yRWFjaChjYXJkPT57CiAgICBjYXJkLmFkZEV2ZW50TGlz",
  "dGVuZXIoImNsaWNrIiwgKCk9PiBuYXZpZ2F0ZSgiZGV0YWlsIiwgY2FyZC5kYXRhc2V0LnRpY2tlcikpOwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFdBVENITElTVCAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlcldhdGNobGlz",
  "dCgpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPldhdGNobGlzdDwvaDI+PHNwYW4gY2xhc3M9InN1YiI+JHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RofSBzdG9jayR7",
  "c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aD09PTE/Jyc6J3MnfSB0cmFja2VkPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ3YXRjaGxpc3QtZ3JpZCIgaWQ9IndhdGNoR3JpZCI+JHtza2VsZXRvbkNhcmRzKE1hdGgubWF4KHN0YXRlLndhdGNobGlzdC5sZW5n",
  "dGgsMykpfTwvZGl2PgogICAgPC9kaXY+CiAgYDsKICBpZighc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgid2F0Y2hHcmlkIikuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9IndhdGNoLWVtcHR5IGdsYXNzIj4ke2Vt",
  "cHR5U3RhdGVJbm5lcigiWW91ciB3YXRjaGxpc3QgaXMgZW1wdHkiLCAiU3RhciBhbnkgc3RvY2sgZnJvbSB0aGUgZGFzaGJvYXJkLCBzY3JlZW5lciBvciBtYXJrZXRzIHZpZXcgdG8gdHJhY2sgaXQgaGVyZS4iKX08L2Rpdj5gOwogICAgcmV0dXJuOwogIH0KICB0",
  "cnl7CiAgICBjb25zdCBzdG9ja3MgPSBhd2FpdCBQcm9taXNlLmFsbChzdGF0ZS53YXRjaGxpc3QubWFwKHQ9PkFQSS5mZXRjaFN0b2NrKHQpKSk7CiAgICBjb25zdCBncmlkID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIndhdGNoR3JpZCIpOwogICAgZ3JpZC5p",
  "bm5lckhUTUwgPSBzdG9ja3MuZmlsdGVyKEJvb2xlYW4pLm1hcCgocyxpKT0+d2F0Y2hDYXJkSFRNTChzLGkpKS5qb2luKCIiKTsKICAgIHdpcmVXYXRjaENhcmRzKCk7CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIndhdGNoR3JpZCIp",
  "LmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gbG9hZCB3YXRjaGxpc3QiLCAiUGxlYXNlIHRyeSBhZ2Fpbi4iKTsKICB9Cn0KCmZ1bmN0aW9uIHdhdGNoQ2FyZEhUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICByZXR1cm4gYAog",
  "IDxkaXYgY2xhc3M9ImdsYXNzIHdhdGNoLWNhcmQgZW50ZXJpbmciIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjQwfW1zIj4KICAgIDxkaXYgY2xhc3M9IndhdGNoLXRvcCI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBj",
  "bGFzcz0iY29tcGFueS1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0ic3Rhci1idG4g",
  "YWN0aXZlIiBkYXRhLXVuc3Rhcj0iJHtzLnR9IiB0aXRsZT0iUmVtb3ZlIj4KICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIg",
  "MTcuM2wtNi4xNiAzLjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICA8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxh",
  "ciIgc3R5bGU9ImZvbnQtc2l6ZToyMnB4OyI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1jaGFuZ2UgJHtwb3M/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKHMuY2hhbmdlKX0gKCR7cGN0U3RyKHMucGN0KX0pPC9k",
  "aXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayI+JHtzcGFya2xpbmVTVkcocy5zZXJpZXMsIHBvcyl9PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVdhdGNoQ2FyZHMoKXsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIud2F0Y2gtY2Fy",
  "ZCIpLmZvckVhY2goY2FyZD0+ewogICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChlKT0+ewogICAgICBpZihlLnRhcmdldC5jbG9zZXN0KCJbZGF0YS11bnN0YXJdIikpIHJldHVybjsKICAgICAgbmF2aWdhdGUoImRldGFpbCIsIGNhcmQuZGF0YXNl",
  "dC50aWNrZXIpOwogICAgfSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtdW5zdGFyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAgZS5zdG9wUHJvcGFnYXRpb24o",
  "KTsKICAgICAgY29uc3QgY2FyZCA9IGJ0bi5jbG9zZXN0KCIud2F0Y2gtY2FyZCIpOwogICAgICBjYXJkLmNsYXNzTGlzdC5hZGQoInJlbW92aW5nIik7CiAgICAgIHRvZ2dsZVdhdGNoKGJ0bi5kYXRhc2V0LnVuc3Rhcik7CiAgICAgIHNldFRpbWVvdXQoKCk9PnsK",
  "ICAgICAgICBpZighc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCkgcmVuZGVyV2F0Y2hsaXN0KCk7CiAgICAgICAgZWxzZSBjYXJkLnJlbW92ZSgpOwogICAgICAgIGNvbnN0IHN1YkVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcigiLnNlY3Rpb24taGVhZCAuc3ViIik7",
  "CiAgICAgICAgaWYoc3ViRWwpIHN1YkVsLnRleHRDb250ZW50ID0gYCR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aH0gc3RvY2ske3N0YXRlLndhdGNobGlzdC5sZW5ndGg9PT0xPycnOidzJ30gdHJhY2tlZGA7CiAgICAgIH0sIDI4MCk7CiAgICB9KTsKICB9KTsKfQoK",
  "LyogLS0tLS0tLS0tLS0tLS0tLSBTVE9DSyBERVRBSUwgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJEZXRhaWwoKXsKICByb290LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ2aWV3IiBpZD0iZGV0YWlsU2tlbGV0b24iPgogICAgPGRp",
  "diBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwiIHN0eWxlPSJoZWlnaHQ6ODhweDttYXJnaW4tYm90dG9tOjI0cHg7Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+JHtza2VsZXRvbkNhcmRzKDYpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0i",
  "Z2xhc3Mgc2tlbC1jYXJkIHNrZWwiIHN0eWxlPSJoZWlnaHQ6MzIwcHg7Ij48L2Rpdj4KICA8L2Rpdj5gOwoKICBsZXQgczsKICB0cnl7IHMgPSBhd2FpdCBBUEkuZmV0Y2hTdG9jayhzdGF0ZS5kZXRhaWxUaWNrZXIpOyB9Y2F0Y2goZSl7IHMgPSBudWxsOyB9CiAg",
  "aWYoIXMpewogICAgcm9vdC5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIHRoaXMgc3RvY2siLCAiVGhlIHRpY2tlciB5b3UncmUgbG9va2luZyBmb3IgaXNuJ3QgYXZhaWxhYmxlIHJpZ2h0IG5vdy4iKTsKICAgIHJldHVybjsK",
  "ICB9CiAgY29uc3QgcG9zID0gcy5wY3QgPj0gMDsKICBjb25zdCBpbldhdGNoID0gc3RhdGUud2F0Y2hsaXN0LmluY2x1ZGVzKHMudCk7CgogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1o",
  "ZWFkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtdGl0bGUtcm93Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgICA8ZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNz",
  "PSJkZXRhaWwtbmFtZSI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH0gwrcgJHtzLnNlY3Rvcn08L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2",
  "PgogICAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjE0cHg7Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1wcmljZS1ibG9jayI+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1wcmljZSB0YWJ1",
  "bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLWNoYW5nZSAke3Bvcz8ncG9zJzonbmVnJ30gdGFidWxhciI+JHtjaGdTdHIocy5jaGFuZ2UpfSAoJHtwY3RTdHIocy5wY3QpfSkgdG9kYXk8L2Rpdj4KICAg",
  "ICAgICAgIDwvZGl2PgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4iIGlkPSJkZXRhaWxTdGFyIiBzdHlsZT0id2lkdGg6NDRweDtoZWlnaHQ6NDRweDtjb2xvcjoke2luV2F0Y2g/JyNGRkM4NTcnOid2YXIoLS10ZXh0LW1pZCknfSI+CiAgICAgICAg",
  "ICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSIke2luV2F0Y2g/J2N1cnJlbnRDb2xvcic6J25vbmUnfSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3R5bGU9IndpZHRoOjE5cHg7aGVpZ2h0OjE5cHg7Ij48cGF0aCBkPSJN",
  "MTIgMTcuM2wtNi4xNiAzLjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQgNy4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICAgICAgPC9idXR0b24+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRp",
  "diBjbGFzcz0ibWV0cmljcy1ncmlkIj4KICAgICAgICAke21ldHJpY0NhcmQoIk9wZW4iLCBmbXRJTlIocy5vcGVuKSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCJEYXkgSGlnaCIsIGZtdElOUihzLmRheUhpZ2gpKX0KICAgICAgICAke21ldHJpY0NhcmQoIkRheSBM",
  "b3ciLCBmbXRJTlIocy5kYXlMb3cpKX0KICAgICAgICAke21ldHJpY0NhcmQoIk1hcmtldCBDYXAiLCBmbXRDb21wYWN0KHMubWFya2V0Q2FwKSl9CiAgICAgICAgJHttZXRyaWNDYXJkKCJWb2x1bWUiLCBmbXRWb2wocy52b2x1bWUpKX0KICAgICAgICAke21ldHJp",
  "Y0NhcmQoIjUyVyBIaWdoIC8gTG93IiwgZm10SU5SKHMuaGlnaDUyLDApKyIgLyAiK2ZtdElOUihzLmxvdzUyLDApKX0KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJnbGFzcyBjaGFydC1jYXJkIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC1oZWFk",
  "Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCIgc3R5bGU9Im1hcmdpbjowOyI+PGgyPlByaWNlIENoYXJ0PC9oMj48L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InJhbmdlLXRhYnMiIGlkPSJyYW5nZVRhYnMiPgogICAgICAgICAgICAke1si",
  "MUQiLCIxVyIsIjFNIiwiM00iLCI2TSIsIjFZIl0ubWFwKHI9PmA8YnV0dG9uIGRhdGEtcmFuZ2U9IiR7cn0iIGNsYXNzPSIke3N0YXRlLmRldGFpbFJhbmdlPT09cj8nYWN0aXZlJzonJ30iPiR7cn08L2J1dHRvbj5gKS5qb2luKCIiKX0KICAgICAgICAgIDwvZGl2",
  "PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LWNhbnZhcy13cmFwIiBpZD0iY2hhcnRXcmFwIj4KICAgICAgICAgIDxjYW52YXMgaWQ9InByaWNlQ2hhcnQiPjwvY2FudmFzPgogICAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtdG9vbHRp",
  "cCIgaWQ9ImNoYXJ0VG9vbHRpcCI+PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0idm9sdW1lLXdyYXAiIGlkPSJ2b2x1bWVXcmFwIj4KICAgICAgICAgIDxkaXYgY2xhc3M9InZvbHVtZS1sYWJlbCI+Vm9sdW1lIDxzcGFuIHN0eWxlPSJj",
  "b2xvcjp2YXIoLS10ZXh0LWZhaW50KTtmb250LXdlaWdodDo2MDA7Ij4ocmVsYXRpdmUsIGRlcml2ZWQgZnJvbSBwcmljZSBtb3ZlbWVudCk8L3NwYW4+PC9kaXY+CiAgICAgICAgICA8Y2FudmFzIGlkPSJ2b2x1bWVDaGFydCI+PC9jYW52YXM+CiAgICAgICAgPC9k",
  "aXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBzdHlsZT0ibWFyZ2luLWJvdHRvbToyOHB4OyI+CiAgICAgICAgPGJ1dHRvbiBjbGFzcz0iZXhwbGFpbi1idG4iIGlkPSJleHBsYWluQnRuIj4KICAgICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxs",
  "PSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0xMiA4VjRIOCIvPjxyZWN0IHg9IjQiIHk9IjgiIHdpZHRoPSIxNiIgaGVpZ2h0",
  "PSIxMiIgcng9IjIiLz48cGF0aCBkPSJNMiAxNGgyTTIwIDE0aDJNOSAxM3YyTTE1IDEzdjIiLz48L3N2Zz4KICAgICAgICAgIEV4cGxhaW4gdGhpcyBzdG9jawogICAgICAgIDwvYnV0dG9uPgogICAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGV4cGxhaW4tY2FyZCIg",
  "aWQ9ImV4cGxhaW5DYXJkIiBzdHlsZT0iZGlzcGxheTpub25lOyI+PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgYDsKCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImRldGFpbFN0YXIiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAg",
  "ICB0b2dnbGVXYXRjaChzLnQpOwogICAgcmVuZGVyRGV0YWlsKCk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInJhbmdlVGFicyIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICBjb25zdCBidG4gPSBlLnRhcmdldC5jbG9zZXN0",
  "KCJidXR0b25bZGF0YS1yYW5nZV0iKTsKICAgIGlmKCFidG4pIHJldHVybjsKICAgIHN0YXRlLmRldGFpbFJhbmdlID0gYnRuLmRhdGFzZXQucmFuZ2U7CiAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIjcmFuZ2VUYWJzIGJ1dHRvbiIpLmZvckVhY2goYj0+",
  "Yi5jbGFzc0xpc3QudG9nZ2xlKCJhY3RpdmUiLCBiPT09YnRuKSk7CiAgICBsb2FkQ2hhcnQocy50LCBzLnBjdD49MCk7CiAgfSk7CiAgd2lyZUV4cGxhaW5CdXR0b24ocy50KTsKCiAgbG9hZENoYXJ0KHMudCwgcG9zKTsKfQoKZnVuY3Rpb24gbWV0cmljQ2FyZChs",
  "YWJlbCwgdmFsdWUpewogIHJldHVybiBgPGRpdiBjbGFzcz0iZ2xhc3MgbWV0cmljLWNhcmQiPjxkaXYgY2xhc3M9Im1ldHJpYy1sYWJlbCI+JHtsYWJlbH08L2Rpdj48ZGl2IGNsYXNzPSJtZXRyaWMtdmFsdWUgdGFidWxhciI+JHt2YWx1ZX08L2Rpdj48L2Rpdj5g",
  "Owp9Cgphc3luYyBmdW5jdGlvbiBsb2FkQ2hhcnQodGlja2VyLCBwb3NpdGl2ZSl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJjaGFydFdyYXAiKTsKICBjb25zdCBjYW52YXMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicHJpY2VD",
  "aGFydCIpOwogIGlmKCF3cmFwIHx8ICFjYW52YXMpIHJldHVybjsKICBjYW52YXMuc3R5bGUub3BhY2l0eSA9ICIwLjI1IjsKICBsZXQgc2VyaWVzOwogIHRyeXsKICAgIHNlcmllcyA9IGF3YWl0IEFQSS5mZXRjaFN0b2NrSGlzdG9yeSh0aWNrZXIsIHN0YXRlLmRl",
  "dGFpbFJhbmdlKTsKICB9Y2F0Y2goZSl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJDaGFydCBkYXRhIHVuYXZhaWxhYmxlIiwgIlRoaXMgdGltZWZyYW1lIGNvdWxkbid0IGJlIGxvYWRlZC4gVHJ5IGEgZGlmZmVyZW50IHJhbmdlLiIpOwog",
  "ICAgcmV0dXJuOwogIH0KICBjYW52YXMuc3R5bGUub3BhY2l0eSA9ICIxIjsKICBkcmF3Q2hhcnQoY2FudmFzLCBzZXJpZXMsIHBvc2l0aXZlLCB0aWNrZXIpOwogIGRyYXdWb2x1bWVDaGFydChzZXJpZXMsIHBvc2l0aXZlKTsKfQoKZnVuY3Rpb24gZHJhd1ZvbHVt",
  "ZUNoYXJ0KHNlcmllcywgcG9zaXRpdmUpewogIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ2b2x1bWVDaGFydCIpOwogIGlmKCFjYW52YXMpIHJldHVybjsKICBjb25zdCByZWN0ID0gY2FudmFzLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgp",
  "OwogIGNvbnN0IGRwciA9IHdpbmRvdy5kZXZpY2VQaXhlbFJhdGlvIHx8IDE7CiAgY2FudmFzLndpZHRoID0gcmVjdC53aWR0aCAqIGRwcjsKICBjYW52YXMuaGVpZ2h0ID0gcmVjdC5oZWlnaHQgKiBkcHI7CiAgY29uc3QgY3R4ID0gY2FudmFzLmdldENvbnRleHQo",
  "IjJkIik7CiAgY3R4LnNjYWxlKGRwcixkcHIpOwogIGNvbnN0IFcgPSByZWN0LndpZHRoLCBIID0gcmVjdC5oZWlnaHQ7CiAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKCiAgLy8gRGVyaXZlIGEgcGxhdXNpYmxlIHJlbGF0aXZlIHZvbHVtZSBwcm9maWxlIGZyb20g",
  "dGhlIHByaWNlIHNlcmllcycKICAvLyBwb2ludC10by1wb2ludCB2b2xhdGlsaXR5IChiaWdnZXIgbW92ZXMgdGVuZCB0byBjb2luY2lkZSB3aXRoIGhpZ2hlcgogIC8vIHZvbHVtZSkg4oCUIGlsbHVzdHJhdGl2ZSBvbmx5OyB0aGUgYmFja2VuZCBoYXMgbm8gaGlz",
  "dG9yaWNhbCB2b2x1bWUgZmVlZC4KICBjb25zdCBkZWx0YXMgPSBzZXJpZXMubWFwKCh2LGkpPT4gaT09PTAgPyAwIDogTWF0aC5hYnModi1zZXJpZXNbaS0xXSkpOwogIGNvbnN0IG1heEQgPSBNYXRoLm1heCguLi5kZWx0YXMsIDFlLTYpOwogIGNvbnN0IGJhclcg",
  "PSBXL3Nlcmllcy5sZW5ndGg7CiAgY29uc3QgY29sb3IgPSBwb3NpdGl2ZSA/ICIjMzNENkE2IiA6ICIjRkI2QjZCIjsKICBzZXJpZXMuZm9yRWFjaCgodixpKT0+ewogICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoc3RhdGUuZGV0YWlsVGlja2VyKStpKjc7CiAg",
  "ICBjb25zdCBoID0gTWF0aC5tYXgoMywgKGRlbHRhc1tpXS9tYXhEKSAqIEggKiAwLjg1ICogKDAuNTUgKyBzZWVkZWRSYW5kKHNlZWQpKjAuNikpOwogICAgY29uc3QgdXAgPSBpPT09MCA/IHRydWUgOiBzZXJpZXNbaV0gPj0gc2VyaWVzW2ktMV07CiAgICBjdHgu",
  "ZmlsbFN0eWxlID0gdXAgPyAicmdiYSg1MSwyMTQsMTY2LDAuNTUpIiA6ICJyZ2JhKDI1MSwxMDcsMTA3LDAuNTUpIjsKICAgIGN0eC5maWxsUmVjdChpKmJhclcrYmFyVyowLjE1LCBILWgsIE1hdGgubWF4KDEsYmFyVyowLjcpLCBoKTsKICB9KTsKfQoKZnVuY3Rp",
  "b24gZHJhd0NoYXJ0KGNhbnZhcywgc2VyaWVzLCBwb3NpdGl2ZSwgdGlja2VyKXsKICBjb25zdCB3cmFwID0gY2FudmFzLnBhcmVudEVsZW1lbnQ7CiAgY29uc3QgZHByID0gd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTsKICBjb25zdCByZWN0ID0gd3JhcC5n",
  "ZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICBjYW52YXMud2lkdGggPSByZWN0LndpZHRoICogZHByOwogIGNhbnZhcy5oZWlnaHQgPSByZWN0LmhlaWdodCAqIGRwcjsKICBjYW52YXMuc3R5bGUud2lkdGggPSByZWN0LndpZHRoKyJweCI7CiAgY2FudmFzLnN0eWxl",
  "LmhlaWdodCA9IHJlY3QuaGVpZ2h0KyJweCI7CiAgY29uc3QgY3R4ID0gY2FudmFzLmdldENvbnRleHQoIjJkIik7CiAgY3R4LnNjYWxlKGRwcixkcHIpOwoKICBjb25zdCBXID0gcmVjdC53aWR0aCwgSCA9IHJlY3QuaGVpZ2h0OwogIGNvbnN0IHBhZCA9IHt0b3A6",
  "MTYsIHJpZ2h0OjgsIGJvdHRvbToyNCwgbGVmdDo4fTsKICBjb25zdCBtaW4gPSBNYXRoLm1pbiguLi5zZXJpZXMpLCBtYXggPSBNYXRoLm1heCguLi5zZXJpZXMpOwogIGNvbnN0IHJhbmdlViA9IChtYXgtbWluKSB8fCAxOwogIGNvbnN0IGlubmVyVyA9IFcgLSBw",
  "YWQubGVmdCAtIHBhZC5yaWdodDsKICBjb25zdCBpbm5lckggPSBIIC0gcGFkLnRvcCAtIHBhZC5ib3R0b207CiAgY29uc3Qgc3RlcCA9IGlubmVyVy8oc2VyaWVzLmxlbmd0aC0xKTsKCiAgZnVuY3Rpb24geHkoaSx2KXsKICAgIHJldHVybiBbcGFkLmxlZnQgKyBp",
  "KnN0ZXAsIHBhZC50b3AgKyBpbm5lckggLSAoKHYtbWluKS9yYW5nZVYpKmlubmVySF07CiAgfQogIGNvbnN0IHB0cyA9IHNlcmllcy5tYXAoKHYsaSk9Pnh5KGksdikpOwoKICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwoKICAvLyBncmlkbGluZXMKICBjdHguc3Ry",
  "b2tlU3R5bGUgPSAicmdiYSgxNTgsMTcxLDIxNCwwLjA4KSI7CiAgY3R4LmxpbmVXaWR0aCA9IDE7CiAgZm9yKGxldCBpPTA7aTw9MztpKyspewogICAgY29uc3QgeSA9IHBhZC50b3AgKyAoaW5uZXJILzMpKmk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3Zl",
  "VG8ocGFkLmxlZnQseSk7IGN0eC5saW5lVG8oVy1wYWQucmlnaHQseSk7IGN0eC5zdHJva2UoKTsKICB9CgogIGNvbnN0IGNvbG9yID0gcG9zaXRpdmUgPyAiIzMzRDZBNiIgOiAiI0ZCNkI2QiI7CgogIC8vIHNtb290aCBwYXRoCiAgZnVuY3Rpb24gc21vb3RoUGF0",
  "aChwb2ludHMpewogICAgaWYocG9pbnRzLmxlbmd0aDwzKSByZXR1cm4gYE0ke3BvaW50c1swXVswXX0sJHtwb2ludHNbMF1bMV19IEwke3BvaW50c1sxXVswXX0sJHtwb2ludHNbMV1bMV19YDsKICAgIGxldCBkID0gYE0ke3BvaW50c1swXVswXX0sJHtwb2ludHNb",
  "MF1bMV19YDsKICAgIGZvcihsZXQgaT0wO2k8cG9pbnRzLmxlbmd0aC0xO2krKyl7CiAgICAgIGNvbnN0IHAwID0gcG9pbnRzW2k9PT0wPzA6aS0xXTsKICAgICAgY29uc3QgcDEgPSBwb2ludHNbaV07CiAgICAgIGNvbnN0IHAyID0gcG9pbnRzW2krMV07CiAgICAg",
  "IGNvbnN0IHAzID0gcG9pbnRzW2krMjxwb2ludHMubGVuZ3RoP2krMjppKzFdOwogICAgICBjb25zdCBjcDF4ID0gcDFbMF0gKyAocDJbMF0tcDBbMF0pLzY7CiAgICAgIGNvbnN0IGNwMXkgPSBwMVsxXSArIChwMlsxXS1wMFsxXSkvNjsKICAgICAgY29uc3QgY3Ay",
  "eCA9IHAyWzBdIC0gKHAzWzBdLXAxWzBdKS82OwogICAgICBjb25zdCBjcDJ5ID0gcDJbMV0gLSAocDNbMV0tcDFbMV0pLzY7CiAgICAgIGQgKz0gYCBDJHtjcDF4fSwke2NwMXl9ICR7Y3AyeH0sJHtjcDJ5fSAke3AyWzBdfSwke3AyWzFdfWA7CiAgICB9CiAgICBy",
  "ZXR1cm4gZDsKICB9CiAgY29uc3QgbGluZVBhdGggPSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7CgogIC8vIGFyZWEgZmlsbAogIGNvbnN0IGdyYWQgPSBjdHguY3JlYXRlTGluZWFyR3JhZGllbnQoMCxwYWQudG9wLDAscGFkLnRvcCtpbm5lckgpOwogIGdy",
  "YWQuYWRkQ29sb3JTdG9wKDAsIGNvbG9yKyI1NSIpOwogIGdyYWQuYWRkQ29sb3JTdG9wKDEsIGNvbG9yKyIwMiIpOwogIGN0eC5zYXZlKCk7CiAgY29uc3QgYXJlYVBhdGggPSBuZXcgUGF0aDJEKHNtb290aFBhdGgocHRzKSk7CiAgYXJlYVBhdGgubGluZVRvKHB0",
  "c1twdHMubGVuZ3RoLTFdWzBdLCBwYWQudG9wK2lubmVySCk7CiAgYXJlYVBhdGgubGluZVRvKHB0c1swXVswXSwgcGFkLnRvcCtpbm5lckgpOwogIGFyZWFQYXRoLmNsb3NlUGF0aCgpOwogIGN0eC5maWxsU3R5bGUgPSBncmFkOwogIGN0eC5maWxsKGFyZWFQYXRo",
  "KTsKICBjdHgucmVzdG9yZSgpOwoKICAvLyBsaW5lCiAgY3R4LnN0cm9rZVN0eWxlID0gY29sb3I7CiAgY3R4LmxpbmVXaWR0aCA9IDI7CiAgY3R4LmxpbmVKb2luID0gInJvdW5kIjsKICBjdHgubGluZUNhcCA9ICJyb3VuZCI7CiAgY3R4LnN0cm9rZShsaW5lUGF0",
  "aCk7CgogIC8vIGVudHJhbmNlIGFuaW1hdGlvbiB2aWEgY2xpcCByZXZlYWwKICBjYW52YXMuX2NoYXJ0TWV0YSA9IHtwdHMsIHNlcmllcywgVywgSCwgcGFkLCBjb2xvcn07CgogIC8vIGNyb3NzaGFpciBpbnRlcmFjdGl2aXR5CiAgY29uc3QgdG9vbHRpcCA9IGRv",
  "Y3VtZW50LmdldEVsZW1lbnRCeUlkKCJjaGFydFRvb2x0aXAiKTsKICBjYW52YXMub25tb3VzZW1vdmUgPSAoZSk9PnsKICAgIGNvbnN0IHIgPSBjYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgICBjb25zdCBteCA9IGUuY2xpZW50WCAtIHIubGVmdDsK",
  "ICAgIGxldCBpZHggPSBNYXRoLnJvdW5kKChteC1wYWQubGVmdCkvc3RlcCk7CiAgICBpZHggPSBNYXRoLm1heCgwLCBNYXRoLm1pbihzZXJpZXMubGVuZ3RoLTEsIGlkeCkpOwogICAgY29uc3QgW3B4LHB5XSA9IHB0c1tpZHhdOwoKICAgIHJlZHJhd1dpdGhDcm9z",
  "c2hhaXIoY3R4LCBjYW52YXMuX2NoYXJ0TWV0YSwgcHgsIHB5KTsKCiAgICB0b29sdGlwLnN0eWxlLm9wYWNpdHkgPSAiMSI7CiAgICB0b29sdGlwLnN0eWxlLmxlZnQgPSBweCsicHgiOwogICAgdG9vbHRpcC5zdHlsZS50b3AgPSBweSsicHgiOwogICAgdG9vbHRp",
  "cC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0idHQtcHJpY2UiPiR7Zm10SU5SKHNlcmllc1tpZHhdKX08L2Rpdj48ZGl2IGNsYXNzPSJ0dC1kYXRlIj5Qb2ludCAke2lkeCsxfSBvZiAke3Nlcmllcy5sZW5ndGh9PC9kaXY+YDsKICB9OwogIGNhbnZhcy5vbm1vdXNl",
  "bGVhdmUgPSAoKT0+ewogICAgdG9vbHRpcC5zdHlsZS5vcGFjaXR5ID0gIjAiOwogICAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKICAgIHJlZHJhdyhjdHgsIGNhbnZhcy5fY2hhcnRNZXRhKTsKICB9OwoKICBmdW5jdGlvbiByZWRyYXcoY3R4LCBtZXRhKXsKICAg",
  "IGNvbnN0IHtwdHMsIFcsIEgsIHBhZCwgY29sb3J9ID0gbWV0YTsKICAgIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7CiAgICBjdHguc3Ryb2tlU3R5bGUgPSAicmdiYSgxNTgsMTcxLDIxNCwwLjA4KSI7CiAgICBjdHgubGluZVdpZHRoID0gMTsKICAgIGNvbnN0IGlu",
  "bmVySDIgPSBILXBhZC50b3AtcGFkLmJvdHRvbTsKICAgIGZvcihsZXQgaT0wO2k8PTM7aSsrKXsKICAgICAgY29uc3QgeSA9IHBhZC50b3AgKyAoaW5uZXJIMi8zKSppOwogICAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5tb3ZlVG8ocGFkLmxlZnQseSk7IGN0eC5s",
  "aW5lVG8oVy1wYWQucmlnaHQseSk7IGN0eC5zdHJva2UoKTsKICAgIH0KICAgIGNvbnN0IGdyYWQyID0gY3R4LmNyZWF0ZUxpbmVhckdyYWRpZW50KDAscGFkLnRvcCwwLHBhZC50b3AraW5uZXJIMik7CiAgICBncmFkMi5hZGRDb2xvclN0b3AoMCwgY29sb3IrIjU1",
  "Iik7IGdyYWQyLmFkZENvbG9yU3RvcCgxLCBjb2xvcisiMDIiKTsKICAgIGNvbnN0IGFyZWFQYXRoMiA9IG5ldyBQYXRoMkQoc21vb3RoUGF0aChwdHMpKTsKICAgIGFyZWFQYXRoMi5saW5lVG8ocHRzW3B0cy5sZW5ndGgtMV1bMF0sIHBhZC50b3AraW5uZXJIMik7",
  "CiAgICBhcmVhUGF0aDIubGluZVRvKHB0c1swXVswXSwgcGFkLnRvcCtpbm5lckgyKTsKICAgIGFyZWFQYXRoMi5jbG9zZVBhdGgoKTsKICAgIGN0eC5maWxsU3R5bGUgPSBncmFkMjsgY3R4LmZpbGwoYXJlYVBhdGgyKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9IGNv",
  "bG9yOyBjdHgubGluZVdpZHRoID0gMjsgY3R4LmxpbmVKb2luPSJyb3VuZCI7IGN0eC5saW5lQ2FwPSJyb3VuZCI7CiAgICBjdHguc3Ryb2tlKG5ldyBQYXRoMkQoc21vb3RoUGF0aChwdHMpKSk7CiAgfQogIGZ1bmN0aW9uIHJlZHJhd1dpdGhDcm9zc2hhaXIoY3R4",
  "LCBtZXRhLCBweCwgcHkpewogICAgcmVkcmF3KGN0eCwgbWV0YSk7CiAgICBjb25zdCB7SCwgcGFkLCBjb2xvcn0gPSBtZXRhOwogICAgY3R4LnNhdmUoKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9ICJyZ2JhKDE1OCwxNzEsMjE0LDAuMzUpIjsKICAgIGN0eC5saW5l",
  "V2lkdGggPSAxOwogICAgY3R4LnNldExpbmVEYXNoKFszLDNdKTsKICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbyhweCwgcGFkLnRvcCk7IGN0eC5saW5lVG8ocHgsIEgtcGFkLmJvdHRvbSk7IGN0eC5zdHJva2UoKTsKICAgIGN0eC5zZXRMaW5lRGFzaChb",
  "XSk7CiAgICBjdHguYmVnaW5QYXRoKCk7IGN0eC5hcmMocHgscHksNCwwLE1hdGguUEkqMik7CiAgICBjdHguZmlsbFN0eWxlID0gY29sb3I7IGN0eC5maWxsKCk7CiAgICBjdHguc3Ryb2tlU3R5bGUgPSAiIzA1MDYwQiI7IGN0eC5saW5lV2lkdGg9MjsgY3R4LnN0",
  "cm9rZSgpOwogICAgY3R4LnJlc3RvcmUoKTsKICB9Cn0KCndpbmRvdy5hZGRFdmVudExpc3RlbmVyKCJyZXNpemUiLCBkZWJvdW5jZSgoKT0+ewogIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJwcmljZUNoYXJ0Iik7CiAgaWYoY2FudmFz",
  "ICYmIHN0YXRlLnZpZXc9PT0iZGV0YWlsIikgbG9hZENoYXJ0KHN0YXRlLmRldGFpbFRpY2tlciwgdHJ1ZSk7Cn0sIDIwMCkpOwoKLyogLS0tLS0tLS0tLS0tLS0tLSBTVEFURSBIRUxQRVJTIC0tLS0tLS0tLS0tLS0tLS0gKi8KZnVuY3Rpb24gZW1wdHlTdGF0ZUlu",
  "bmVyKHRpdGxlLCBzdWIpewogIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1pY29uIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRo",
  "PSIyIj48Y2lyY2xlIGN4PSIxMSIgY3k9IjExIiByPSI3Ii8+PHBhdGggZD0iTTIxIDIxbC00LjMtNC4zIi8+PC9zdmc+PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS10aXRsZSI+JHt0aXRsZX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXN1YiI+JHtz",
  "dWJ9PC9kaXY+CiAgYDsKfQpmdW5jdGlvbiBlbXB0eVN0YXRlSFRNTCh0aXRsZSwgc3ViKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9InN0YXRlLWJveCI+JHtlbXB0eVN0YXRlSW5uZXIodGl0bGUsIHN1Yil9PC9kaXY+YDsKfQpmdW5jdGlvbiBlcnJvclN0YXRlSFRN",
  "TCh0aXRsZSwgc3ViKXsKICByZXR1cm4gYDxkaXYgY2xhc3M9InN0YXRlLWJveCI+CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS1pY29uIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgd2lkdGg9IjIyIiBoZWlnaHQ9IjIyIiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJl",
  "bnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgOXY0TTEyIDE3aC4wMU0xMC4yOSAzLjg2TDEuODIgMThhMiAyIDAgMDAxLjcxIDNoMTYuOTRhMiAyIDAgMDAxLjcxLTNMMTMuNzEgMy44NmEyIDIgMCAwMC0zLjQyIDB6Ii8+PC9zdmc+PC9kaXY+",
  "CiAgICA8ZGl2IGNsYXNzPSJzdGF0ZS10aXRsZSI+JHt0aXRsZX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXN1YiI+JHtzdWJ9PC9kaXY+CiAgPC9kaXY+YDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PQogICBCT09UCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PQogICBBSSBBU1NJU1RBTlQg4oCUIGNoYXQgcGFuZWwgKyBwZXItc3RvY2sgZXhwbGFpbgogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IGFpU3RhdGUg",
  "PSB7IG9wZW46IGZhbHNlLCBoaXN0b3J5OiBbXSwgY29uZmlndXJlZDogbnVsbCwgYnVzeTogZmFsc2UgfTsKCmZ1bmN0aW9uIGFpU2V0U3RhdHVzTGluZSh0ZXh0KXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVN0YXR1c0xpbmUiKTsK",
  "ICBpZihlbCkgZWwudGV4dENvbnRlbnQgPSB0ZXh0Owp9Cgphc3luYyBmdW5jdGlvbiBjaGVja0FpU3RhdHVzKCl7CiAgdHJ5ewogICAgY29uc3QgciA9IGF3YWl0IGZldGNoV2l0aFRpbWVvdXQoQ09ORklHLkFQSV9CQVNFICsgIi9haS9zdGF0dXMiLCBDT05GSUcu",
  "TElWRV9USU1FT1VUX01TKTsKICAgIGlmKCFyLm9rKSB0aHJvdyBuZXcgRXJyb3IoImJhZCBzdGF0dXMiKTsKICAgIGNvbnN0IGpzb24gPSBhd2FpdCByLmpzb24oKTsKICAgIGFpU3RhdGUuY29uZmlndXJlZCA9ICEhanNvbi5jb25maWd1cmVkOwogICAgYWlTZXRT",
  "dGF0dXNMaW5lKGFpU3RhdGUuY29uZmlndXJlZCA/ICJSZWFkeSIgOiAiTm90IGNvbmZpZ3VyZWQgb24gc2VydmVyIik7CiAgfWNhdGNoKGUpewogICAgYWlTdGF0ZS5jb25maWd1cmVkID0gZmFsc2U7CiAgICBhaVNldFN0YXR1c0xpbmUobGl2ZUJhY2tlbmRBdmFp",
  "bGFibGUgPyAiVW5hdmFpbGFibGUiIDogIkJhY2tlbmQgbm90IGNvbm5lY3RlZCIpOwogIH0KfQoKZnVuY3Rpb24gYnVpbGRBaUNvbnRleHQoKXsKICAvLyBDb21wYWN0LCByZWxldmFudCBzbmFwc2hvdCBvZiB3aGF0J3MgY3VycmVudGx5IGxvYWRlZCDigJQga2Vw",
  "dCBzbWFsbCBvbgogIC8vIHB1cnBvc2Ugc2luY2UgdGhpcyBnZXRzIHNlbnQgKGFuZCBiaWxsZWQpIG9uIGV2ZXJ5IHF1ZXN0aW9uLgogIGNvbnN0IGN0eCA9IHsgdmlldzogc3RhdGUudmlldywgd2F0Y2hsaXN0OiBbXSB9OwogIGlmKHN0YXRlLnZpZXcgPT09ICJk",
  "ZXRhaWwiKSBjdHguY3VycmVudFN0b2NrID0geyB0aWNrZXI6IHN0YXRlLmRldGFpbFRpY2tlciB9OwogIGlmKHN0YXRlLndhdGNobGlzdC5sZW5ndGgpewogICAgY3R4LndhdGNobGlzdCA9IHN0YXRlLndhdGNobGlzdC5zbGljZSgwLCAxMCk7CiAgfQogIHJldHVy",
  "biBjdHg7Cn0KCmZ1bmN0aW9uIGFwcGVuZEFpTWVzc2FnZShyb2xlLCB0ZXh0LCBleHRyYUNsYXNzKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpTWVzc2FnZXMiKTsKICBpZighd3JhcCkgcmV0dXJuIG51bGw7CiAgY29uc3QgZGl2",
  "ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiZGl2Iik7CiAgZGl2LmNsYXNzTmFtZSA9ICJhaS1tc2cgIiArIHJvbGUgKyAoZXh0cmFDbGFzcyA/ICIgIiArIGV4dHJhQ2xhc3MgOiAiIik7CiAgZGl2LnRleHRDb250ZW50ID0gdGV4dDsKICB3cmFwLmFwcGVuZENo",
  "aWxkKGRpdik7CiAgd3JhcC5zY3JvbGxUb3AgPSB3cmFwLnNjcm9sbEhlaWdodDsKICByZXR1cm4gZGl2Owp9Cgphc3luYyBmdW5jdGlvbiBzZW5kQWlNZXNzYWdlKHF1ZXN0aW9uKXsKICBpZighcXVlc3Rpb24udHJpbSgpIHx8IGFpU3RhdGUuYnVzeSkgcmV0dXJu",
  "OwogIGFwcGVuZEFpTWVzc2FnZSgidXNlciIsIHF1ZXN0aW9uKTsKICBhaVN0YXRlLmJ1c3kgPSB0cnVlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVNlbmRCdG4iKS5kaXNhYmxlZCA9IHRydWU7CiAgY29uc3QgcGVuZGluZyA9IGFwcGVuZEFpTWVzc2Fn",
  "ZSgiYXNzaXN0YW50IiwgIlRoaW5raW5n4oCmIiwgInBlbmRpbmciKTsKCiAgdHJ5ewogICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSB0aHJvdyBuZXcgRXJyb3IoIkJhY2tlbmQgbm90IGNvbm5lY3RlZCDigJQgdGhlIEFJIGFzc2lzdGFudCBuZWVkcyB0aGUg",
  "bGl2ZSBiYWNrZW5kIHJ1bm5pbmcuIik7CiAgICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogICAgY29uc3QgaWQgPSBzZXRUaW1lb3V0KCgpPT5jdHJsLmFib3J0KCksIDIwMDAwKTsKICAgIGNvbnN0IHJlcyA9IGF3YWl0IGZldGNoKENPTkZJ",
  "Ry5BUElfQkFTRSArICIvY2hhdCIsIHsKICAgICAgbWV0aG9kOiAiUE9TVCIsCiAgICAgIGhlYWRlcnM6IHsiQ29udGVudC1UeXBlIjogImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgYm9keTogSlNPTi5zdHJpbmdpZnkoewogICAgICAgIHF1ZXN0aW9uOiBxdWVz",
  "dGlvbi50cmltKCksCiAgICAgICAgY29udGV4dDogYnVpbGRBaUNvbnRleHQoKSwKICAgICAgICBoaXN0b3J5OiBhaVN0YXRlLmhpc3Rvcnkuc2xpY2UoLTYpLAogICAgICB9KSwKICAgICAgc2lnbmFsOiBjdHJsLnNpZ25hbCwKICAgIH0pLmZpbmFsbHkoKCk9PmNs",
  "ZWFyVGltZW91dChpZCkpOwoKICAgIGNvbnN0IGpzb24gPSBhd2FpdCByZXMuanNvbigpOwogICAgaWYoIXJlcy5vayB8fCAhanNvbi5zdWNjZXNzKSB0aHJvdyBuZXcgRXJyb3IoKGpzb24uZXJyb3IgJiYganNvbi5lcnJvci5tZXNzYWdlKSB8fCAoIlJlcXVlc3Qg",
  "ZmFpbGVkICgiICsgcmVzLnN0YXR1cyArICIpIikpOwoKICAgIHBlbmRpbmcucmVtb3ZlKCk7CiAgICBhcHBlbmRBaU1lc3NhZ2UoImFzc2lzdGFudCIsIGpzb24uZGF0YS5hbnN3ZXIpOwogICAgYWlTdGF0ZS5oaXN0b3J5LnB1c2goe3JvbGU6InVzZXIiLCBjb250",
  "ZW50OiBxdWVzdGlvbi50cmltKCl9KTsKICAgIGFpU3RhdGUuaGlzdG9yeS5wdXNoKHtyb2xlOiJhc3Npc3RhbnQiLCBjb250ZW50OiBqc29uLmRhdGEuYW5zd2VyfSk7CiAgfWNhdGNoKGUpewogICAgcGVuZGluZy5yZW1vdmUoKTsKICAgIGFwcGVuZEFpTWVzc2Fn",
  "ZSgiYXNzaXN0YW50IiwgIkNvdWxkbid0IGdldCBhIHJlc3BvbnNlOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpLCAiZXJyb3IiKTsKICB9ZmluYWxseXsKICAgIGFpU3RhdGUuYnVzeSA9IGZhbHNlOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpU2Vu",
  "ZEJ0biIpLmRpc2FibGVkID0gZmFsc2U7CiAgfQp9CgpmdW5jdGlvbiB3aXJlQWlQYW5lbCgpewogIGNvbnN0IGZhYiA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaUZhYiIpOwogIGNvbnN0IHBhbmVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpUGFu",
  "ZWwiKTsKICBjb25zdCBjbG9zZUJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaUNsb3NlQnRuIik7CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlJbnB1dCIpOwogIGNvbnN0IHNlbmRCdG4gPSBkb2N1bWVudC5nZXRFbGVt",
  "ZW50QnlJZCgiYWlTZW5kQnRuIik7CgogIHBhbmVsLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOwoKICBmYWIuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgYWlTdGF0ZS5vcGVuID0gIWFpU3RhdGUub3BlbjsKICAgIHBhbmVsLmNsYXNzTGlzdC50",
  "b2dnbGUoImhpZGRlbiIsICFhaVN0YXRlLm9wZW4pOwogICAgaWYoYWlTdGF0ZS5vcGVuKXsgY2hlY2tBaVN0YXR1cygpOyBpbnB1dC5mb2N1cygpOyB9CiAgfSk7CiAgY2xvc2VCdG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgYWlTdGF0ZS5v",
  "cGVuID0gZmFsc2U7CiAgICBwYW5lbC5jbGFzc0xpc3QuYWRkKCJoaWRkZW4iKTsKICB9KTsKICBjb25zdCBzZW5kID0gKCk9PnsKICAgIGNvbnN0IHEgPSBpbnB1dC52YWx1ZTsKICAgIGlucHV0LnZhbHVlID0gIiI7CiAgICBzZW5kQWlNZXNzYWdlKHEpOwogIH07",
  "CiAgc2VuZEJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIHNlbmQpOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24iLCAoZSk9PnsgaWYoZS5rZXkgPT09ICJFbnRlciIpIHNlbmQoKTsgfSk7Cn0KCi8vICJFeHBsYWluIHRoaXMgc3RvY2siIOKA",
  "lCBjYWxsZWQgZnJvbSByZW5kZXJEZXRhaWwgb25jZSBzdG9jayBkYXRhIGlzIGxvYWRlZC4KYXN5bmMgZnVuY3Rpb24gd2lyZUV4cGxhaW5CdXR0b24odGlja2VyKXsKICBjb25zdCBidG4gPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXhwbGFpbkJ0biIpOwog",
  "IGNvbnN0IGNhcmQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXhwbGFpbkNhcmQiKTsKICBpZighYnRuKSByZXR1cm47CiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgYXN5bmMgKCk9PnsKICAgIGJ0bi5kaXNhYmxlZCA9IHRydWU7CiAgICBidG4u",
  "dGV4dENvbnRlbnQgPSAiVGhpbmtpbmfigKYiOwogICAgY2FyZC5zdHlsZS5kaXNwbGF5ID0gImJsb2NrIjsKICAgIGNhcmQuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9ImV4cGxhaW4taGVhZCI+PGRpdiBjbGFzcz0iYWktYXZhdGFyIj7inKY8L2Rpdj48ZGl2IHN0",
  "eWxlPSJmb250LXdlaWdodDo3MDA7Zm9udC1zaXplOjEzcHg7Ij5BSSBFeHBsYW5hdGlvbjwvZGl2PjwvZGl2PjxkaXYgY2xhc3M9ImV4cGxhaW4tdGV4dCI+JHtza2VsZXRvbkxpbmVzKDMpfTwvZGl2PmA7CiAgICB0cnl7CiAgICAgIGlmKCFsaXZlQmFja2VuZEF2",
  "YWlsYWJsZSkgdGhyb3cgbmV3IEVycm9yKCJCYWNrZW5kIG5vdCBjb25uZWN0ZWQuIik7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KGAke0NPTkZJRy5BUElfQkFTRX0vZXhwbGFpbi8ke2VuY29kZVVSSUNvbXBvbmVudCh0aWNrZXIpfWAs",
  "IDIwMDAwKTsKICAgICAgY29uc3QganNvbiA9IGF3YWl0IHIuanNvbigpOwogICAgICBpZighci5vayB8fCAhanNvbi5zdWNjZXNzKSB0aHJvdyBuZXcgRXJyb3IoKGpzb24uZXJyb3IgJiYganNvbi5lcnJvci5tZXNzYWdlKSB8fCAoIlJlcXVlc3QgZmFpbGVkICgi",
  "ICsgci5zdGF0dXMgKyAiKSIpKTsKICAgICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZXhwbGFpbi1oZWFkIj48ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTNweDsiPkFJ",
  "IEV4cGxhbmF0aW9uPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iZXhwbGFpbi10ZXh0Ij4ke2VzY2FwZUh0bWwoanNvbi5kYXRhLmV4cGxhbmF0aW9uKX08L2Rpdj5gOwogICAgfWNhdGNoKGUpewogICAgICBjYXJkLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJleHBs",
  "YWluLWhlYWQiPjxkaXYgY2xhc3M9ImFpLWF2YXRhciI+4pymPC9kaXY+PGRpdiBzdHlsZT0iZm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxM3B4OyI+QUkgRXhwbGFuYXRpb248L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJleHBsYWluLXRleHQiIHN0eWxlPSJjb2xv",
  "cjp2YXIoLS1uZWctc29mdCk7Ij5Db3VsZG4ndCBnZW5lcmF0ZSBhbiBleHBsYW5hdGlvbjogJHtlc2NhcGVIdG1sKGUgJiYgZS5tZXNzYWdlIHx8IFN0cmluZyhlKSl9PC9kaXY+YDsKICAgIH1maW5hbGx5ewogICAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAg",
  "ICAgYnRuLnRleHRDb250ZW50ID0gIuKcpiBFeHBsYWluIHRoaXMgc3RvY2siOwogICAgfQogIH0pOwp9CgpzZXRBY3RpdmVOYXYoImRhc2hib2FyZCIpOwp3aXJlQWlQYW5lbCgpOwpjaGVja0xpdmVCYWNrZW5kKCkuZmluYWxseShyZW5kZXIpOwpzZXRJbnRlcnZh",
  "bChjaGVja0xpdmVCYWNrZW5kLCA0NTAwMCk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K"
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
