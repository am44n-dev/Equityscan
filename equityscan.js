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
  "ZCBoMntmb250LXNpemU6MTVweDtmb250LXdlaWdodDo3MDA7Y29sb3I6dmFyKC0tdGV4dC1oaSk7bWFyZ2luOjA7bGV0dGVyLXNwYWNpbmc6LTAuMDFlbTtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo5cHg7fQouc2VjdGlvbi1oZWFkIGgyOjpi",
  "ZWZvcmV7Y29udGVudDoiIjt3aWR0aDozcHg7aGVpZ2h0OjE0cHg7Ym9yZGVyLXJhZGl1czoycHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLHZhcigtLWJsdWUpLHZhcigtLXZpb2xldCkpO2ZsZXgtc2hyaW5rOjA7fQouc2VjdGlvbi1oZWFkIC5z",
  "dWJ7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEyLjVweDt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgR0xBU1MgQ0FSRCBCQVNFCiAgID09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouZ2xhc3N7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTgwZGVnLCB2YXIoLS1iZy1lbGV2YXRlZCksIHZhcigtLWJnLXN1cmZhY2UpKTsKICBib3JkZXI6MXB4IHNvbGlkIHZh",
  "cigtLWJvcmRlci1oYWlyKTsKICBib3JkZXItcmFkaXVzOnZhcigtLXJhZGl1cy1sKTsKICBwb3NpdGlvbjpyZWxhdGl2ZTsKfQouZ2xhc3M6OmJlZm9yZXsKICBjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO2luc2V0OjA7Ym9yZGVyLXJhZGl1czppbmhlcml0",
  "O3BhZGRpbmc6MXB4O3BvaW50ZXItZXZlbnRzOm5vbmU7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTYwZGVnLCByZ2JhKDI1NSwyNTUsMjU1LDAuMDYpLCB0cmFuc3BhcmVudCA0MCUpOwogIC13ZWJraXQtbWFzazpsaW5lYXItZ3JhZGllbnQoIzAwMCAw",
  "IDApIGNvbnRlbnQtYm94LCBsaW5lYXItZ3JhZGllbnQoIzAwMCAwIDApOwogIC13ZWJraXQtbWFzay1jb21wb3NpdGU6eG9yO21hc2stY29tcG9zaXRlOmV4Y2x1ZGU7Cn0KLmdsYXNzOjphZnRlcnsKICBjb250ZW50OiIiO3Bvc2l0aW9uOmFic29sdXRlO3RvcDow",
  "O2xlZnQ6MTIlO3JpZ2h0OjEyJTtoZWlnaHQ6MXB4O3BvaW50ZXItZXZlbnRzOm5vbmU7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsIHRyYW5zcGFyZW50LCByZ2JhKDEyNCwxNTAsMjU1LDAuMzUpLCByZ2JhKDE2OCwxNDAsMjU1LDAuMzUpLCB0",
  "cmFuc3BhcmVudCk7CiAgb3BhY2l0eTowLjU7dHJhbnNpdGlvbjpvcGFjaXR5IC4yNXMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5pbmRleC1jYXJkOmhvdmVyOjphZnRlciwgLnRyZW5kaW5nLWNhcmQ6aG92ZXI6OmFmdGVyLCAud2F0Y2gtY2FyZDpob3Zlcjo6YWZ0ZXIs",
  "IC5zdG9jay1jYXJkOmhvdmVyOjphZnRlcntvcGFjaXR5OjE7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEhFUk8gLyBJTkRJQ0VTCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouaGVyby1yb3d7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpO2dhcDoxNHB4O21hcmdpbi1ib3R0b206MzRweDt9Ci5pbmRleC1jYXJkewogIHBhZGRpbmc6",
  "MjBweCAyMnB4O292ZXJmbG93OmhpZGRlbjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMjVzIHZhcigtLWVhc2Utb3V0KSwgYm9yZGVyLWNvbG9yIC4yNXMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5pbmRleC1jYXJkOmhvdmVye3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0ycHgp",
  "O2JvcmRlci1jb2xvcjp2YXIoLS1ib3JkZXItc29mdCk7fQouaW5kZXgtY2FyZCAucm93MXtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6ZmxleC1zdGFydDttYXJnaW4tYm90dG9tOjE0cHg7fQouaW5kZXgtbmFt",
  "ZXtmb250LXNpemU6MTIuNXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7bGV0dGVyLXNwYWNpbmc6MC4wMWVtO30KLmluZGV4LWZ1bGx7Zm9udC1zaXplOjEwLjVweDtjb2xvcjp2YXIoLS10ZXh0LWZhaW50KTttYXJnaW4tdG9wOjJweDt9",
  "Ci5pbmRleC1iYWRnZXtmb250LXNpemU6MTFweDtmb250LXdlaWdodDo3MDA7cGFkZGluZzozcHggOHB4O2JvcmRlci1yYWRpdXM6N3B4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjRweDt9Ci5pbmRleC1iYWRnZS5wb3N7Y29sb3I6dmFyKC0t",
  "cG9zKTtiYWNrZ3JvdW5kOnZhcigtLXBvcy1iZyk7fQouaW5kZXgtYmFkZ2UubmVne2NvbG9yOnZhcigtLW5lZyk7YmFja2dyb3VuZDp2YXIoLS1uZWctYmcpO30KLmluZGV4LXZhbHVle2ZvbnQtc2l6ZToyOHB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0ZXItc3BhY2lu",
  "ZzotMC4wMmVtO30KLmluZGV4LXZhbHVlLWdyYWRpZW50e2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDE2MGRlZyx2YXIoLS10ZXh0LWhpKSx2YXIoLS10ZXh0LW1pZCkpOy13ZWJraXQtYmFja2dyb3VuZC1jbGlwOnRleHQ7YmFja2dyb3VuZC1jbGlwOnRleHQ7",
  "Y29sb3I6dHJhbnNwYXJlbnQ7fQouaW5kZXgtY2hhbmdle2ZvbnQtc2l6ZToxM3B4O2ZvbnQtd2VpZ2h0OjYwMDttYXJnaW4tdG9wOjRweDt9Ci5pbmRleC1jaGFuZ2UucG9ze2NvbG9yOnZhcigtLXBvcy1zb2Z0KTt9Ci5pbmRleC1jaGFuZ2UubmVne2NvbG9yOnZh",
  "cigtLW5lZy1zb2Z0KTt9Ci5pbmRleC1zcGFya3ttYXJnaW4tdG9wOjE0cHg7aGVpZ2h0OjM2cHg7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNFQVJDSAogICA9PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLnNlYXJjaC13cmFwe3Bvc2l0aW9uOnJlbGF0aXZlO21hcmdpbi1ib3R0b206MzhweDt9Ci5zZWFyY2gtYm94ewogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7",
  "Z2FwOjEwcHg7cGFkZGluZzoxNHB4IDE2cHg7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMtbSk7CiAgYmFja2dyb3VuZDpyZ2JhKDE5LDI0LDQxLDAuNzUpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEycHgpOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVy",
  "LXNvZnQpOwogIHRyYW5zaXRpb246Ym9yZGVyLWNvbG9yIC4yMnMgdmFyKC0tZWFzZS1vdXQpLCBib3gtc2hhZG93IC4yMnMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5zZWFyY2gtYm94LmZvY3VzZWR7CiAgYm9yZGVyLWNvbG9yOnJnYmEoMTI0LDE1MCwyNTUsMC41NSk7",
  "CiAgYm94LXNoYWRvdzowIDAgMCA0cHggcmdiYSg3NiwxMjUsMjU1LDAuMTApLCAwIDE4cHggNDBweCAtMjBweCByZ2JhKDc2LDEyNSwyNTUsMC4zNSk7Cn0KLnNlYXJjaC1ib3ggc3Zne3dpZHRoOjE3cHg7aGVpZ2h0OjE3cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7",
  "ZmxleC1zaHJpbms6MDt9Ci5zZWFyY2gtYm94IGlucHV0ewogIGZsZXg6MTtiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7b3V0bGluZTpub25lO2NvbG9yOnZhcigtLXRleHQtaGkpO2ZvbnQtc2l6ZToxNC41cHg7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC11aSk7",
  "Cn0KLnNlYXJjaC1ib3ggaW5wdXQ6OnBsYWNlaG9sZGVye2NvbG9yOnZhcigtLXRleHQtbG8pO30Ka2JkLmtzaG9ydGN1dHsKICBmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7Zm9udC1zaXplOjExcHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Ym9yZGVyOjFweCBz",
  "b2xpZCB2YXIoLS1ib3JkZXItc29mdCk7CiAgcGFkZGluZzoycHggN3B4O2JvcmRlci1yYWRpdXM6NnB4O2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7Cn0KLnNlYXJjaC1kcm9wewogIHBvc2l0aW9uOmFic29sdXRlO2xlZnQ6MDtyaWdodDowO3RvcDpjYWxjKDEw",
  "MCUgKyA4cHgpO3otaW5kZXg6NDA7CiAgYm9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMtbSk7b3ZlcmZsb3c6aGlkZGVuOwogIGJhY2tncm91bmQ6dmFyKC0tYmctZWxldmF0ZWQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIGJveC1zaGFk",
  "b3c6MCAyNHB4IDYwcHggLTIycHggcmdiYSgwLDAsMCwwLjY1KTsKICBtYXgtaGVpZ2h0OjM0MHB4O292ZXJmbG93LXk6YXV0bzsKfQouc2VhcmNoLXJvd3sKICBkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3",
  "ZWVuO3BhZGRpbmc6MTFweCAxNnB4O2N1cnNvcjpwb2ludGVyOwogIGJvcmRlci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTsKICBhbmltYXRpb246cm93SW4gLjI4cyB2YXIoLS1lYXNlLW91dCkgYm90aDsKICB0cmFuc2l0aW9uOmJhY2tncm91",
  "bmQgLjE1czsKfQouc2VhcmNoLXJvdzpob3ZlcntiYWNrZ3JvdW5kOnZhcigtLWJvcmRlci1oYWlyKTt9Ci5zZWFyY2gtcm93Omxhc3QtY2hpbGR7Ym9yZGVyLWJvdHRvbTpub25lO30KQGtleWZyYW1lcyByb3dJbntmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJh",
  "bnNsYXRlWSgtNHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTp0cmFuc2xhdGVZKDApO319Ci5zci1sZWZ0e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjExcHg7fQouc3ItdGlja2VyewogIHdpZHRoOjM2cHg7aGVpZ2h0OjM2cHg7Ym9yZGVy",
  "LXJhZGl1czo5cHg7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyOwogIGZvbnQtc2l6ZToxMXB4O2ZvbnQtd2VpZ2h0OjgwMDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7CiAgYmFja2dyb3VuZDpsaW5lYXIt",
  "Z3JhZGllbnQoMTUwZGVnLHZhcigtLWluZGlnby03MDApLHZhcigtLWJnLWVsZXZhdGVkLTIpKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpOwp9Ci5zci1uYW1le2ZvbnQtc2l6ZToxMy41cHg7Zm9udC13",
  "ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLXRleHQtaGkpO30KLnNyLW1ldGF7Zm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS10ZXh0LWxvKTt9Ci5zci1wcmljZXtmb250LXNpemU6MTMuNXB4O2ZvbnQtd2VpZ2h0OjcwMDt9Ci5zZWFyY2gtZW1wdHl7cGFkZGluZzoy",
  "NnB4IDE2cHg7dGV4dC1hbGlnbjpjZW50ZXI7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEzcHg7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNDUkVFTkVSIEZJTFRFUlMK",
  "ICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCi5maWx0ZXJzLWJhcnsKICBkaXNwbGF5OmZsZXg7ZmxleC13cmFwOndyYXA7Z2FwOjEwcHg7cGFkZGluZzoxNnB4O21hcmdpbi1ib3R0b206MjBw",
  "eDsKfQouZmlsdGVyLWNoaXB7CiAgZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6NHB4O3BhZGRpbmc6OXB4IDE0cHg7Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMtcyk7CiAgYmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTtib3JkZXI6MXB4",
  "IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTttaW4td2lkdGg6MTUwcHg7Cn0KLmZpbHRlci1jaGlwIGxhYmVse2ZvbnQtc2l6ZToxMC41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOjAuMDJlbTt9Ci5maWx0ZXIt",
  "Y2hpcCBzZWxlY3QsIC5maWx0ZXItY2hpcCBpbnB1dFt0eXBlPXRleHRdewogIGJhY2tncm91bmQ6bm9uZTtib3JkZXI6bm9uZTtjb2xvcjp2YXIoLS10ZXh0LWhpKTtmb250LXNpemU6MTNweDtmb250LXdlaWdodDo2MDA7b3V0bGluZTpub25lO2ZvbnQtZmFtaWx5",
  "OmluaGVyaXQ7Cn0KLnJhbmdlLXNsaWRlcnstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTthcHBlYXJhbmNlOm5vbmU7d2lkdGg6MTMwcHg7aGVpZ2h0OjNweDtib3JkZXItcmFkaXVzOjNweDtiYWNrZ3JvdW5kOnZhcigtLWJvcmRlci1zb2Z0KTtvdXRsaW5lOm5vbmU7",
  "Y3Vyc29yOnBvaW50ZXI7fQoucmFuZ2Utc2xpZGVyOjotd2Via2l0LXNsaWRlci10aHVtYnstd2Via2l0LWFwcGVhcmFuY2U6bm9uZTt3aWR0aDoxM3B4O2hlaWdodDoxM3B4O2JvcmRlci1yYWRpdXM6NTAlO2JhY2tncm91bmQ6dmFyKC0tYmx1ZS1zb2Z0KTtib3gt",
  "c2hhZG93OjAgMCAwIDNweCByZ2JhKDc2LDEyNSwyNTUsMC4yMik7Y3Vyc29yOnBvaW50ZXI7fQoucmFuZ2UtdmFse2ZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NzAwO2NvbG9yOnZhcigtLWJsdWUtc29mdCk7fQoudG9nZ2xlLWdyb3Vwe2Rpc3BsYXk6Zmxl",
  "eDtnYXA6NnB4O30KLnRvZ2dsZS1idG57CiAgcGFkZGluZzo1cHggMTFweDtib3JkZXItcmFkaXVzOjdweDtmb250LXNpemU6MTJweDtmb250LXdlaWdodDo3MDA7Y3Vyc29yOnBvaW50ZXI7CiAgYm9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7YmFj",
  "a2dyb3VuZDp2YXIoLS1iZy1iYXNlKTtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7CiAgdHJhbnNpdGlvbjphbGwgLjE2cyB2YXIoLS1lYXNlLW91dCk7Cn0KLnRvZ2dsZS1idG4uYWN0aXZle2NvbG9yOiNmZmY7Ym9yZGVyLWNvbG9yOnRyYW5zcGFyZW50O2JhY2tncm91",
  "bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpKTt9Ci5yZXNldC1maWx0ZXJze21hcmdpbi1sZWZ0OmF1dG87YWxpZ24tc2VsZjpjZW50ZXI7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEyLjVweDtmb250LXdl",
  "aWdodDo3MDA7Y3Vyc29yOnBvaW50ZXI7cGFkZGluZzo4cHggNnB4O30KLnJlc2V0LWZpbHRlcnM6aG92ZXJ7Y29sb3I6dmFyKC0tdGV4dC1oaSk7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "CiAgIFRBQkxFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwoudGFibGUtd3JhcHtvdmVyZmxvdy14OmF1dG87Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMtbCk7fQp0YWJsZS5zdG9jay10",
  "YWJsZXt3aWR0aDoxMDAlO2JvcmRlci1jb2xsYXBzZTpjb2xsYXBzZTttaW4td2lkdGg6NzYwcHg7fQouc3RvY2stdGFibGUgdGhlYWQgdGh7CiAgcG9zaXRpb246c3RpY2t5O3RvcDo2NHB4O3otaW5kZXg6NTsKICB0ZXh0LWFsaWduOnJpZ2h0O2ZvbnQtc2l6ZTox",
  "MXB4O2ZvbnQtd2VpZ2h0OjcwMDtjb2xvcjp2YXIoLS10ZXh0LWxvKTtsZXR0ZXItc3BhY2luZzowLjAyZW07CiAgcGFkZGluZzoxMnB4IDE2cHg7YmFja2dyb3VuZDpyZ2JhKDEzLDE3LDMyLDAuOTIpO2JhY2tkcm9wLWZpbHRlcjpibHVyKDEwcHgpOwogIGJvcmRl",
  "ci1ib3R0b206MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTtjdXJzb3I6cG9pbnRlcjt1c2VyLXNlbGVjdDpub25lO3doaXRlLXNwYWNlOm5vd3JhcDsKfQouc3RvY2stdGFibGUgdGhlYWQgdGg6Zmlyc3QtY2hpbGQsIC5zdG9jay10YWJsZSB0aGVhZCB0aDpu",
  "dGgtY2hpbGQoMil7dGV4dC1hbGlnbjpsZWZ0O30KLnN0b2NrLXRhYmxlIHRoZWFkIHRoOmhvdmVye2NvbG9yOnZhcigtLXRleHQtaGkpO30KLnN0b2NrLXRhYmxlIHRoZWFkIHRoIC5zb3J0LWluZHtvcGFjaXR5OjA7bWFyZ2luLWxlZnQ6NHB4O2ZvbnQtc2l6ZTo5",
  "cHg7dHJhbnNpdGlvbjpvcGFjaXR5IC4xNXM7fQouc3RvY2stdGFibGUgdGhlYWQgdGguc29ydGVkIC5zb3J0LWluZHtvcGFjaXR5OjE7Y29sb3I6dmFyKC0tYmx1ZS1zb2Z0KTt9Ci5zdG9jay10YWJsZSB0Ym9keSB0cnsKICBib3JkZXItYm90dG9tOjFweCBzb2xp",
  "ZCB2YXIoLS1ib3JkZXItaGFpcik7Y3Vyc29yOnBvaW50ZXI7CiAgdHJhbnNpdGlvbjpiYWNrZ3JvdW5kIC4xNXMgdmFyKC0tZWFzZS1vdXQpOwogIGFuaW1hdGlvbjpyb3dGYWRlIC4zcyB2YXIoLS1lYXNlLW91dCkgYm90aDsKfQouc3RvY2stdGFibGUgdGJvZHkg",
  "dHI6aG92ZXJ7YmFja2dyb3VuZDp2YXIoLS1ib3JkZXItaGFpcik7Ym94LXNoYWRvdzppbnNldCAzcHggMCAwIHZhcigtLWJsdWUtc29mdCk7fQouc3RvY2stdGFibGUgdGR7cGFkZGluZzoxM3B4IDE2cHg7dGV4dC1hbGlnbjpyaWdodDtmb250LXNpemU6MTNweDt3",
  "aGl0ZS1zcGFjZTpub3dyYXA7fQouc3RvY2stdGFibGUgdGQ6Zmlyc3QtY2hpbGQsIC5zdG9jay10YWJsZSB0ZDpudGgtY2hpbGQoMil7dGV4dC1hbGlnbjpsZWZ0O30KQGtleWZyYW1lcyByb3dGYWRle2Zyb217b3BhY2l0eTowO3RyYW5zZm9ybTp0cmFuc2xhdGVY",
  "KC00cHgpO310b3tvcGFjaXR5OjE7dHJhbnNmb3JtOnRyYW5zbGF0ZVgoMCk7fX0KLmNlbGwtY29tcGFueXtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDoxMHB4O30KLmNlbGwtdGlja2VyLWJhZGdlewogIHdpZHRoOjMwcHg7aGVpZ2h0OjMwcHg7",
  "Ym9yZGVyLXJhZGl1czo4cHg7Zm9udC1zaXplOjkuNXB4O2ZvbnQtd2VpZ2h0OjgwMDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7CiAgZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2NvbG9yOnZhcigtLWJs",
  "dWUtc29mdCk7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTUwZGVnLHZhcigtLWluZGlnby03MDApLHZhcigtLWJnLWVsZXZhdGVkLTIpKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtmbGV4LXNocmluazowOwp9Ci5jb21wYW55LW5h",
  "bWV7Zm9udC13ZWlnaHQ6NjAwO2NvbG9yOnZhcigtLXRleHQtaGkpO2ZvbnQtc2l6ZToxM3B4O30KLmNvbXBhbnktc3Vie2ZvbnQtc2l6ZToxMXB4O2NvbG9yOnZhcigtLXRleHQtbG8pO30KLmNoYW5nZS1waWxsewogIGRpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24t",
  "aXRlbXM6Y2VudGVyO2dhcDozcHg7cGFkZGluZzozcHggOHB4O2JvcmRlci1yYWRpdXM6NnB4O2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTIuNXB4O2ZvbnQtZmFtaWx5OnZhcigtLWZvbnQtbnVtKTsKfQouY2hhbmdlLXBpbGwucG9ze2NvbG9yOnZhcigtLXBv",
  "cyk7YmFja2dyb3VuZDp2YXIoLS1wb3MtYmcpO30KLmNoYW5nZS1waWxsLm5lZ3tjb2xvcjp2YXIoLS1uZWcpO2JhY2tncm91bmQ6dmFyKC0tbmVnLWJnKTt9Ci5zdGFyLWJ0bntiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y3Vyc29yOnBvaW50ZXI7Y29sb3I6",
  "dmFyKC0tdGV4dC1mYWludCk7cGFkZGluZzo0cHg7dHJhbnNpdGlvbjphbGwgLjJzIHZhcigtLWVhc2Utc3ByaW5nKTt9Ci5zdGFyLWJ0bjpob3Zlcntjb2xvcjp2YXIoLS10ZXh0LW1pZCk7dHJhbnNmb3JtOnNjYWxlKDEuMTUpO30KLnN0YXItYnRuLmFjdGl2ZXtj",
  "b2xvcjojRkZDODU3O30KLnN0YXItYnRuIHN2Z3t3aWR0aDoxNnB4O2hlaWdodDoxNnB4O30KCi8qIG1vYmlsZSBjYXJkcyAqLwouc3RvY2stY2FyZHN7ZGlzcGxheTpub25lO2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6MTBweDt9Ci5zdG9jay1jYXJkewogIHBh",
  "ZGRpbmc6MTRweCAxNnB4O2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47Z2FwOjEycHg7CiAgYW5pbWF0aW9uOnJvd0ZhZGUgLjNzIHZhcigtLWVhc2Utb3V0KSBib3RoOwp9Ci5zdG9jay1jYXJkIC5s",
  "ZWZ0e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjExcHg7bWluLXdpZHRoOjA7fQouc3RvY2stY2FyZCAubmFtZS1ibG9ja3ttaW4td2lkdGg6MDt9Ci5zdG9jay1jYXJkIC5jb21wYW55LW5hbWV7ZGlzcGxheTpibG9jaztvdmVyZmxvdzpoaWRk",
  "ZW47dGV4dC1vdmVyZmxvdzplbGxpcHNpczt3aGl0ZS1zcGFjZTpub3dyYXA7bWF4LXdpZHRoOjEzMHB4O30KLnN0b2NrLWNhcmQgLnJpZ2h0e3RleHQtYWxpZ246cmlnaHQ7ZmxleC1zaHJpbms6MDt9Ci5zdG9jay1jYXJkIC5wcmljZXtmb250LXNpemU6MTQuNXB4",
  "O2ZvbnQtd2VpZ2h0OjcwMDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNUT0NLIERFVEFJTAogICA9PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLmRldGFpbC1oZWFke2Rpc3BsYXk6ZmxleDtqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYmV0d2VlbjthbGlnbi1pdGVtczpmbGV4LXN0YXJ0O2ZsZXgtd3JhcDp3cmFwO2dhcDoyMHB4O21h",
  "cmdpbi1ib3R0b206MjZweDt9Ci5kZXRhaWwtdGl0bGUtcm93e2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjE0cHg7fQouZGV0YWlsLXRpY2tlci1iYWRnZXsKICB3aWR0aDo1MnB4O2hlaWdodDo1MnB4O2JvcmRlci1yYWRpdXM6MTRweDtmb250",
  "LXNpemU6MTVweDtmb250LXdlaWdodDo4MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pOwogIGRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjp2YXIoLS1ibHVlLXNvZnQpOwogIGJhY2tncm91bmQ6",
  "bGluZWFyLWdyYWRpZW50KDE1MGRlZyx2YXIoLS1pbmRpZ28tNzAwKSx2YXIoLS1iZy1lbGV2YXRlZC0yKSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItc29mdCk7Cn0KLmRldGFpbC1uYW1le2ZvbnQtc2l6ZToyMnB4O2ZvbnQtd2VpZ2h0OjgwMDtsZXR0",
  "ZXItc3BhY2luZzotMC4wMTVlbTt9Ci5kZXRhaWwtc3Vie2ZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bWFyZ2luLXRvcDoycHg7fQouZGV0YWlsLXByaWNlLWJsb2Nre3RleHQtYWxpZ246cmlnaHQ7fQouZGV0YWlsLXByaWNle2ZvbnQtc2l6",
  "ZTozMnB4O2ZvbnQtd2VpZ2h0OjgwMDtmb250LWZhbWlseTp2YXIoLS1mb250LW51bSk7bGV0dGVyLXNwYWNpbmc6LTAuMDFlbTt9Ci5kZXRhaWwtY2hhbmdle2ZvbnQtc2l6ZToxNHB4O2ZvbnQtd2VpZ2h0OjcwMDttYXJnaW4tdG9wOjRweDt9CgoubWV0cmljcy1n",
  "cmlke2Rpc3BsYXk6Z3JpZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDYsMWZyKTtnYXA6MTBweDttYXJnaW46MjRweCAwIDI4cHg7fQoubWV0cmljLWNhcmR7cGFkZGluZzoxNHB4IDE2cHg7fQoubWV0cmljLWxhYmVse2ZvbnQtc2l6ZToxMC41cHg7Y29s",
  "b3I6dmFyKC0tdGV4dC1sbyk7Zm9udC13ZWlnaHQ6NzAwO2xldHRlci1zcGFjaW5nOjAuMDJlbTttYXJnaW4tYm90dG9tOjZweDt9Ci5tZXRyaWMtdmFsdWV7Zm9udC1zaXplOjE1LjVweDtmb250LXdlaWdodDo3MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0p",
  "O30KCi5jaGFydC1jYXJke3BhZGRpbmc6MjJweDttYXJnaW4tYm90dG9tOjI4cHg7fQouY2hhcnQtaGVhZHtkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6Y2VudGVyO21hcmdpbi1ib3R0b206NnB4O2ZsZXgtd3Jh",
  "cDp3cmFwO2dhcDoxMnB4O30KLnJhbmdlLXRhYnN7ZGlzcGxheTpmbGV4O2dhcDoycHg7YmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTtwYWRkaW5nOjNweDtib3JkZXItcmFkaXVzOjlweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTt9Ci5yYW5n",
  "ZS10YWJzIGJ1dHRvbnsKICBib3JkZXI6bm9uZTtiYWNrZ3JvdW5kOm5vbmU7Y29sb3I6dmFyKC0tdGV4dC1sbyk7Zm9udC1zaXplOjEycHg7Zm9udC13ZWlnaHQ6NzAwO3BhZGRpbmc6NnB4IDEycHg7Ym9yZGVyLXJhZGl1czo3cHg7Y3Vyc29yOnBvaW50ZXI7CiAg",
  "dHJhbnNpdGlvbjphbGwgLjE4cyB2YXIoLS1lYXNlLW91dCk7Cn0KLnJhbmdlLXRhYnMgYnV0dG9uLmFjdGl2ZXtjb2xvcjojZmZmO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpKTt9Ci5jaGFydC1jYW52",
  "YXMtd3JhcHtwb3NpdGlvbjpyZWxhdGl2ZTtoZWlnaHQ6MjgwcHg7bWFyZ2luLXRvcDoxNHB4O30KLnZvbHVtZS13cmFwe21hcmdpbi10b3A6MTBweDt9Ci52b2x1bWUtbGFiZWx7Zm9udC1zaXplOjEwLjVweDtjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXdlaWdo",
  "dDo3MDA7bGV0dGVyLXNwYWNpbmc6MC4wMmVtO21hcmdpbi1ib3R0b206NnB4O30KI3ZvbHVtZUNoYXJ0e3dpZHRoOjEwMCU7aGVpZ2h0OjY0cHg7ZGlzcGxheTpibG9jazt9Ci5jaGFydC10b29sdGlwewogIHBvc2l0aW9uOmFic29sdXRlO3BvaW50ZXItZXZlbnRz",
  "Om5vbmU7cGFkZGluZzo4cHggMTFweDtib3JkZXItcmFkaXVzOjlweDtiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkLTIpOwogIGJvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpO2ZvbnQtc2l6ZToxMS41cHg7Ym94LXNoYWRvdzowIDE0cHggMzBw",
  "eCAtMTJweCByZ2JhKDAsMCwwLDAuNik7CiAgb3BhY2l0eTowO3RyYW5zZm9ybTp0cmFuc2xhdGUoLTUwJSwtMTE1JSk7dHJhbnNpdGlvbjpvcGFjaXR5IC4xczt3aGl0ZS1zcGFjZTpub3dyYXA7ei1pbmRleDo2Owp9Ci5jaGFydC10b29sdGlwIC50dC1wcmljZXtm",
  "b250LXdlaWdodDo3MDA7Zm9udC1mYW1pbHk6dmFyKC0tZm9udC1udW0pO2NvbG9yOnZhcigtLXRleHQtaGkpO30KLmNoYXJ0LXRvb2x0aXAgLnR0LWRhdGV7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bWFyZ2luLXRvcDoycHg7fQoKLyogPT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFdBVENITElTVAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLndhdGNobGlzdC1ncmlke2Rpc3BsYXk6Z3Jp",
  "ZDtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDMsMWZyKTtnYXA6MTRweDt9Ci50cmVuZGluZy1yb3d7ZGlzcGxheTpncmlkO2dyaWQtdGVtcGxhdGUtY29sdW1uczpyZXBlYXQoMywxZnIpO2dhcDoxNHB4O21hcmdpbi1ib3R0b206MzRweDt9Ci50cmVuZGlu",
  "Zy1jYXJke3BhZGRpbmc6MTZweCAxOHB4O2N1cnNvcjpwb2ludGVyO3RyYW5zaXRpb246dHJhbnNmb3JtIC4ycyB2YXIoLS1lYXNlLW91dCksYm9yZGVyLWNvbG9yIC4ycyB2YXIoLS1lYXNlLW91dCk7YW5pbWF0aW9uOmNhcmRJbiAuMzhzIHZhcigtLWVhc2Utc3By",
  "aW5nKSBib3RoO30KLnRyZW5kaW5nLWNhcmQ6aG92ZXJ7dHJhbnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7Ym9yZGVyLWNvbG9yOnZhcigtLWJvcmRlci1zb2Z0KTt9Ci50cmVuZGluZy10b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVu",
  "O2FsaWduLWl0ZW1zOmNlbnRlcjt9Ci53YXRjaC1jYXJke3BhZGRpbmc6MTZweCAxOHB4O3Bvc2l0aW9uOnJlbGF0aXZlO292ZXJmbG93OmhpZGRlbjt0cmFuc2l0aW9uOnRyYW5zZm9ybSAuMnMgdmFyKC0tZWFzZS1vdXQpO30KLndhdGNoLWNhcmQ6aG92ZXJ7dHJh",
  "bnNmb3JtOnRyYW5zbGF0ZVkoLTJweCk7fQoud2F0Y2gtY2FyZC5yZW1vdmluZ3thbmltYXRpb246Y2FyZE91dCAuM3MgdmFyKC0tZWFzZS1vdXQpIGZvcndhcmRzO30KQGtleWZyYW1lcyBjYXJkT3V0e3Rve29wYWNpdHk6MDt0cmFuc2Zvcm06c2NhbGUoMC45KSB0",
  "cmFuc2xhdGVZKDZweCk7fX0KLndhdGNoLWNhcmQuZW50ZXJpbmd7YW5pbWF0aW9uOmNhcmRJbiAuMzhzIHZhcigtLWVhc2Utc3ByaW5nKSBib3RoO30KQGtleWZyYW1lcyBjYXJkSW57ZnJvbXtvcGFjaXR5OjA7dHJhbnNmb3JtOnNjYWxlKDAuOSkgdHJhbnNsYXRl",
  "WSgxMHB4KTt9dG97b3BhY2l0eToxO3RyYW5zZm9ybTpzY2FsZSgxKSB0cmFuc2xhdGVZKDApO319Ci53YXRjaC10b3B7ZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmZsZXgtc3RhcnQ7bWFyZ2luLWJvdHRvbTox",
  "MHB4O30KLndhdGNoLWVtcHR5e3BhZGRpbmc6NjBweCAyMHB4O3RleHQtYWxpZ246Y2VudGVyO2dyaWQtY29sdW1uOjEvLTE7fQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNLRUxFVE9O",
  "UwogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KQGtleWZyYW1lcyBzaGltbWVyezAle2JhY2tncm91bmQtcG9zaXRpb246LTMwMHB4IDA7fTEwMCV7YmFja2dyb3VuZC1wb3NpdGlvbjozMDBw",
  "eCAwO319Ci5za2VsewogIGJvcmRlci1yYWRpdXM6OHB4OwogIGJhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLCB2YXIoLS1iZy1lbGV2YXRlZCkgMjUlLCB2YXIoLS1iZy1lbGV2YXRlZC0yKSA1MCUsIHZhcigtLWJnLWVsZXZhdGVkKSA3NSUpOwogIGJh",
  "Y2tncm91bmQtc2l6ZTozMDBweCAxMDAlOwogIGFuaW1hdGlvbjpzaGltbWVyIDEuNXMgZWFzZS1pbi1vdXQgaW5maW5pdGU7Cn0KLnNrZWwtbGluZXtoZWlnaHQ6MTJweDttYXJnaW4tYm90dG9tOjhweDt9Ci5za2VsLWNhcmR7aGVpZ2h0OjExMnB4O2JvcmRlci1y",
  "YWRpdXM6dmFyKC0tcmFkaXVzLWwpO30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBFTVBUWSAvIEVSUk9SIFNUQVRFUwogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KLnN0YXRlLWJveHsKICBkaXNwbGF5OmZsZXg7ZmxleC1kaXJlY3Rpb246Y29sdW1uO2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO3RleHQtYWxpZ246Y2VudGVyOwogIHBhZGRpbmc6",
  "NjRweCAyNHB4O2NvbG9yOnZhcigtLXRleHQtbWlkKTtnYXA6MTJweDsKfQouc3RhdGUtaWNvbnsKICB3aWR0aDo1MnB4O2hlaWdodDo1MnB4O2JvcmRlci1yYWRpdXM6MTRweDtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpj",
  "ZW50ZXI7CiAgYmFja2dyb3VuZDp2YXIoLS1iZy1lbGV2YXRlZC0yKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtjb2xvcjp2YXIoLS10ZXh0LWxvKTttYXJnaW4tYm90dG9tOjRweDsKfQouc3RhdGUtdGl0bGV7Zm9udC1zaXplOjE0LjVweDtm",
  "b250LXdlaWdodDo3MDA7Y29sb3I6dmFyKC0tdGV4dC1oaSk7fQouc3RhdGUtc3Vie2ZvbnQtc2l6ZToxMi41cHg7Y29sb3I6dmFyKC0tdGV4dC1sbyk7bWF4LXdpZHRoOjMyMHB4O30KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PQogICBCT1RUT00gTkFWIChtb2JpbGUpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwouYm90dG9tLW5hdnsKICBkaXNwbGF5Om5vbmU7cG9zaXRpb246Zml4",
  "ZWQ7bGVmdDowO3JpZ2h0OjA7Ym90dG9tOjA7ei1pbmRleDo1MDsKICBiYWNrZ3JvdW5kOnJnYmEoMTAsMTMsMjMsMC45KTtiYWNrZHJvcC1maWx0ZXI6Ymx1cigxOHB4KTsKICBib3JkZXItdG9wOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7CiAgcGFkZGlu",
  "Zzo4cHggNnB4IGNhbGMoOHB4ICsgZW52KHNhZmUtYXJlYS1pbnNldC1ib3R0b20pKTsKICBqdXN0aWZ5LWNvbnRlbnQ6c3BhY2UtYXJvdW5kOwp9Ci5ib3R0b20tbmF2IGJ1dHRvbnsKICBiYWNrZ3JvdW5kOm5vbmU7Ym9yZGVyOm5vbmU7Y29sb3I6dmFyKC0tdGV4",
  "dC1sbyk7ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjNweDsKICBmb250LXNpemU6MTBweDtmb250LXdlaWdodDo3MDA7cGFkZGluZzo2cHggMTRweDtjdXJzb3I6cG9pbnRlcjtib3JkZXItcmFkaXVzOjEx",
  "cHg7CiAgdHJhbnNpdGlvbjpjb2xvciAuMThzIHZhcigtLWVhc2Utb3V0KSwgYmFja2dyb3VuZCAuMThzIHZhcigtLWVhc2Utb3V0KTsKfQouYm90dG9tLW5hdiBidXR0b24gc3Zne3dpZHRoOjE5cHg7aGVpZ2h0OjE5cHg7dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjE4",
  "cyB2YXIoLS1lYXNlLXNwcmluZyk7fQouYm90dG9tLW5hdiBidXR0b24uYWN0aXZle2NvbG9yOnZhcigtLWJsdWUtc29mdCk7YmFja2dyb3VuZDpyZ2JhKDc2LDEyNSwyNTUsMC4xMik7fQouYm90dG9tLW5hdiBidXR0b24uYWN0aXZlIHN2Z3t0cmFuc2Zvcm06dHJh",
  "bnNsYXRlWSgtMXB4KTt9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgUkVTUE9OU0lWRQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT0gKi8KQG1lZGlhIChtYXgtd2lkdGg6IDk4MHB4KXsKICAuaGVyby1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgzLDFmcik7fQogIC5tZXRyaWNzLWdyaWR7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOnJlcGVhdCgzLDFmcik7fQogIC53YXRj",
  "aGxpc3QtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZyKTt9CiAgLnRyZW5kaW5nLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZyKTt9Cn0KLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09CiAgIEFJIEFTU0lTVEFOVCDigJQgZmxvYXRpbmcgYnV0dG9uICsgY2hhdCBwYW5lbCwgZXhwbGFpbi1zdG9jayBjYXJkCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PSAqLwouYWktZmFiewogIHBvc2l0aW9uOmZpeGVkO3JpZ2h0OjIycHg7Ym90dG9tOjIycHg7ei1pbmRleDo2MDsKICB3aWR0aDo1MnB4O2hlaWdodDo1MnB4O2JvcmRlci1yYWRpdXM6MTZweDtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1zb2Z0KTsKICBi",
  "YWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxNTBkZWcsdmFyKC0tYmx1ZSksdmFyKC0tdmlvbGV0KSA3MCUsdmFyKC0tY3lhbikpOwogIGNvbG9yOiNmZmY7ZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtqdXN0aWZ5LWNvbnRlbnQ6Y2VudGVyO2N1cnNv",
  "cjpwb2ludGVyOwogIGJveC1zaGFkb3c6MCAxNHB4IDM0cHggLTEycHggcmdiYSg3NiwxMjUsMjU1LDAuNTUpOwogIHRyYW5zaXRpb246dHJhbnNmb3JtIC4ycyB2YXIoLS1lYXNlLXNwcmluZyk7Cn0KLmFpLWZhYjpob3Zlcnt0cmFuc2Zvcm06dHJhbnNsYXRlWSgt",
  "MnB4KSBzY2FsZSgxLjA0KTt9Ci5haS1mYWIgc3Zne3dpZHRoOjIycHg7aGVpZ2h0OjIycHg7fQouYWktZmFiLmhpZGRlbiwgLmFpLXBhbmVsLmhpZGRlbntkaXNwbGF5Om5vbmU7fQoKLmFpLXBhbmVsewogIHBvc2l0aW9uOmZpeGVkO3JpZ2h0OjIycHg7Ym90dG9t",
  "Ojg4cHg7ei1pbmRleDo2MTsKICB3aWR0aDozNjBweDttYXgtd2lkdGg6Y2FsYygxMDB2dyAtIDMycHgpO2hlaWdodDptaW4oNTIwcHgsIDcwdmgpOwogIGRpc3BsYXk6ZmxleDtmbGV4LWRpcmVjdGlvbjpjb2x1bW47Ym9yZGVyLXJhZGl1czp2YXIoLS1yYWRpdXMt",
  "bCk7b3ZlcmZsb3c6aGlkZGVuOwogIGJhY2tncm91bmQ6dmFyKC0tYmctZWxldmF0ZWQpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpOwogIGJveC1zaGFkb3c6MCAzMHB4IDcwcHggLTIwcHggcmdiYSgwLDAsMCwwLjY1KTsKICBhbmltYXRpb246",
  "cGFuZWxJbiAuMjhzIHZhcigtLWVhc2Utb3V0KTsKfQouYWktcGFuZWwuaGlkZGVue2Rpc3BsYXk6bm9uZTt9CkBrZXlmcmFtZXMgcGFuZWxJbntmcm9te29wYWNpdHk6MDt0cmFuc2Zvcm06dHJhbnNsYXRlWSgxMHB4KSBzY2FsZSgwLjk4KTt9dG97b3BhY2l0eTox",
  "O3RyYW5zZm9ybTp0cmFuc2xhdGVZKDApIHNjYWxlKDEpO319Ci5haS1wYW5lbC1oZWFke2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47cGFkZGluZzoxMnB4IDE0cHg7Ym9yZGVyLWJvdHRvbToxcHgg",
  "c29saWQgdmFyKC0tYm9yZGVyLWhhaXIpO2ZsZXgtc2hyaW5rOjA7fQouYWktYXZhdGFye3dpZHRoOjI4cHg7aGVpZ2h0OjI4cHg7Ym9yZGVyLXJhZGl1czo5cHg7YmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTUwZGVnLHZhcigtLWJsdWUpLHZhcigtLXZpb2xl",
  "dCkpO2Rpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7anVzdGlmeS1jb250ZW50OmNlbnRlcjtjb2xvcjojZmZmO2ZvbnQtc2l6ZToxNHB4O2ZsZXgtc2hyaW5rOjA7fQouYWktbWVzc2FnZXN7ZmxleDoxO292ZXJmbG93LXk6YXV0bztwYWRkaW5nOjE0cHg7",
  "ZGlzcGxheTpmbGV4O2ZsZXgtZGlyZWN0aW9uOmNvbHVtbjtnYXA6MTBweDt9Ci5haS1tc2d7Zm9udC1zaXplOjEzcHg7bGluZS1oZWlnaHQ6MS41O3BhZGRpbmc6MTBweCAxMnB4O2JvcmRlci1yYWRpdXM6MTFweDttYXgtd2lkdGg6ODglO3doaXRlLXNwYWNlOnBy",
  "ZS13cmFwO30KLmFpLW1zZy5hc3Npc3RhbnR7YmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTtib3JkZXI6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7YWxpZ24tc2VsZjpmbGV4LXN0YXJ0O30KLmFpLW1zZy51c2Vye2Jh",
  "Y2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDEzNWRlZyx2YXIoLS1ibHVlKSx2YXIoLS12aW9sZXQpKTtjb2xvcjojZmZmO2FsaWduLXNlbGY6ZmxleC1lbmQ7fQouYWktbXNnLnBlbmRpbmd7Y29sb3I6dmFyKC0tdGV4dC1mYWludCk7Zm9udC1zdHlsZTppdGFsaWM7",
  "fQouYWktbXNnLmVycm9ye2JhY2tncm91bmQ6dmFyKC0tbmVnLWJnKTtib3JkZXI6MXB4IHNvbGlkIHJnYmEoMjUxLDEwNywxMDcsMC4zKTtjb2xvcjp2YXIoLS1uZWctc29mdCk7YWxpZ24tc2VsZjpmbGV4LXN0YXJ0O30KLmFpLWlucHV0LXJvd3tkaXNwbGF5OmZs",
  "ZXg7Z2FwOjhweDtwYWRkaW5nOjEwcHg7Ym9yZGVyLXRvcDoxcHggc29saWQgdmFyKC0tYm9yZGVyLWhhaXIpO2ZsZXgtc2hyaW5rOjA7fQouYWktaW5wdXQtcm93IGlucHV0e2ZsZXg6MTtiYWNrZ3JvdW5kOnZhcigtLWJnLWJhc2UpO2JvcmRlcjoxcHggc29saWQg",
  "dmFyKC0tYm9yZGVyLWhhaXIpO2JvcmRlci1yYWRpdXM6MTBweDtwYWRkaW5nOjlweCAxMnB4O2NvbG9yOnZhcigtLXRleHQtaGkpO2ZvbnQtc2l6ZToxM3B4O2ZvbnQtZmFtaWx5OnZhcigtLWZvbnQtdWkpO291dGxpbmU6bm9uZTt9Ci5haS1pbnB1dC1yb3cgaW5w",
  "dXQ6Zm9jdXN7Ym9yZGVyLWNvbG9yOnJnYmEoMTI0LDE1MCwyNTUsMC41KTt9Ci5haS1zZW5kLWJ0bnt3aWR0aDozOHB4O2hlaWdodDozOHB4O2JvcmRlci1yYWRpdXM6MTBweDtib3JkZXI6bm9uZTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCgxMzVkZWcsdmFy",
  "KC0tYmx1ZSksdmFyKC0tdmlvbGV0KSk7Y29sb3I6I2ZmZjtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2p1c3RpZnktY29udGVudDpjZW50ZXI7Y3Vyc29yOnBvaW50ZXI7ZmxleC1zaHJpbms6MDt9Ci5haS1zZW5kLWJ0bjpkaXNhYmxlZHtvcGFjaXR5",
  "OjAuNTtjdXJzb3I6ZGVmYXVsdDt9Ci5haS1zZW5kLWJ0biBzdmd7d2lkdGg6MTVweDtoZWlnaHQ6MTVweDt9CgouYWktcXVlcnktYm94e3BhZGRpbmc6MTRweCAxNnB4O21hcmdpbi1ib3R0b206MThweDt9Ci5haS1xdWVyeS1yb3d7ZGlzcGxheTpmbGV4O2FsaWdu",
  "LWl0ZW1zOmNlbnRlcjtnYXA6MTBweDt9Ci5haS1xdWVyeS1yb3cgaW5wdXR7CiAgZmxleDoxO2JhY2tncm91bmQ6dmFyKC0tYmctYmFzZSk7Ym9yZGVyOjFweCBzb2xpZCB2YXIoLS1ib3JkZXItaGFpcik7Ym9yZGVyLXJhZGl1czo5cHg7CiAgcGFkZGluZzo5cHgg",
  "MTJweDtjb2xvcjp2YXIoLS10ZXh0LWhpKTtmb250LXNpemU6MTNweDtmb250LWZhbWlseTp2YXIoLS1mb250LXVpKTtvdXRsaW5lOm5vbmU7CiAgdHJhbnNpdGlvbjpib3JkZXItY29sb3IgLjE4cyB2YXIoLS1lYXNlLW91dCk7Cn0KLmFpLXF1ZXJ5LXJvdyBpbnB1",
  "dDpmb2N1c3tib3JkZXItY29sb3I6cmdiYSgxMjQsMTUwLDI1NSwwLjUpO30KLmFpLXF1ZXJ5LWJ0bnsKICBwYWRkaW5nOjlweCAxNnB4O2JvcmRlci1yYWRpdXM6OXB4O2JvcmRlcjpub25lO2ZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTIuNXB4O2NvbG9yOiNm",
  "ZmY7Y3Vyc29yOnBvaW50ZXI7CiAgYmFja2dyb3VuZDpsaW5lYXItZ3JhZGllbnQoMTM1ZGVnLHZhcigtLWJsdWUpLHZhcigtLXZpb2xldCkpO2ZsZXgtc2hyaW5rOjA7dHJhbnNpdGlvbjp0cmFuc2Zvcm0gLjE1cyB2YXIoLS1lYXNlLW91dCk7Cn0KLmFpLXF1ZXJ5",
  "LWJ0bjpob3Zlcnt0cmFuc2Zvcm06dHJhbnNsYXRlWSgtMXB4KTt9Ci5haS1xdWVyeS1idG46ZGlzYWJsZWR7b3BhY2l0eTowLjY7Y3Vyc29yOmRlZmF1bHQ7dHJhbnNmb3JtOm5vbmU7fQouYWktcXVlcnktYW5zd2Vye21hcmdpbi10b3A6MTJweDtwYWRkaW5nLXRv",
  "cDoxMnB4O2JvcmRlci10b3A6MXB4IHNvbGlkIHZhcigtLWJvcmRlci1oYWlyKTtkaXNwbGF5OmZsZXg7Z2FwOjEwcHg7YWxpZ24taXRlbXM6ZmxleC1zdGFydDtmb250LXNpemU6MTNweDtsaW5lLWhlaWdodDoxLjY7Y29sb3I6dmFyKC0tdGV4dC1taWQpO30KCi5l",
  "eHBsYWluLWNhcmR7cGFkZGluZzoxOHB4IDIwcHg7bWFyZ2luLXRvcDoxNHB4O30KLmV4cGxhaW4taGVhZHtkaXNwbGF5OmZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo5cHg7bWFyZ2luLWJvdHRvbToxMHB4O30KLmV4cGxhaW4tdGV4dHtmb250LXNpemU6MTMu",
  "NXB4O2xpbmUtaGVpZ2h0OjEuNjU7Y29sb3I6dmFyKC0tdGV4dC1taWQpO3doaXRlLXNwYWNlOnByZS13cmFwO30KLmV4cGxhaW4tYnRuewogIGRpc3BsYXk6aW5saW5lLWZsZXg7YWxpZ24taXRlbXM6Y2VudGVyO2dhcDo3cHg7cGFkZGluZzo4cHggMTRweDtib3Jk",
  "ZXItcmFkaXVzOjlweDsKICBiYWNrZ3JvdW5kOnZhcigtLWJnLWVsZXZhdGVkLTIpO2JvcmRlcjoxcHggc29saWQgdmFyKC0tYm9yZGVyLXNvZnQpO2NvbG9yOnZhcigtLXRleHQtaGkpOwogIGZvbnQtc2l6ZToxMi41cHg7Zm9udC13ZWlnaHQ6NzAwO2N1cnNvcjpw",
  "b2ludGVyO3RyYW5zaXRpb246YWxsIC4xOHMgdmFyKC0tZWFzZS1vdXQpOwp9Ci5leHBsYWluLWJ0bjpob3Zlcntib3JkZXItY29sb3I6cmdiYSgxMjQsMTUwLDI1NSwwLjUpO3RyYW5zZm9ybTp0cmFuc2xhdGVZKC0xcHgpO30KLmV4cGxhaW4tYnRuIHN2Z3t3aWR0",
  "aDoxNHB4O2hlaWdodDoxNHB4O30KLmV4cGxhaW4tYnRuOmRpc2FibGVke29wYWNpdHk6MC41O2N1cnNvcjpkZWZhdWx0O3RyYW5zZm9ybTpub25lO30KCkBtZWRpYSAobWF4LXdpZHRoOiA2NDBweCl7CiAgI2JhY2tlbmRCYWRnZXtkaXNwbGF5Om5vbmU7fQogIC5h",
  "aS1wYW5lbHtyaWdodDoxMnB4O2xlZnQ6MTJweDt3aWR0aDphdXRvO2JvdHRvbTo4MHB4O30KICAuYWktZmFie3JpZ2h0OjE2cHg7Ym90dG9tOjc2cHg7fQp9CkBtZWRpYSAobWF4LXdpZHRoOiA3NjBweCl7CiAgbmF2Lm1haW5uYXZ7ZGlzcGxheTpub25lO30KICBo",
  "ZWFkZXIudG9wYmFye3BhZGRpbmc6MCAxNnB4O2hlaWdodDo1OHB4O2dhcDoxNHB4O30KICBtYWlue3BhZGRpbmc6MjBweCAxNnB4IDk2cHg7fQogIC5oZXJvLXJvd3tncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZyKTtnYXA6MTBweDt9CiAgLm1ldHJp",
  "Y3MtZ3JpZHtncmlkLXRlbXBsYXRlLWNvbHVtbnM6cmVwZWF0KDIsMWZyKTt9CiAgLndhdGNobGlzdC1ncmlke2dyaWQtdGVtcGxhdGUtY29sdW1uczoxZnI7fQogIC50cmVuZGluZy1yb3d7Z3JpZC10ZW1wbGF0ZS1jb2x1bW5zOjFmcjt9CiAgLnRhYmxlLXdyYXB7",
  "ZGlzcGxheTpub25lO30KICAuc3RvY2stY2FyZHN7ZGlzcGxheTpmbGV4O30KICAuYm90dG9tLW5hdntkaXNwbGF5OmZsZXg7fQogIC5kZXRhaWwtcHJpY2UtYmxvY2t7dGV4dC1hbGlnbjpsZWZ0O30KICAuZGV0YWlsLWhlYWR7ZmxleC1kaXJlY3Rpb246Y29sdW1u",
  "O30KICAuZmlsdGVycy1iYXJ7cGFkZGluZzoxMnB4O30KICAuZmlsdGVyLWNoaXB7bWluLXdpZHRoOjQ0JTtmbGV4OjE7fQp9Cjwvc3R5bGU+CjwvaGVhZD4KPGJvZHk+Cgo8ZGl2IGNsYXNzPSJhbWJpZW50Ij4KICA8ZGl2IGNsYXNzPSJhbWJpZW50LWdyaWQiPjwv",
  "ZGl2PgogIDxzdmcgY2xhc3M9ImFtYmllbnQtbGluZXMiIGlkPSJhbWJpZW50TGluZXMiIHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiPjwvc3ZnPgo8L2Rpdj4KCjxoZWFkZXIgY2xhc3M9InRvcGJhciIgaWQ9InRvcGJhciI+CiAgPGRpdiBjbGFzcz0iYnJhbmQi",
  "PgogICAgPGRpdiBjbGFzcz0iYnJhbmQtbWFyayI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIj4KICAgICAgICA8ZGVmcz4KICAgICAgICAgIDxsaW5lYXJHcmFkaWVudCBpZD0ibG9nb0dyYWQiIHgxPSIyIiB5MT0iMjAiIHgyPSIy",
  "MiIgeTI9IjQiIGdyYWRpZW50VW5pdHM9InVzZXJTcGFjZU9uVXNlIj4KICAgICAgICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iIzRDN0RGRiIvPgogICAgICAgICAgICA8c3RvcCBvZmZzZXQ9IjU1JSIgc3RvcC1jb2xvcj0iIzhCNkJGMCIvPgog",
  "ICAgICAgICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiMzMUQ1RUUiLz4KICAgICAgICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgICAgICAgPC9kZWZzPgogICAgICAgIDxyZWN0IHg9IjIuNSIgeT0iMTMiIHdpZHRoPSI0IiBoZWlnaHQ9IjguNSIg",
  "cng9IjEuMiIgZmlsbD0idXJsKCNsb2dvR3JhZCkiIG9wYWNpdHk9IjAuNTUiLz4KICAgICAgICA8cmVjdCB4PSIxMCIgeT0iOCIgd2lkdGg9IjQiIGhlaWdodD0iMTMuNSIgcng9IjEuMiIgZmlsbD0idXJsKCNsb2dvR3JhZCkiIG9wYWNpdHk9IjAuOCIvPgogICAg",
  "ICAgIDxyZWN0IHg9IjE3LjUiIHk9IjIuNSIgd2lkdGg9IjQiIGhlaWdodD0iMTkiIHJ4PSIxLjIiIGZpbGw9InVybCgjbG9nb0dyYWQpIi8+CiAgICAgIDwvc3ZnPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJicmFuZC13b3JkbWFyayI+PHNwYW4+PHNwYW4g",
  "Y2xhc3M9ImVxIj5FcXVpdHk8L3NwYW4+PHNwYW4gY2xhc3M9InNjYW4iPlNjYW48L3NwYW4+PC9zcGFuPjxzbWFsbD5NQVJLRVQgSU5URUxMSUdFTkNFPC9zbWFsbD48L2Rpdj4KICA8L2Rpdj4KICA8bmF2IGNsYXNzPSJtYWlubmF2IiBpZD0ibWFpbk5hdiI+CiAg",
  "ICA8YnV0dG9uIGRhdGEtdmlldz0iZGFzaGJvYXJkIj5EYXNoYm9hcmQ8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS12aWV3PSJzY3JlZW5lciI+U2NyZWVuZXI8L2J1dHRvbj4KICAgIDxidXR0b24gZGF0YS12aWV3PSJtYXJrZXRzIj5NYXJrZXRzPC9idXR0b24+",
  "CiAgICA8YnV0dG9uIGRhdGEtdmlldz0id2F0Y2hsaXN0Ij5XYXRjaGxpc3Q8L2J1dHRvbj4KICA8L25hdj4KICA8ZGl2IGNsYXNzPSJoZWFkZXItcmlnaHQiPgogICAgPGRpdiBjbGFzcz0ibWFya2V0LXBpbGwiPjxzcGFuIGNsYXNzPSJkb3QtbGl2ZSI+PC9zcGFu",
  "PjxzcGFuIGlkPSJtYXJrZXRTdGF0dXNUZXh0Ij5NYXJrZXQgT3Blbjwvc3Bhbj48L2Rpdj4KICAgIDxkaXYgY2xhc3M9Im1hcmtldC1waWxsIiBpZD0iYmFja2VuZEJhZGdlIiB0aXRsZT0iQ2hlY2tpbmcgYmFja2VuZCBjb25uZWN0aW9u4oCmIj48c3BhbiBjbGFz",
  "cz0iZG90LWxpdmUiPjwvc3Bhbj48c3Bhbj5DaGVja2luZ+KApjwvc3Bhbj48L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiBpZD0ic2VhcmNoVG9nZ2xlQnRuIiB0aXRsZT0iU2VhcmNoICgvKSI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0",
  "IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEgMjFsLTQuMy00LjMiLz48L3N2Zz4KICAgIDwvYnV0",
  "dG9uPgogICAgPGJ1dHRvbiBjbGFzcz0iaWNvbi1idG4iIHRpdGxlPSJTZXR0aW5ncyI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0i",
  "cm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxjaXJjbGUgY3g9IjEyIiBjeT0iMTIiIHI9IjMiLz48cGF0aCBkPSJNMTkuNCAxNWExLjY1IDEuNjUgMCAwMC4zMyAxLjgybC4wNi4wNmEyIDIgMCAxMS0yLjgzIDIuODNsLS4wNi0uMDZhMS42NSAxLjY1IDAg",
  "MDAtMS44Mi0uMzMgMS42NSAxLjY1IDAgMDAtMSAxLjUxVjIxYTIgMiAwIDAxLTQgMHYtLjA5QTEuNjUgMS42NSAwIDAwOSAxOS40YTEuNjUgMS42NSAwIDAwLTEuODIuMzNsLS4wNi4wNmEyIDIgMCAxMS0yLjgzLTIuODNsLjA2LS4wNkExLjY1IDEuNjUgMCAwMDQu",
  "NiAxNWExLjY1IDEuNjUgMCAwMC0xLjUxLTFIM2EyIDIgMCAwMTAtNGguMDlBMS42NSAxLjY1IDAgMDA0LjYgOWExLjY1IDEuNjUgMCAwMC0uMzMtMS44MmwtLjA2LS4wNmEyIDIgMCAxMTIuODMtMi44M2wuMDYuMDZBMS42NSAxLjY1IDAgMDA5IDQuNmExLjY1IDEu",
  "NjUgMCAwMDEtMS41MVYzYTIgMiAwIDAxNCAwdi4wOWExLjY1IDEuNjUgMCAwMDEgMS41MSAxLjY1IDEuNjUgMCAwMDEuODItLjMzbC4wNi0uMDZhMiAyIDAgMTEyLjgzIDIuODNsLS4wNi4wNkExLjY1IDEuNjUgMCAwMDE5LjQgOWExLjY1IDEuNjUgMCAwMDEuNTEg",
  "MUgyMWEyIDIgMCAwMTAgNGgtLjA5YTEuNjUgMS42NSAwIDAwLTEuNTEgMXoiLz48L3N2Zz4KICAgIDwvYnV0dG9uPgogIDwvZGl2Pgo8L2hlYWRlcj4KCjxtYWluIGlkPSJtYWluUm9vdCI+PC9tYWluPgoKPG5hdiBjbGFzcz0iYm90dG9tLW5hdiIgaWQ9ImJvdHRv",
  "bU5hdiI+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9ImRhc2hib2FyZCI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxyZWN0IHg9IjMiIHk9IjMiIHdpZHRoPSI3IiBoZWlnaHQ9",
  "IjkiIHJ4PSIxLjUiLz48cmVjdCB4PSIxNCIgeT0iMyIgd2lkdGg9IjciIGhlaWdodD0iNSIgcng9IjEuNSIvPjxyZWN0IHg9IjE0IiB5PSIxMiIgd2lkdGg9IjciIGhlaWdodD0iOSIgcng9IjEuNSIvPjxyZWN0IHg9IjMiIHk9IjE2IiB3aWR0aD0iNyIgaGVpZ2h0",
  "PSI1IiByeD0iMS41Ii8+PC9zdmc+RGFzaGJvYXJkPC9idXR0b24+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9InNjcmVlbmVyIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBh",
  "dGggZD0iTTQgNmgxNk03IDEyaDEwTTEwIDE4aDQiLz48L3N2Zz5TY3JlZW5lcjwvYnV0dG9uPgogIDxidXR0b24gZGF0YS12aWV3PSJtYXJrZXRzIj48c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9r",
  "ZS13aWR0aD0iMiI+PHBhdGggZD0iTTMgMTdsNi02IDQgNCA4LTgiLz48L3N2Zz5NYXJrZXRzPC9idXR0b24+CiAgPGJ1dHRvbiBkYXRhLXZpZXc9IndhdGNobGlzdCI+PHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENv",
  "bG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9zdmc+V2F0Y2hsaXN0PC9idXR0b24+CjwvbmF2PgoK",
  "PGJ1dHRvbiBjbGFzcz0iYWktZmFiIiBpZD0iYWlGYWIiIHRpdGxlPSJBc2sgdGhlIEVxdWl0eVNjYW4gQXNzaXN0YW50Ij4KICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIg",
  "c3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5kIj48cGF0aCBkPSJNMTIgOFY0SDgiLz48cmVjdCB4PSI0IiB5PSI4IiB3aWR0aD0iMTYiIGhlaWdodD0iMTIiIHJ4PSIyIi8+PHBhdGggZD0iTTIgMTRoMk0yMCAxNGgyTTkgMTN2Mk0x",
  "NSAxM3YyIi8+PC9zdmc+CjwvYnV0dG9uPgoKPGRpdiBjbGFzcz0iYWktcGFuZWwiIGlkPSJhaVBhbmVsIj4KICA8ZGl2IGNsYXNzPSJhaS1wYW5lbC1oZWFkIj4KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6ZmxleDthbGlnbi1pdGVtczpjZW50ZXI7Z2FwOjlweDsi",
  "PgogICAgICA8ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTMuNXB4OyI+RXF1aXR5U2NhbiBBc3Npc3RhbnQ8L2Rpdj4KICAgICAgICA8ZGl2IHN0",
  "eWxlPSJmb250LXNpemU6MTAuNXB4O2NvbG9yOnZhcigtLXRleHQtbG8pOyIgaWQ9ImFpU3RhdHVzTGluZSI+Q2hlY2tpbmfigKY8L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxidXR0b24gY2xhc3M9Imljb24tYnRuIiBpZD0iYWlDbG9zZUJ0biIg",
  "c3R5bGU9IndpZHRoOjMwcHg7aGVpZ2h0OjMwcHg7Ij4KICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PHBhdGggZD0iTTE4",
  "IDZMNiAxOE02IDZsMTIgMTIiLz48L3N2Zz4KICAgIDwvYnV0dG9uPgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImFpLW1lc3NhZ2VzIiBpZD0iYWlNZXNzYWdlcyI+CiAgICA8ZGl2IGNsYXNzPSJhaS1tc2cgYXNzaXN0YW50Ij5IaSDigJQgYXNrIG1lIGFib3V0IGEg",
  "c3RvY2sncyBudW1iZXJzLCB5b3VyIHdhdGNobGlzdCwgb3Igd2hhdCdzIGhhcHBlbmluZyBvbiB0aGUgZGFzaGJvYXJkIHJpZ2h0IG5vdy4gSSBvbmx5IGtub3cgd2hhdCdzIGxvYWRlZCBpbiB0aGUgYXBwLCBhbmQgSSB3b24ndCB0ZWxsIHlvdSB3aGF0IHRvIGJ1",
  "eSBvciBzZWxsLjwvZGl2PgogIDwvZGl2PgogIDxkaXYgY2xhc3M9ImFpLWlucHV0LXJvdyI+CiAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImFpSW5wdXQiIHBsYWNlaG9sZGVyPSJBc2sgYWJvdXQgdGhlIGRhdGHigKYiIGF1dG9jb21wbGV0ZT0ib2ZmIj4KICAg",
  "IDxidXR0b24gY2xhc3M9ImFpLXNlbmQtYnRuIiBpZD0iYWlTZW5kQnRuIiB0aXRsZT0iU2VuZCI+CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGlu",
  "ZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiPjxwYXRoIGQ9Ik0yMiAyTDExIDEzTTIyIDJsLTcgMjAtNC05LTktNCAyMC03eiIvPjwvc3ZnPgogICAgPC9idXR0b24+CiAgPC9kaXY+CjwvZGl2PgoKPHNjcmlwdD4KInVzZSBzdHJpY3QiOwoKLyog",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBWSVNJQkxFIEVSUk9SIERJQUdOT1NUSUNTIOKAlCBzaG93cyB1bmNhdWdodCBlcnJvcnMgb24tc2NyZWVuIHNvIHRoZXkKICAgY2FuIGJlIHJl",
  "YWQvcmVwb3J0ZWQgd2l0aG91dCBvcGVuaW5nIGJyb3dzZXIgZGV2IHRvb2xzLiBTYWZlIHRvCiAgIGxlYXZlIGluOyBpdCBvbmx5IGFwcGVhcnMgd2hlbiBzb21ldGhpbmcgYWN0dWFsbHkgdGhyb3dzLgogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmZ1bmN0aW9uIHNob3dFcnJvckJhbm5lcihtc2cpewogIGxldCBiYW5uZXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZXJyQmFubmVyIik7CiAgaWYoIWJhbm5lcil7CiAgICBiYW5uZXIgPSBk",
  "b2N1bWVudC5jcmVhdGVFbGVtZW50KCJkaXYiKTsKICAgIGJhbm5lci5pZCA9ICJlcnJCYW5uZXIiOwogICAgYmFubmVyLnN0eWxlLmNzc1RleHQgPSAicG9zaXRpb246Zml4ZWQ7bGVmdDoxMnB4O3JpZ2h0OjEycHg7Ym90dG9tOjEycHg7ei1pbmRleDo5OTk7YmFj",
  "a2dyb3VuZDojMmEwZTE0O2JvcmRlcjoxcHggc29saWQgI0ZCNkI2Qjtjb2xvcjojRkZEOUQ5O3BhZGRpbmc6MTJweCAxNHB4O2JvcmRlci1yYWRpdXM6MTBweDtmb250LXNpemU6MTJweDtmb250LWZhbWlseTptb25vc3BhY2U7bWF4LWhlaWdodDozNXZoO292ZXJm",
  "bG93OmF1dG87Ym94LXNoYWRvdzowIDIwcHggNTBweCByZ2JhKDAsMCwwLDAuNSk7IjsKICAgIGRvY3VtZW50LmJvZHkuYXBwZW5kQ2hpbGQoYmFubmVyKTsKICB9CiAgY29uc3QgbGluZSA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoImRpdiIpOwogIGxpbmUuc3R5",
  "bGUubWFyZ2luQm90dG9tID0gIjZweCI7CiAgbGluZS50ZXh0Q29udGVudCA9IG5ldyBEYXRlKCkudG9Mb2NhbGVUaW1lU3RyaW5nKCkgKyAiIOKAlCAiICsgbXNnOwogIGJhbm5lci5hcHBlbmRDaGlsZChsaW5lKTsKfQp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigi",
  "ZXJyb3IiLCAoZSk9PiBzaG93RXJyb3JCYW5uZXIoIkpTIGVycm9yOiAiICsgKGUubWVzc2FnZXx8ZSkpKTsKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInVuaGFuZGxlZHJlamVjdGlvbiIsIChlKT0+IHNob3dFcnJvckJhbm5lcigiVW5oYW5kbGVkIHByb21pc2Ug",
  "cmVqZWN0aW9uOiAiICsgKGUucmVhc29uICYmIGUucmVhc29uLm1lc3NhZ2UgfHwgZS5yZWFzb24pKSk7CgovLyBTYWZlIERPTSB0ZXh0IHNldHRlciDigJQgc2V2ZXJhbCB1cGRhdGVzIGhlcmUgY29tZSBmcm9tIGRlYm91bmNlZC9hc3luYwovLyBjYWxsYmFja3Mg",
  "KHNlYXJjaCB0eXBpbmcsIGZpbHRlciBjaGFuZ2VzKSB0aGF0IGNhbiByZXNvbHZlIGFmdGVyIHRoZSB1c2VyCi8vIGhhcyBhbHJlYWR5IG5hdmlnYXRlZCB0byBhIGRpZmZlcmVudCB2aWV3LCBhdCB3aGljaCBwb2ludCB0aGUgdGFyZ2V0Ci8vIGVsZW1lbnQgbm8g",
  "bG9uZ2VyIGV4aXN0cy4gVGhpcyBqdXN0IG5vLW9wcyBpbnN0ZWFkIG9mIHRocm93aW5nLgpmdW5jdGlvbiBzZXRUZXh0KGlkLCB0ZXh0KXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGlkKTsKICBpZihlbCkgZWwudGV4dENvbnRlbnQgPSB0",
  "ZXh0Owp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIElOVEVHUkFUSU9OIExBWUVSCiAgIFRoaXMgZnJvbnRlbmQgbm93IHRhbGtzIHRvIGEgcmVhbCBFcXVpdHlTY2FuIGJhY2tl",
  "bmQgKHNlZSAvYmFja2VuZCkKICAgd2hpY2ggcHJveGllcyBOU0UgdmlhIHN0b2NrLW5zZS1pbmRpYSwgY2FjaGVkIGFuZCBidWRnZXQtbGltaXRlZCB0bwogICB+NTAgdXBzdHJlYW0gY2FsbHMvZGF5LiBFdmVyeSBBUEkuKiBtZXRob2QgYmVsb3cgdHJpZXMgdGhl",
  "IGxpdmUKICAgYmFja2VuZCBmaXJzdCBhbmQgZmFsbHMgYmFjayB0byBkZXRlcm1pbmlzdGljIG1vY2sgZGF0YSBpZiB0aGUKICAgYmFja2VuZCBpcyB1bnJlYWNoYWJsZSDigJQgd2hpY2ggaXMgZXhwZWN0ZWQgd2hlbiB0aGlzIHBhZ2UgaXMgb3BlbmVkCiAgIGFz",
  "IGEgaG9zdGVkIHByZXZpZXcsIHNpbmNlIGEgcHVibGlzaGVkIHBhZ2UgY2Fubm90IHJlYWNoIGEKICAgbG9jYWxob3N0IHNlcnZlci4gUnVuIHRoZSBiYWNrZW5kIGFuZCBvcGVuIHRoaXMgZmlsZSBsb2NhbGx5IChub3QKICAgdGhlIHB1Ymxpc2hlZCBwcmV2aWV3",
  "KSB0byBzZWUgcmVhbCBOU0UgcXVvdGVzIGVuZCB0byBlbmQuCiAgIFRoZSBiYWNrZW5kIGhhcyBubyBoaXN0b3JpY2FsLXByaWNlIGVuZHBvaW50IHlldCwgc28gY2hhcnQgc2VyaWVzCiAgIGFuZCBzcGFya2xpbmVzIHN0YXkgc3ludGhldGljIGV2ZW4gaW4gbGl2",
  "ZSBtb2RlIOKAlCBldmVyeXRoaW5nIGVsc2UKICAgKHByaWNlLCBjaGFuZ2UgJSwgNTJXIGhpZ2gvbG93LCBjb21wYW55IG5hbWUsIG1hcmtldCBzdGF0dXMpIGlzCiAgIHJlYWwgd2hlbiB0aGUgYmFja2VuZCBpcyByZWFjaGFibGUuCiAgID09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3QgQ09ORklHID0gewogIEFQSV9CQVNFOiAod2luZG93LmxvY2F0aW9uLnByb3RvY29sID09PSAiZmlsZToiID8gImh0dHA6Ly9sb2NhbGhvc3Q6MzAwMCIgOiB3",
  "aW5kb3cubG9jYXRpb24ub3JpZ2luKSArICIvYXBpIiwKICBMSVZFX1RJTUVPVVRfTVM6IDgwMDAsCiAgLy8gUmVuZGVyJ3MgZnJlZSB0aWVyIHNwaW5zIHRoZSBzZXJ2ZXIgZG93biBhZnRlciB+MTUgbWluIGlkbGUsIGFuZCB3YWtpbmcKICAvLyBpdCBiYWNrIHVw",
  "IGNhbiB0YWtlIDMwLTUwcy4gVGhlIGhlYWx0aCBjaGVjayBuZWVkcyBhIG11Y2ggbG9uZ2VyIGxlYXNoCiAgLy8gdGhhbiBhIG5vcm1hbCBkYXRhIHJlcXVlc3QsIG9yIGl0IHdyb25nbHkgY29uY2x1ZGVzICJiYWNrZW5kIGlzIGRvd24iCiAgLy8gZHVyaW5nIGV4",
  "YWN0bHkgdGhlIG1vbWVudCBpdCdzIGp1c3Qgc2xvd2x5IHN0YXJ0aW5nIHVwLgogIEhFQUxUSF9USU1FT1VUX01TOiA0NTAwMCwKfTsKbGV0IGxpdmVCYWNrZW5kQXZhaWxhYmxlID0gZmFsc2U7CmNvbnN0IE1PQ0tfTEFURU5DWSA9IDQyMDsKCmZ1bmN0aW9uIGZl",
  "dGNoV2l0aFRpbWVvdXQodXJsLCBtcyl7CiAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTsKICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCk9PmN0cmwuYWJvcnQoKSwgbXMpOwogIHJldHVybiBmZXRjaCh1cmwsIHtzaWduYWw6IGN0cmwuc2lnbmFs",
  "fSkuZmluYWxseSgoKT0+Y2xlYXJUaW1lb3V0KGlkKSk7Cn0KCmFzeW5jIGZ1bmN0aW9uIGNoZWNrTGl2ZUJhY2tlbmQoKXsKICB0cnl7CiAgICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChDT05GSUcuQVBJX0JBU0UgKyAiL2hlYWx0aCIsIENPTkZJ",
  "Ry5IRUFMVEhfVElNRU9VVF9NUyk7CiAgICBsaXZlQmFja2VuZEF2YWlsYWJsZSA9ICEhKHIgJiYgci5vayk7CiAgfWNhdGNoKGUpewogICAgbGl2ZUJhY2tlbmRBdmFpbGFibGUgPSBmYWxzZTsKICB9CiAgdXBkYXRlQmFja2VuZEJhZGdlKCk7CiAgcmV0dXJuIGxp",
  "dmVCYWNrZW5kQXZhaWxhYmxlOwp9CgpmdW5jdGlvbiB1cGRhdGVCYWNrZW5kQmFkZ2UoKXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJiYWNrZW5kQmFkZ2UiKTsKICBpZighZWwpIHJldHVybjsKICBlbC5jbGFzc0xpc3QudG9nZ2xlKCJs",
  "aXZlIiwgbGl2ZUJhY2tlbmRBdmFpbGFibGUpOwogIGVsLnF1ZXJ5U2VsZWN0b3IoIi5kb3QtbGl2ZSIpLnN0eWxlLmJhY2tncm91bmQgPSBsaXZlQmFja2VuZEF2YWlsYWJsZSA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS10ZXh0LWZhaW50KSI7CiAgZWwucXVlcnlT",
  "ZWxlY3Rvcigic3BhbjpsYXN0LWNoaWxkIikudGV4dENvbnRlbnQgPSBsaXZlQmFja2VuZEF2YWlsYWJsZSA/ICJMaXZlIE5TRSBEYXRhIiA6ICJEZW1vIERhdGEiOwogIGVsLnRpdGxlID0gbGl2ZUJhY2tlbmRBdmFpbGFibGUKICAgID8gIkNvbm5lY3RlZCB0byB0",
  "aGUgRXF1aXR5U2NhbiBiYWNrZW5kIOKAlCBwcmljZXMgYXJlIHJlYWwgTlNFIHF1b3Rlcy4iCiAgICA6ICJCYWNrZW5kIG5vdCByZWFjaGFibGUgYXQgIiArIENPTkZJRy5BUElfQkFTRSArICIg4oCUIHNob3dpbmcgZGV0ZXJtaW5pc3RpYyBkZW1vIGRhdGEuIjsK",
  "fQoKZnVuY3Rpb24gbWFwQmFja2VuZFRvRnJvbnRlbmQoZCl7CiAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoZC5zeW1ib2wpOwogIGNvbnN0IGJhc2lzID0gZC5jdXJyZW50UHJpY2UgfHwgMTAwMDsKICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjAs",
  "IDAuMDA1LCBiYXNpcyk7CiAgY29uc3Qga25vd25EZWYgPSBVTklWRVJTRS5maW5kKHU9PnUudD09PWQuc3ltYm9sKTsKICByZXR1cm4gewogICAgdDogZC5zeW1ib2wsCiAgICBuYW1lOiBkLmNvbXBhbnlOYW1lIHx8IChrbm93bkRlZiAmJiBrbm93bkRlZi5uYW1l",
  "KSB8fCBkLnN5bWJvbCwKICAgIGV4Y2g6IGQuZXhjaGFuZ2UgfHwgIk5TRSIsCiAgICAvLyBUaGUgbGl2ZSBiYWNrZW5kJ3MgaW5kdXN0cnkgbGFiZWwgZG9lc24ndCByZWxpYWJseSBtYXRjaCBvdXIgZmlsdGVyCiAgICAvLyBkcm9wZG93bidzIHZvY2FidWxhcnkg",
  "KG9yIG1heSBiZSBtaXNzaW5nKSwgc28gcHJlZmVyIG91ciBrbm93biBtYXBwaW5nCiAgICAvLyBmb3IgZmlsdGVyaW5nIHB1cnBvc2VzIGFuZCBvbmx5IGZhbGwgYmFjayB0byB0aGUgYmFja2VuZCdzIHJhdyB2YWx1ZS4KICAgIHNlY3RvcjogKGtub3duRGVmICYm",
  "IGtub3duRGVmLnNlY3RvcikgfHwgZC5zZWN0b3IgfHwgIuKAlCIsCiAgICBwcmljZTogZC5jdXJyZW50UHJpY2UsCiAgICBjaGFuZ2U6IGQuY2hhbmdlLAogICAgcGN0OiBkLnBlcmNlbnRDaGFuZ2UsCiAgICBtYXJrZXRDYXA6IGQubWFya2V0Q2FwLAogICAgdm9s",
  "dW1lOiBkLnZvbHVtZSwKICAgIGhpZ2g1MjogZC53ZWVrNTJIaWdoLAogICAgbG93NTI6IGQud2VlazUyTG93LAogICAgb3BlbjogZC5vcGVuLAogICAgZGF5SGlnaDogZC5kYXlIaWdoLAogICAgZGF5TG93OiBkLmRheUxvdywKICAgIHNlcmllcywKICAgIGxpdmU6",
  "IHRydWUsCiAgICBkYXRhU3RhdHVzOiBkLmRhdGFTdGF0dXMsCiAgfTsKfQoKYXN5bmMgZnVuY3Rpb24gbGl2ZUZldGNoU3RvY2sodGlja2VyKXsKICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChgJHtDT05GSUcuQVBJX0JBU0V9L3N0b2NrLyR7ZW5j",
  "b2RlVVJJQ29tcG9uZW50KHRpY2tlcil9YCwgQ09ORklHLkxJVkVfVElNRU9VVF9NUyk7CiAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcigiYmFja2VuZCBzdGF0dXMgIityLnN0YXR1cyk7CiAgY29uc3QganNvbiA9IGF3YWl0IHIuanNvbigpOwogIGlmKCFqc29u",
  "LnN1Y2Nlc3MgfHwgIWpzb24uZGF0YSkgdGhyb3cgbmV3IEVycm9yKCJiYWNrZW5kIHBheWxvYWQgZXJyb3IiKTsKICByZXR1cm4gbWFwQmFja2VuZFRvRnJvbnRlbmQoanNvbi5kYXRhKTsKfQoKYXN5bmMgZnVuY3Rpb24gbGl2ZUZldGNoTWFueSh0aWNrZXJzKXsK",
  "ICBjb25zdCBzZXR0bGVkID0gYXdhaXQgUHJvbWlzZS5hbGxTZXR0bGVkKHRpY2tlcnMubWFwKGxpdmVGZXRjaFN0b2NrKSk7CiAgcmV0dXJuIHNldHRsZWQuZmlsdGVyKHM9PnMuc3RhdHVzPT09ImZ1bGZpbGxlZCIpLm1hcChzPT5zLnZhbHVlKTsKfQoKY29uc3Qg",
  "VU5JVkVSU0UgPSBbCiAge3Q6IlRDUyIsIG5hbWU6IlRhdGEgQ29uc3VsdGFuY3kgU2VydmljZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IklUIFNlcnZpY2VzIiwgYmFzZTozODQyfSwKICB7dDoiUkVMSUFOQ0UiLCBuYW1lOiJSZWxpYW5jZSBJbmR1c3RyaWVzIiwg",
  "ZXhjaDoiTlNFIiwgc2VjdG9yOiJFbmVyZ3kiLCBiYXNlOjI5NTF9LAogIHt0OiJIREZDQkFOSyIsIG5hbWU6IkhERkMgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTY4N30sCiAge3Q6IklORlkiLCBuYW1lOiJJbmZvc3lzIiwgZXhj",
  "aDoiTlNFIiwgc2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6MTg0MX0sCiAge3Q6IklDSUNJQkFOSyIsIG5hbWU6IklDSUNJIEJhbmsiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjEyNjR9LAogIHt0OiJCSEFSVElBUlRMIiwgbmFtZToiQmhh",
  "cnRpIEFpcnRlbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiVGVsZWNvbSIsIGJhc2U6MTY5OH0sCiAge3Q6IlNCSU4iLCBuYW1lOiJTdGF0ZSBCYW5rIG9mIEluZGlhIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZTo4MjR9LAogIHt0OiJJVEMiLCBu",
  "YW1lOiJJVEMgTGltaXRlZCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRk1DRyIsIGJhc2U6NDc4fSwKICB7dDoiTFQiLCBuYW1lOiJMYXJzZW4gJiBUb3Vicm8iLCBleGNoOiJOU0UiLCBzZWN0b3I6IkluZnJhc3RydWN0dXJlIiwgYmFzZTozNjEyfSwKICB7dDoiS09U",
  "QUtCQU5LIiwgbmFtZToiS290YWsgTWFoaW5kcmEgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTc4OX0sCiAge3Q6IkhJTkRVTklMVlIiLCBuYW1lOiJIaW5kdXN0YW4gVW5pbGV2ZXIiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ci",
  "LCBiYXNlOjI1NDd9LAogIHt0OiJBWElTQkFOSyIsIG5hbWU6IkF4aXMgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTE0Mn0sCiAge3Q6IkJBSkZJTkFOQ0UiLCBuYW1lOiJCYWphaiBGaW5hbmNlIiwgZXhjaDoiTlNFIiwgc2VjdG9y",
  "OiJGaW5hbmNpYWwgU2VydmljZXMiLCBiYXNlOjcyODR9LAogIHt0OiJNQVJVVEkiLCBuYW1lOiJNYXJ1dGkgU3V6dWtpIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJBdXRvbW9iaWxlIiwgYmFzZToxMjQ4MH0sCiAge3Q6IkFTSUFOUEFJTlQiLCBuYW1lOiJBc2lhbiBQ",
  "YWludHMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkNvbnN1bWVyIEdvb2RzIiwgYmFzZToyODk0fSwKICB7dDoiV0lQUk8iLCBuYW1lOiJXaXBybyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjUxMn0sCiAge3Q6IlRJVEFOIiwgbmFtZToi",
  "VGl0YW4gQ29tcGFueSIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQ29uc3VtZXIgR29vZHMiLCBiYXNlOjM0MjF9LAogIHt0OiJTVU5QSEFSTUEiLCBuYW1lOiJTdW4gUGhhcm1hY2V1dGljYWwiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBoYXJtYSIsIGJhc2U6MTc4Nn0s",
  "CiAge3Q6Ik5UUEMiLCBuYW1lOiJOVFBDIExpbWl0ZWQiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBvd2VyIiwgYmFzZTozNjJ9LAogIHt0OiJBREFOSUVOVCIsIG5hbWU6IkFkYW5pIEVudGVycHJpc2VzIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJEaXZlcnNpZmllZCIs",
  "IGJhc2U6MjkxNH0sCiAge3Q6IlVMVFJBQ0VNQ08iLCBuYW1lOiJVbHRyYVRlY2ggQ2VtZW50IiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJDZW1lbnQiLCBiYXNlOjExMjQwfSwKICB7dDoiUE9XRVJHUklEIiwgbmFtZToiUG93ZXIgR3JpZCBDb3JwIiwgZXhjaDoiTlNF",
  "Iiwgc2VjdG9yOiJQb3dlciIsIGJhc2U6MzE4fSwKICB7dDoiTkVTVExFSU5EIiwgbmFtZToiTmVzdGxlIEluZGlhIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJGTUNHIiwgYmFzZToyMjc4fSwKICB7dDoiVEFUQU1PVE9SUyIsIG5hbWU6IlRhdGEgTW90b3JzIiwgZXhj",
  "aDoiTlNFIiwgc2VjdG9yOiJBdXRvbW9iaWxlIiwgYmFzZTo5NDh9LAogIHt0OiJKU1dTVEVFTCIsIG5hbWU6IkpTVyBTdGVlbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiTWV0YWxzIiwgYmFzZToxMDEyfSwKXTsKCmZ1bmN0aW9uIHNlZWRlZFJhbmQoc2VlZCl7CiAg",
  "bGV0IHggPSBNYXRoLnNpbihzZWVkKSAqIDEwMDAwOwogIHJldHVybiB4IC0gTWF0aC5mbG9vcih4KTsKfQpmdW5jdGlvbiBkYXlPZlllYXIoKXsKICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpOwogIHJldHVybiBNYXRoLmZsb29yKChub3cgLSBuZXcgRGF0ZShub3cu",
  "Z2V0RnVsbFllYXIoKSwwLDApKSAvIDg2NDAwMDAwKTsKfQpmdW5jdGlvbiBnZW5TZXJpZXMoc2VlZCwgcG9pbnRzLCB2b2xhdGlsaXR5LCBiYXNlKXsKICBjb25zdCBhcnIgPSBbXTsKICBsZXQgdiA9IGJhc2U7CiAgZm9yKGxldCBpPTA7aTxwb2ludHM7aSsrKXsK",
  "ICAgIGNvbnN0IHIgPSBzZWVkZWRSYW5kKHNlZWQgKiA5Ny43ICsgaSAqIDEzLjMxKSAtIDAuNTsKICAgIHYgPSB2ICogKDEgKyByICogdm9sYXRpbGl0eSk7CiAgICBhcnIucHVzaCh2KTsKICB9CiAgcmV0dXJuIGFycjsKfQpmdW5jdGlvbiB0aWNrZXJTZWVkKHRp",
  "Y2tlcil7CiAgbGV0IGggPSAwOwogIGZvcihsZXQgaT0wO2k8dGlja2VyLmxlbmd0aDtpKyspIGggPSAoaCozMSArIHRpY2tlci5jaGFyQ29kZUF0KGkpKSAlIDEwMDAwMDsKICByZXR1cm4gaCArIGRheU9mWWVhcigpOwp9CgpmdW5jdGlvbiB3aXRoTGF0ZW5jeSh2",
  "YWx1ZSl7CiAgcmV0dXJuIG5ldyBQcm9taXNlKHJlcyA9PiBzZXRUaW1lb3V0KCgpID0+IHJlcyh2YWx1ZSksIE1PQ0tfTEFURU5DWSkpOwp9Cgpjb25zdCBBUEkgPSB7CiAgYXN5bmMgZmV0Y2hJbmRpY2VzKCl7CiAgICBjb25zdCBkZWZzID0gWwogICAgICB7Y29k",
  "ZToiTklGVFkgNTAiLCBmdWxsOiJOU0UgTmlmdHkgNTAgSW5kZXgiLCBiYXNlOjI0ODEyfSwKICAgICAge2NvZGU6IlNFTlNFWCIsIGZ1bGw6IkJTRSBTZW5zZXgiLCBiYXNlOjgxNjQwfSwKICAgICAge2NvZGU6Ik5JRlRZIEJBTksiLCBmdWxsOiJOU0UgQmFuayBO",
  "aWZ0eSBJbmRleCIsIGJhc2U6NTIxNDB9LAogICAgXTsKICAgIGNvbnN0IG91dCA9IGRlZnMubWFwKGQ9PnsKICAgICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQoZC5jb2RlKTsKICAgICAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNlZWQsIDI0LCAwLjAwNiwg",
  "ZC5iYXNlKTsKICAgICAgY29uc3QgbGFzdCA9IHNlcmllc1tzZXJpZXMubGVuZ3RoLTFdOwogICAgICBjb25zdCBwcmV2ID0gZC5iYXNlOwogICAgICBjb25zdCBjaGcgPSBsYXN0IC0gcHJldjsKICAgICAgY29uc3QgcGN0ID0gKGNoZy9wcmV2KSoxMDA7CiAgICAg",
  "IHJldHVybiB7Li4uZCwgdmFsdWU6bGFzdCwgY2hhbmdlOmNoZywgcGN0LCBzZXJpZXN9OwogICAgfSk7CiAgICByZXR1cm4gd2l0aExhdGVuY3kob3V0KTsKICB9LAoKICBhc3luYyBzZWFyY2hTdG9ja3MocXVlcnkpewogICAgY29uc3QgcSA9IHF1ZXJ5LnRyaW0o",
  "KS50b0xvd2VyQ2FzZSgpOwogICAgaWYoIXEpIHJldHVybiB3aXRoTGF0ZW5jeShbXSk7CiAgICBjb25zdCBtYXRjaGVzID0gVU5JVkVSU0UuZmlsdGVyKHMgPT4gcy50LnRvTG93ZXJDYXNlKCkuaW5jbHVkZXMocSkgfHwgcy5uYW1lLnRvTG93ZXJDYXNlKCkuaW5j",
  "bHVkZXMocSkpLnNsaWNlKDAsOCk7CiAgICBpZihsaXZlQmFja2VuZEF2YWlsYWJsZSl7CiAgICAgIGNvbnN0IGxpdmUgPSBhd2FpdCBsaXZlRmV0Y2hNYW55KG1hdGNoZXMubWFwKG09Pm0udCkpOwogICAgICBpZihsaXZlLmxlbmd0aCkgcmV0dXJuIGxpdmU7CiAg",
  "ICB9CiAgICByZXR1cm4gd2l0aExhdGVuY3kobWF0Y2hlcy5tYXAocyA9PiBkZWNvcmF0ZVN0b2NrKHMpKSk7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTY3JlZW5lclJlc3VsdHMoZmlsdGVycyl7CiAgICBsZXQgbGlzdDsKICAgIGlmKGxpdmVCYWNrZW5kQXZhaWxhYmxl",
  "KXsKICAgICAgY29uc3QgbGl2ZSA9IGF3YWl0IGxpdmVGZXRjaE1hbnkoVU5JVkVSU0UubWFwKHM9PnMudCkpOwogICAgICBsaXN0ID0gbGl2ZS5sZW5ndGggPyBsaXZlIDogVU5JVkVSU0UubWFwKHM9PmRlY29yYXRlU3RvY2socykpOwogICAgfSBlbHNlIHsKICAg",
  "ICAgbGlzdCA9IFVOSVZFUlNFLm1hcChkZWNvcmF0ZVN0b2NrKTsKICAgICAgYXdhaXQgd2l0aExhdGVuY3kobnVsbCk7CiAgICB9CiAgICBpZihmaWx0ZXJzLnF1ZXJ5KXsKICAgICAgY29uc3QgcSA9IGZpbHRlcnMucXVlcnkudG9Mb3dlckNhc2UoKTsKICAgICAg",
  "bGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMudC50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpfHxzLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSk7CiAgICB9CiAgICBpZihmaWx0ZXJzLnNlY3RvciAmJiBmaWx0ZXJzLnNlY3RvciAhPT0gIkFsbCIpIGxpc3Qg",
  "PSBsaXN0LmZpbHRlcihzPT5zLnNlY3Rvcj09PWZpbHRlcnMuc2VjdG9yKTsKICAgIGlmKGZpbHRlcnMubWluUHJpY2UpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnByaWNlPj1maWx0ZXJzLm1pblByaWNlKTsKICAgIGlmKGZpbHRlcnMubWF4UHJpY2UpIGxpc3Qg",
  "PSBsaXN0LmZpbHRlcihzPT5zLnByaWNlPD1maWx0ZXJzLm1heFByaWNlKTsKICAgIGlmKGZpbHRlcnMuZGlyZWN0aW9uPT09ImdhaW5lcnMiKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q+PTApOwogICAgaWYoZmlsdGVycy5kaXJlY3Rpb249PT0ibG9zZXJz",
  "IikgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucGN0PDApOwogICAgcmV0dXJuIGxpc3Q7CiAgfSwKCiAgYXN5bmMgZmV0Y2hTdG9jayh0aWNrZXIpewogICAgaWYobGl2ZUJhY2tlbmRBdmFpbGFibGUpewogICAgICB0cnl7IHJldHVybiBhd2FpdCBsaXZlRmV0Y2hT",
  "dG9jayh0aWNrZXIpOyB9CiAgICAgIGNhdGNoKGUpeyAvKiBmYWxsIHRocm91Z2ggdG8gbW9jayAqLyB9CiAgICB9CiAgICBjb25zdCBkZWYgPSBVTklWRVJTRS5maW5kKHM9PnMudD09PXRpY2tlcik7CiAgICBpZighZGVmKSByZXR1cm4gd2l0aExhdGVuY3kobnVs",
  "bCk7CiAgICByZXR1cm4gd2l0aExhdGVuY3koZGVjb3JhdGVTdG9jayhkZWYsIHRydWUpKTsKICB9LAoKICBhc3luYyBmZXRjaFN0b2NrSGlzdG9yeSh0aWNrZXIsIHJhbmdlKXsKICAgIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKHRpY2tlcik7CiAgICBjb25zdCBj",
  "ZmcgPSB7CiAgICAgICIxRCI6e3BvaW50czo3OCwgdm9sOjAuMDAxNn0sCiAgICAgICIxVyI6e3BvaW50czozNSwgdm9sOjAuMDAzfSwKICAgICAgIjFNIjp7cG9pbnRzOjIyLCB2b2w6MC4wMDh9LAogICAgICAiM00iOntwb2ludHM6NjUsIHZvbDowLjAwOX0sCiAg",
  "ICAgICI2TSI6e3BvaW50czoxMzAsIHZvbDowLjAxMH0sCiAgICAgICIxWSI6e3BvaW50czoyNTAsIHZvbDowLjAxMn0sCiAgICB9W3JhbmdlXSB8fCB7cG9pbnRzOjYwLCB2b2w6MC4wMDh9OwogICAgY29uc3QgZGVmID0gVU5JVkVSU0UuZmluZChzPT5zLnQ9PT10",
  "aWNrZXIpOwogICAgY29uc3QgYmFzZSA9IGRlZiA/IGRlZi5iYXNlICogMC45NCA6IDEwMDA7CiAgICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCArIHJhbmdlLmxlbmd0aCwgY2ZnLnBvaW50cywgY2ZnLnZvbCwgYmFzZSk7CiAgICByZXR1cm4gd2l0aExh",
  "dGVuY3koc2VyaWVzKTsKICB9LAp9OwoKZnVuY3Rpb24gZGVjb3JhdGVTdG9jayhkZWYsIGRldGFpbGVkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkZWYudCk7CiAgY29uc3Qgc2VyaWVzID0gZ2VuU2VyaWVzKHNlZWQsIDIwLCAwLjAwNSwgZGVmLmJhc2Up",
  "OwogIGNvbnN0IHByaWNlID0gc2VyaWVzW3Nlcmllcy5sZW5ndGgtMV07CiAgY29uc3QgcHJldkNsb3NlID0gZGVmLmJhc2U7CiAgY29uc3QgY2hhbmdlID0gcHJpY2UgLSBwcmV2Q2xvc2U7CiAgY29uc3QgcGN0ID0gKGNoYW5nZS9wcmV2Q2xvc2UpKjEwMDsKICBj",
  "b25zdCBtYXJrZXRDYXAgPSBwcmljZSAqIChzZWVkZWRSYW5kKHNlZWQqMi4xKSo0MDAwKzgwMCkgKiAxZTY7CiAgY29uc3Qgdm9sdW1lID0gTWF0aC5yb3VuZChzZWVkZWRSYW5kKHNlZWQqMy4zKSo4XzAwMF8wMDAgKyAyMDBfMDAwKTsKICBjb25zdCBoaWdoNTIg",
  "PSBwcmljZSAqICgxICsgc2VlZGVkUmFuZChzZWVkKjQuNCkqMC4zNSArIDAuMDUpOwogIGNvbnN0IGxvdzUyID0gcHJpY2UgKiAoMSAtIHNlZWRlZFJhbmQoc2VlZCo1LjUpKjAuMzAgLSAwLjA0KTsKICBjb25zdCBvdXQgPSB7CiAgICB0OmRlZi50LCBuYW1lOmRl",
  "Zi5uYW1lLCBleGNoOmRlZi5leGNoLCBzZWN0b3I6ZGVmLnNlY3RvciwKICAgIHByaWNlLCBjaGFuZ2UsIHBjdCwgbWFya2V0Q2FwLCB2b2x1bWUsIGhpZ2g1MiwgbG93NTIsIHNlcmllcywKICB9OwogIGlmKGRldGFpbGVkKXsKICAgIG91dC5vcGVuID0gcHJpY2Ug",
  "LSBjaGFuZ2UqMC42OwogICAgb3V0LmRheUhpZ2ggPSBNYXRoLm1heChwcmljZSwgb3V0Lm9wZW4pICogKDErc2VlZGVkUmFuZChzZWVkKjYuNikqMC4wMTIpOwogICAgb3V0LmRheUxvdyA9IE1hdGgubWluKHByaWNlLCBvdXQub3BlbikgKiAoMS1zZWVkZWRSYW5k",
  "KHNlZWQqNy43KSowLjAxMik7CiAgfQogIHJldHVybiBvdXQ7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgRk9STUFUIEhFTFBFUlMKICAgPT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBmbXRJTlIodiwgZGVjaW1hbHMpewogIGlmKHY9PT11bmRlZmluZWR8fHY9PT1udWxsfHxpc05hTih2KSkgcmV0dXJuICLigJQiOwogIGNvbnN0IGQgPSBkZWNpbWFs",
  "cz09PXVuZGVmaW5lZD8yOmRlY2ltYWxzOwogIHJldHVybiAi4oK5IiArIHYudG9Mb2NhbGVTdHJpbmcoImVuLUlOIiwge21pbmltdW1GcmFjdGlvbkRpZ2l0czpkLCBtYXhpbXVtRnJhY3Rpb25EaWdpdHM6ZH0pOwp9CmZ1bmN0aW9uIGZtdENvbXBhY3Qodil7CiAg",
  "aWYodj09PXVuZGVmaW5lZHx8dj09PW51bGx8fGlzTmFOKHYpKSByZXR1cm4gIuKAlCI7CiAgaWYodj49MWUxMikgcmV0dXJuICLigrkiKyh2LzFlMTIpLnRvRml4ZWQoMikrIlQiOwogIGlmKHY+PTFlOSkgcmV0dXJuICLigrkiKyh2LzFlOSkudG9GaXhlZCgyKSsi",
  "QiI7CiAgaWYodj49MWU3KSByZXR1cm4gIuKCuSIrKHYvMWU3KS50b0ZpeGVkKDIpKyJDciI7CiAgaWYodj49MWU1KSByZXR1cm4gIuKCuSIrKHYvMWU1KS50b0ZpeGVkKDIpKyJMIjsKICByZXR1cm4gIuKCuSIrdi50b0ZpeGVkKDApOwp9CmZ1bmN0aW9uIGZtdFZv",
  "bCh2KXsKICBpZih2Pj0xZTcpIHJldHVybiAodi8xZTcpLnRvRml4ZWQoMikrIkNyIjsKICBpZih2Pj0xZTUpIHJldHVybiAodi8xZTUpLnRvRml4ZWQoMikrIkwiOwogIGlmKHY+PTFlMykgcmV0dXJuICh2LzFlMykudG9GaXhlZCgxKSsiSyI7CiAgcmV0dXJuIFN0",
  "cmluZyh2KTsKfQpmdW5jdGlvbiBwY3RTdHIocCl7IHJldHVybiAocD49MD8iKyI6IiIpICsgcC50b0ZpeGVkKDIpICsgIiUiOyB9CmZ1bmN0aW9uIGNoZ1N0cihjKXsgcmV0dXJuIChjPj0wPyIrIjoiIikgKyBmbXRJTlIoTWF0aC5hYnMoYykpOyB9CmZ1bmN0aW9u",
  "IGVzY2FwZUh0bWwocyl7CiAgcmV0dXJuIFN0cmluZyhzKS5yZXBsYWNlKC9bJjw+IiddL2csIG0gPT4gKHsiJiI6IiZhbXA7IiwiPCI6IiZsdDsiLCI+IjoiJmd0OyIsJyInOiImcXVvdDsiLCInIjoiJiMzOTsifVttXSkpOwp9CgovKiA9PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNUQVRFCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3Qgc3RhdGUgPSB7CiAgdmll",
  "dzogImRhc2hib2FyZCIsCiAgd2F0Y2hsaXN0OiBbXSwKICBkZXRhaWxUaWNrZXI6ICJUQ1MiLAogIGRldGFpbFJhbmdlOiAiMU0iLAogIHNjcmVlbmVyRmlsdGVyczoge3F1ZXJ5OiIiLCBzZWN0b3I6IkFsbCIsIG1pblByaWNlOjAsIG1heFByaWNlOjE1MDAwLCBk",
  "aXJlY3Rpb246ImFsbCJ9LAogIHNjcmVlbmVyU29ydDoge2tleToibWFya2V0Q2FwIiwgZGlyOiJkZXNjIn0sCn07Cgp0cnl7CiAgY29uc3Qgc2F2ZWQgPSBsb2NhbFN0b3JhZ2UuZ2V0SXRlbSgiZXF1aXR5c2Nhbl93YXRjaGxpc3QiKTsKICBpZihzYXZlZCkgc3Rh",
  "dGUud2F0Y2hsaXN0ID0gSlNPTi5wYXJzZShzYXZlZCk7Cn1jYXRjaChlKXt9CmZ1bmN0aW9uIHBlcnNpc3RXYXRjaGxpc3QoKXsKICB0cnl7IGxvY2FsU3RvcmFnZS5zZXRJdGVtKCJlcXVpdHlzY2FuX3dhdGNobGlzdCIsIEpTT04uc3RyaW5naWZ5KHN0YXRlLndh",
  "dGNobGlzdCkpOyB9Y2F0Y2goZSl7fQp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFNQQVJLTElORSAoaW5saW5lIFNWRykKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpmdW5jdGlvbiBzcGFya2xpbmVTVkcoc2VyaWVzLCBwb3NpdGl2ZSwgdywgaCl7CiAgdyA9IHd8fDEyMDsgaCA9IGh8fDM2OwogIGlmKCFzZXJpZXMgfHwgc2VyaWVzLmxlbmd0aDwyKSByZXR1",
  "cm4gIiI7CiAgY29uc3QgbWluID0gTWF0aC5taW4oLi4uc2VyaWVzKSwgbWF4ID0gTWF0aC5tYXgoLi4uc2VyaWVzKTsKICBjb25zdCByYW5nZSA9IChtYXgtbWluKXx8MTsKICBjb25zdCBzdGVwID0gdy8oc2VyaWVzLmxlbmd0aC0xKTsKICBjb25zdCBwdHMgPSBz",
  "ZXJpZXMubWFwKCh2LGkpPT5baSpzdGVwLCBoIC0gKCh2LW1pbikvcmFuZ2UpKmgqMC44NiAtIGgqMC4wN10pOwogIGNvbnN0IHBhdGggPSBwdHMubWFwKChwLGkpPT4oaT09PTA/Ik0iOiJMIikrcFswXS50b0ZpeGVkKDEpKyIsIitwWzFdLnRvRml4ZWQoMSkpLmpv",
  "aW4oIiAiKTsKICBjb25zdCBhcmVhUGF0aCA9IHBhdGggKyBgIEwke3d9LCR7aH0gTDAsJHtofSBaYDsKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8gInZhcigtLXBvcykiIDogInZhcigtLW5lZykiOwogIGNvbnN0IGdpZCA9ICJzZyIrTWF0aC5yYW5kb20oKS50",
  "b1N0cmluZygzNikuc2xpY2UoMiw5KTsKICByZXR1cm4gYDxzdmcgdmlld0JveD0iMCAwICR7d30gJHtofSIgd2lkdGg9IjEwMCUiIGhlaWdodD0iMTAwJSIgcHJlc2VydmVBc3BlY3RSYXRpbz0ibm9uZSI+CiAgICA8ZGVmcz48bGluZWFyR3JhZGllbnQgaWQ9IiR7",
  "Z2lkfSIgeDE9IjAiIHkxPSIwIiB4Mj0iMCIgeTI9IjEiPgogICAgICA8c3RvcCBvZmZzZXQ9IjAlIiBzdG9wLWNvbG9yPSIke2NvbG9yfSIgc3RvcC1vcGFjaXR5PSIwLjM1Ii8+CiAgICAgIDxzdG9wIG9mZnNldD0iMTAwJSIgc3RvcC1jb2xvcj0iJHtjb2xvcn0i",
  "IHN0b3Atb3BhY2l0eT0iMCIvPgogICAgPC9saW5lYXJHcmFkaWVudD48L2RlZnM+CiAgICA8cGF0aCBkPSIke2FyZWFQYXRofSIgZmlsbD0idXJsKCMke2dpZH0pIiBzdHJva2U9Im5vbmUiLz4KICAgIDxwYXRoIGQ9IiR7cGF0aH0iIGZpbGw9Im5vbmUiIHN0cm9r",
  "ZT0iJHtjb2xvcn0iIHN0cm9rZS13aWR0aD0iMS42IiBzdHJva2UtbGluZWNhcD0icm91bmQiIHN0cm9rZS1saW5lam9pbj0icm91bmQiLz4KICA8L3N2Zz5gOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09CiAgIEFNQklFTlQgREVDT1JBVElWRSBMSU5FUyAoZHJhd24gb25jZSkKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwooZnVuY3Rpb24gZHJhd0FtYmllbnRMaW5l",
  "cygpewogIGNvbnN0IHN2ZyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhbWJpZW50TGluZXMiKTsKICBjb25zdCB3ID0gMTQwMCwgaCA9IDgwMDsKICBzdmcuc2V0QXR0cmlidXRlKCJ2aWV3Qm94IiwgYDAgMCAke3d9ICR7aH1gKTsKICBsZXQgaHRtbCA9ICIi",
  "OwogIGZvcihsZXQgaT0wO2k8MztpKyspewogICAgY29uc3Qgc2VlZCA9IGkqMTcrMzsKICAgIGNvbnN0IHB0cyA9IFtdOwogICAgY29uc3QgbiA9IDEyOwogICAgZm9yKGxldCBqPTA7ajw9bjtqKyspewogICAgICBjb25zdCB4ID0gKGovbikqdzsKICAgICAgY29u",
  "c3QgeSA9IGgqMC4yNSArIGkqMTMwICsgKHNlZWRlZFJhbmQoc2VlZCtqKS0wLjUpKjkwOwogICAgICBwdHMucHVzaChbeCx5XSk7CiAgICB9CiAgICBjb25zdCBwYXRoID0gcHRzLm1hcCgocCxpZHgpPT4oaWR4PT09MD8iTSI6IkwiKStwWzBdLnRvRml4ZWQoMCkr",
  "IiwiK3BbMV0udG9GaXhlZCgwKSkuam9pbigiICIpOwogICAgY29uc3QgY29sb3JzID0gWyIjNEM3REZGIiwiIzhCNkJGMCIsIiMzMUQ1RUUiXTsKICAgIGh0bWwgKz0gYDxwYXRoIGQ9IiR7cGF0aH0iIGZpbGw9Im5vbmUiIHN0cm9rZT0iJHtjb2xvcnNbaSUzXX0i",
  "IHN0cm9rZS13aWR0aD0iMSIgb3BhY2l0eT0iMC4xMCIvPmA7CiAgfQogIHN2Zy5pbm5lckhUTUwgPSBodG1sOwp9KSgpOwoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBIRUFERVIg",
  "QkVIQVZJT1IKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCB0b3BiYXIgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidG9wYmFyIik7CndpbmRvdy5hZGRFdmVudExpc3Rl",
  "bmVyKCJzY3JvbGwiLCAoKT0+ewogIHRvcGJhci5jbGFzc0xpc3QudG9nZ2xlKCJzY3JvbGxlZCIsIHdpbmRvdy5zY3JvbGxZID4gOCk7Cn0pOwoKZnVuY3Rpb24gc2V0QWN0aXZlTmF2KHZpZXcpewogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIiNtYWluTmF2",
  "IGJ1dHRvbiwgI2JvdHRvbU5hdiBidXR0b24iKS5mb3JFYWNoKGI9PnsKICAgIGIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYi5kYXRhc2V0LnZpZXc9PT12aWV3KTsKICB9KTsKfQpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibWFpbk5hdiIpLmFkZEV2ZW50",
  "TGlzdGVuZXIoImNsaWNrIiwgZT0+ewogIGNvbnN0IGJ0biA9IGUudGFyZ2V0LmNsb3Nlc3QoImJ1dHRvbltkYXRhLXZpZXddIik7CiAgaWYoYnRuKSBuYXZpZ2F0ZShidG4uZGF0YXNldC52aWV3KTsKfSk7CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJib3R0b21O",
  "YXYiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGU9PnsKICBjb25zdCBidG4gPSBlLnRhcmdldC5jbG9zZXN0KCJidXR0b25bZGF0YS12aWV3XSIpOwogIGlmKGJ0bikgbmF2aWdhdGUoYnRuLmRhdGFzZXQudmlldyk7Cn0pOwoKZnVuY3Rpb24gbmF2aWdhdGUo",
  "dmlldywgdGlja2VyKXsKICBzdGF0ZS52aWV3ID0gdmlldzsKICBpZih0aWNrZXIpIHN0YXRlLmRldGFpbFRpY2tlciA9IHRpY2tlcjsKICBzZXRBY3RpdmVOYXYodmlldyA9PT0gImRldGFpbCIgPyAibWFya2V0cyIgOiB2aWV3KTsKICB3aW5kb3cuc2Nyb2xsVG8o",
  "e3RvcDowLCBiZWhhdmlvcjogd2luZG93Lm1hdGNoTWVkaWEoJyhwcmVmZXJzLXJlZHVjZWQtbW90aW9uOiByZWR1Y2UpJykubWF0Y2hlcyA/ICJhdXRvIiA6ICJzbW9vdGgifSk7CiAgcmVuZGVyKCk7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgTUFSS0VUIFNUQVRVUyAoSVNUIGJ1c2luZXNzIGhvdXJzLCBwdXJlbHkgcHJlc2VudGF0aW9uYWwpCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT0gKi8KKGZ1bmN0aW9uIG1hcmtldFN0YXR1cygpewogIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7CiAgY29uc3QgaXN0SG91ciA9IChub3cuZ2V0VVRDSG91cnMoKSs1KSUyNCArIChub3cuZ2V0VVRDTWludXRlcygpKzMwPj02MD8xOjApOwog",
  "IGNvbnN0IG1pbnMgPSAobm93LmdldFVUQ01pbnV0ZXMoKSszMCklNjA7CiAgY29uc3QgdG90YWxNaW4gPSAoKG5vdy5nZXRVVENIb3VycygpKzUpJTI0KSo2MCArIG1pbnM7CiAgY29uc3Qgb3BlbiA9IHRvdGFsTWluID49IDU1NSAmJiB0b3RhbE1pbiA8PSA5MzA7",
  "IC8vIDk6MTUgLSAxNTozMCBJU1QKICBzZXRUZXh0KCJtYXJrZXRTdGF0dXNUZXh0Iiwgb3BlbiA/ICJNYXJrZXQgT3BlbiIgOiAiTWFya2V0IENsb3NlZCIpOwogIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoIi5kb3QtbGl2ZSIpLnN0eWxlLmJhY2tncm91bmQgPSBv",
  "cGVuID8gInZhcigtLXBvcykiIDogInZhcigtLXRleHQtZmFpbnQpIjsKfSkoKTsKCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgUkVOREVSOiBST09UCiAgID09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3Qgcm9vdCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJtYWluUm9vdCIpOwoKZnVuY3Rpb24gcmVuZGVyKCl7CiAgaWYoc3RhdGUudmlldyA9PT0gImRhc2hi",
  "b2FyZCIpIHJlbmRlckRhc2hib2FyZCgpOwogIGVsc2UgaWYoc3RhdGUudmlldyA9PT0gInNjcmVlbmVyIikgcmVuZGVyU2NyZWVuZXIoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJtYXJrZXRzIikgcmVuZGVyTWFya2V0cygpOwogIGVsc2UgaWYoc3RhdGUu",
  "dmlldyA9PT0gIndhdGNobGlzdCIpIHJlbmRlcldhdGNobGlzdCgpOwogIGVsc2UgaWYoc3RhdGUudmlldyA9PT0gImRldGFpbCIpIHJlbmRlckRldGFpbCgpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIERBU0hCT0FSRCAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5j",
  "IGZ1bmN0aW9uIHJlbmRlckRhc2hib2FyZCgpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyIgaWQ9ImRhc2hWaWV3Ij4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+TWFya2V0IE92ZXJ2aWV3PC9oMj48c3BhbiBj",
  "bGFzcz0ic3ViIj5SZWFsLXRpbWUgaW5kZXggc25hcHNob3Q8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9Imhlcm8tcm93IiBpZD0iaW5kaWNlc1JvdyI+CiAgICAgICAgJHtza2VsZXRvbkNhcmRzKDMpfQogICAgICA8L2Rpdj4KCiAgICAgICR7c2VhcmNo",
  "QmxvY2soKX0KCiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPk1hcmtldCBCcmVhZHRoPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5BZHZhbmNlcnMgdnMgZGVjbGluZXJzLCBmdWxsIHVuaXZlcnNlPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNz",
  "PSJnbGFzcyBicmVhZHRoLWNhcmQiIGlkPSJicmVhZHRoQ2FyZCIgc3R5bGU9InBhZGRpbmc6MThweCAyMnB4O21hcmdpbi1ib3R0b206MzRweDsiPiR7c2tlbGV0b25MaW5lcygyKX08L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPlRv",
  "cCBNb3ZlcnM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkJ5IGFic29sdXRlIGNoYW5nZSB0b2RheTwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCBnbGFzcyIgaWQ9Im1vdmVyc1RhYmxlV3JhcCI+PGRpdiBzdHlsZT0icGFkZGluZzoyMHB4",
  "OyI+JHtza2VsZXRvbkxpbmVzKDYpfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdG9jay1jYXJkcyIgaWQ9Im1vdmVyc0NhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgd2lyZVNlYXJjaCgpOwoKICB0cnl7CiAgICBjb25zdCBpbmRpY2VzID0g",
  "YXdhaXQgQVBJLmZldGNoSW5kaWNlcygpOwogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImluZGljZXNSb3ciKS5pbm5lckhUTUwgPSBpbmRpY2VzLm1hcChpbmRleENhcmRIVE1MKS5qb2luKCIiKTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIi5p",
  "bmRleC1zcGFyayIpLmZvckVhY2goKGVsLGkpPT57CiAgICAgIGVsLmlubmVySFRNTCA9IHNwYXJrbGluZVNWRyhpbmRpY2VzW2ldLnNlcmllcywgaW5kaWNlc1tpXS5jaGFuZ2U+PTApOwogICAgfSk7CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVu",
  "dEJ5SWQoImluZGljZXNSb3ciKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiTWFya2V0IGRhdGEgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUiLCAiV2UgY291bGRuJ3QgcmVhY2ggdGhlIGluZGljZXMgZmVlZC4gUGxlYXNlIHRyeSBhZ2FpbiBzaG9ydGx5LiIp",
  "OwogIH0KCiAgdHJ5ewogICAgY29uc3QgZnVsbCA9IGF3YWl0IEFQSS5mZXRjaFNjcmVlbmVyUmVzdWx0cyh7fSk7CiAgICB0cnl7CiAgICAgIHJlbmRlckJyZWFkdGgoZnVsbCk7CiAgICB9Y2F0Y2goZSl7CiAgICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJi",
  "cmVhZHRoQ2FyZCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJCcmVhZHRoIGRhdGEgdW5hdmFpbGFibGUiLCAiQ291bGRuJ3QgY29tcHV0ZSBhZHZhbmNlcnMgdnMgZGVjbGluZXJzLiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7CiAgICAg",
  "IHNob3dFcnJvckJhbm5lcigicmVuZGVyQnJlYWR0aCBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogICAgfQogICAgdHJ5ewogICAgICBjb25zdCBtb3ZlcnMgPSBmdWxsLnNsaWNlKCkuc29ydCgoYSxiKT0+TWF0aC5hYnMoYi5wY3QpLU1hdGgu",
  "YWJzKGEucGN0KSkuc2xpY2UoMCw4KTsKICAgICAgcmVuZGVyVGFibGVJbnRvKCJtb3ZlcnNUYWJsZVdyYXAiLCAibW92ZXJzQ2FyZHMiLCBtb3ZlcnMsIHtrZXk6InBjdCIsIGRpcjoiZGVzYyJ9LCBmYWxzZSk7CiAgICB9Y2F0Y2goZSl7CiAgICAgIGRvY3VtZW50",
  "LmdldEVsZW1lbnRCeUlkKCJtb3ZlcnNUYWJsZVdyYXAiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiVW5hYmxlIHRvIHJldHJpZXZlIG1vdmVycyIsICJTb21ldGhpbmcgd2VudCB3cm9uZyBsb2FkaW5nIHRoaXMgbGlzdC4gKCIgKyAoZSAmJiBlLm1lc3Nh",
  "Z2UgfHwgZSkgKyAiKSIpOwogICAgICBzaG93RXJyb3JCYW5uZXIoIm1vdmVycyB0YWJsZSByZW5kZXIgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICAgIH0KICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgibW92ZXJz",
  "VGFibGVXcmFwIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byByZXRyaWV2ZSBtb3ZlcnMiLCAiU29tZXRoaW5nIHdlbnQgd3JvbmcgbG9hZGluZyB0aGlzIGxpc3QuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKTsKICAgIGRv",
  "Y3VtZW50LmdldEVsZW1lbnRCeUlkKCJicmVhZHRoQ2FyZCIpLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJCcmVhZHRoIGRhdGEgdW5hdmFpbGFibGUiLCAiQ291bGRuJ3QgY29tcHV0ZSBhZHZhbmNlcnMgdnMgZGVjbGluZXJzLiAoIiArIChlICYmIGUubWVz",
  "c2FnZSB8fCBlKSArICIpIik7CiAgICBzaG93RXJyb3JCYW5uZXIoImZldGNoU2NyZWVuZXJSZXN1bHRzIGZhaWxlZDogIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSk7CiAgfQp9CgpmdW5jdGlvbiByZW5kZXJCcmVhZHRoKGxpc3QpewogIGNvbnN0IGVsID0gZG9j",
  "dW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJyZWFkdGhDYXJkIik7CiAgaWYoIWVsIHx8ICFsaXN0Lmxlbmd0aCl7IGlmKGVsKSBlbC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gYnJlYWR0aCBkYXRhIiwgIk5vIHN0b2NrcyB3ZXJlIHJldHVybmVkIHRvIGNv",
  "bXB1dGUgdGhpcyBmcm9tLiIpOyByZXR1cm47IH0KICBjb25zdCBhZHZhbmNlcnMgPSBsaXN0LmZpbHRlcihzPT5zLnBjdD4wKS5sZW5ndGg7CiAgY29uc3QgZGVjbGluZXJzID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q8MCkubGVuZ3RoOwogIGNvbnN0IGZsYXQgPSBs",
  "aXN0Lmxlbmd0aCAtIGFkdmFuY2VycyAtIGRlY2xpbmVyczsKICBjb25zdCB0b3RhbCA9IGxpc3QubGVuZ3RoOwogIGNvbnN0IGFkdlBjdCA9IChhZHZhbmNlcnMvdG90YWwpKjEwMCwgZGVjUGN0ID0gKGRlY2xpbmVycy90b3RhbCkqMTAwLCBmbGF0UGN0ID0gKGZs",
  "YXQvdG90YWwpKjEwMDsKICBlbC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IHN0eWxlPSJkaXNwbGF5OmZsZXg7anVzdGlmeS1jb250ZW50OnNwYWNlLWJldHdlZW47YWxpZ24taXRlbXM6YmFzZWxpbmU7bWFyZ2luLWJvdHRvbToxMnB4O2ZsZXgtd3JhcDp3cmFwO2dh",
  "cDo4cHg7Ij4KICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2dhcDoyMHB4OyI+CiAgICAgICAgPGRpdj48c3BhbiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMHB4O2NvbG9yOnZhcigtLXBvcy1zb2Z0KTsiPiR7YWR2",
  "YW5jZXJzfTwvc3Bhbj4gPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4OyI+YWR2YW5jaW5nPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNp",
  "emU6MjBweDtjb2xvcjp2YXIoLS1uZWctc29mdCk7Ij4ke2RlY2xpbmVyc308L3NwYW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPmRlY2xpbmluZzwvc3Bhbj48L2Rpdj4KICAgICAgICA8ZGl2PjxzcGFuIGNsYXNz",
  "PSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjIwcHg7Y29sb3I6dmFyKC0tdGV4dC1taWQpOyI+JHtmbGF0fTwvc3Bhbj4gPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4OyI+dW5jaGFuZ2VkPC9zcGFu",
  "PjwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBzdHlsZT0iZm9udC1zaXplOjExLjVweDtjb2xvcjp2YXIoLS10ZXh0LWZhaW50KTsiPm9mICR7dG90YWx9IHRyYWNrZWQgc3RvY2tzPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6",
  "ZmxleDtoZWlnaHQ6MTBweDtib3JkZXItcmFkaXVzOjZweDtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3VuZDp2YXIoLS1iZy1iYXNlKTsiPgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDoke2FkdlBjdH0lO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZh",
  "cigtLXBvcyksdmFyKC0tcG9zLXNvZnQpKTsiPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDoke2ZsYXRQY3R9JTtiYWNrZ3JvdW5kOnZhcigtLXRleHQtZmFpbnQpOyI+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9IndpZHRoOiR7ZGVjUGN0fSU7YmFja2dy",
  "b3VuZDpsaW5lYXItZ3JhZGllbnQoOTBkZWcsdmFyKC0tbmVnLXNvZnQpLHZhcigtLW5lZykpOyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwp9CgpmdW5jdGlvbiBpbmRleENhcmRIVE1MKGlkeCl7CiAgY29uc3QgcG9zaXRpdmUgPSBpZHguY2hhbmdlID49IDA7CiAg",
  "cmV0dXJuIGAKICA8ZGl2IGNsYXNzPSJnbGFzcyBpbmRleC1jYXJkIj4KICAgIDxkaXYgY2xhc3M9InJvdzEiPgogICAgICA8ZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImluZGV4LW5hbWUiPiR7aWR4LmNvZGV9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaW5k",
  "ZXgtZnVsbCI+JHtpZHguZnVsbH08L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImluZGV4LWJhZGdlICR7cG9zaXRpdmU/J3Bvcyc6J25lZyd9Ij4KICAgICAgICAke3Bvc2l0aXZlPyfilrInOifilrwnfSAke3BjdFN0cihpZHgucGN0KX0KICAg",
  "ICAgPC9kaXY+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXZhbHVlIGluZGV4LXZhbHVlLWdyYWRpZW50IHRhYnVsYXIiPiR7aWR4LnZhbHVlLnRvTG9jYWxlU3RyaW5nKCJlbi1JTiIse21heGltdW1GcmFjdGlvbkRpZ2l0czoyfSl9PC9kaXY+CiAg",
  "ICA8ZGl2IGNsYXNzPSJpbmRleC1jaGFuZ2UgJHtwb3NpdGl2ZT8ncG9zJzonbmVnJ30gdGFidWxhciI+JHtjaGdTdHIoaWR4LmNoYW5nZSl9PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayI+PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gc2tl",
  "bGV0b25DYXJkcyhuKXsKICByZXR1cm4gQXJyYXkuZnJvbSh7bGVuZ3RoOm59KS5tYXAoKCk9PmA8ZGl2IGNsYXNzPSJnbGFzcyBza2VsLWNhcmQgc2tlbCI+PC9kaXY+YCkuam9pbigiIik7Cn0KZnVuY3Rpb24gc2tlbGV0b25MaW5lcyhuKXsKICByZXR1cm4gQXJy",
  "YXkuZnJvbSh7bGVuZ3RoOm59KS5tYXAoKCk9PmA8ZGl2IGNsYXNzPSJza2VsIHNrZWwtbGluZSIgc3R5bGU9IndpZHRoOiR7NjArTWF0aC5yYW5kb20oKSozNX0lIj48L2Rpdj5gKS5qb2luKCIiKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBTRUFSQ0ggLS0tLS0t",
  "LS0tLS0tLS0tLSAqLwpmdW5jdGlvbiBzZWFyY2hCbG9jaygpewogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0ic2VhcmNoLXdyYXAiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDsiPgogICAgPGRpdiBjbGFzcz0ic2VhcmNoLWJveCBnbGFzcyIgaWQ9InNlYXJjaEJveCI+",
  "CiAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHJva2UtbGluZWNhcD0icm91bmQiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEg",
  "MjFsLTQuMy00LjMiLz48L3N2Zz4KICAgICAgPGlucHV0IHR5cGU9InRleHQiIGlkPSJzZWFyY2hJbnB1dCIgcGxhY2Vob2xkZXI9IlNlYXJjaCBzdG9ja3MgYnkgbmFtZSBvciB0aWNrZXLigKYiIGF1dG9jb21wbGV0ZT0ib2ZmIj4KICAgICAgPGtiZCBjbGFzcz0i",
  "a3Nob3J0Y3V0Ij4vPC9rYmQ+CiAgICA8L2Rpdj4KICAgIDxkaXYgY2xhc3M9InNlYXJjaC1kcm9wIGdsYXNzIiBpZD0ic2VhcmNoRHJvcCIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPjwvZGl2PgogIDwvZGl2PmA7Cn0KCmxldCBzZWFyY2hEZWJvdW5jZTsKZnVuY3Rp",
  "b24gd2lyZVNlYXJjaCgpewogIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaElucHV0Iik7CiAgY29uc3QgYm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaEJveCIpOwogIGNvbnN0IGRyb3AgPSBkb2N1bWVudC5n",
  "ZXRFbGVtZW50QnlJZCgic2VhcmNoRHJvcCIpOwogIGlmKCFpbnB1dCkgcmV0dXJuOwoKICBkb2N1bWVudC5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIiwgKGUpPT57CiAgICBpZihlLmtleSA9PT0gIi8iICYmIGRvY3VtZW50LmFjdGl2ZUVsZW1lbnQgIT09IGlu",
  "cHV0KXsKICAgICAgZS5wcmV2ZW50RGVmYXVsdCgpOwogICAgICBpbnB1dC5mb2N1cygpOwogICAgfQogICAgaWYoZS5rZXkgPT09ICJFc2NhcGUiKXsgaW5wdXQuYmx1cigpOyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyBib3guY2xhc3NMaXN0LnJlbW92ZSgi",
  "Zm9jdXNlZCIpOyB9CiAgfSk7CgogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImZvY3VzIiwgKCk9PiBib3guY2xhc3NMaXN0LmFkZCgiZm9jdXNlZCIpKTsKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJibHVyIiwgKCk9PiBzZXRUaW1lb3V0KCgpPT57IGJveC5j",
  "bGFzc0xpc3QucmVtb3ZlKCJmb2N1c2VkIik7IGRyb3Auc3R5bGUuZGlzcGxheT0ibm9uZSI7IH0sIDE2MCkpOwoKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsICgpPT57CiAgICBjbGVhclRpbWVvdXQoc2VhcmNoRGVib3VuY2UpOwogICAgY29uc3Qg",
  "cSA9IGlucHV0LnZhbHVlOwogICAgaWYoIXEudHJpbSgpKXsgZHJvcC5zdHlsZS5kaXNwbGF5PSJub25lIjsgcmV0dXJuOyB9CiAgICBkcm9wLnN0eWxlLmRpc3BsYXk9ImJsb2NrIjsKICAgIGRyb3AuaW5uZXJIVE1MID0gYDxkaXYgc3R5bGU9InBhZGRpbmc6MTRw",
  "eCAxNnB4OyI+JHtza2VsZXRvbkxpbmVzKDMpfTwvZGl2PmA7CiAgICBzZWFyY2hEZWJvdW5jZSA9IHNldFRpbWVvdXQoYXN5bmMgKCk9PnsKICAgICAgY29uc3QgcmVzdWx0cyA9IGF3YWl0IEFQSS5zZWFyY2hTdG9ja3MocSk7CiAgICAgIGlmKCFyZXN1bHRzLmxl",
  "bmd0aCl7CiAgICAgICAgZHJvcC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0ic2VhcmNoLWVtcHR5Ij5ObyBzdG9ja3MgbWF0Y2gg4oCcJHtlc2NhcGVIdG1sKHEpfeKAnTwvZGl2PmA7CiAgICAgICAgcmV0dXJuOwogICAgICB9CiAgICAgIGRyb3AuaW5uZXJIVE1M",
  "ID0gcmVzdWx0cy5tYXAoKHMsaSk9PmAKICAgICAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtcm93IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSoyOH1tcyIgZGF0YS10aWNrZXI9IiR7cy50fSI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1sZWZ0Ij4KICAgICAg",
  "ICAgICAgPGRpdiBjbGFzcz0ic3ItdGlja2VyIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgICAgICA8ZGl2PgogICAgICAgICAgICAgIDxkaXYgY2xhc3M9InNyLW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgICAgICAgIDxk",
  "aXYgY2xhc3M9InNyLW1ldGEiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9InNyLXByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAg",
  "ICAgIDwvZGl2PgogICAgICBgKS5qb2luKCIiKTsKICAgICAgZHJvcC5xdWVyeVNlbGVjdG9yQWxsKCIuc2VhcmNoLXJvdyIpLmZvckVhY2gocm93PT57CiAgICAgICAgcm93LmFkZEV2ZW50TGlzdGVuZXIoIm1vdXNlZG93biIsICgpPT57CiAgICAgICAgICBuYXZp",
  "Z2F0ZSgiZGV0YWlsIiwgcm93LmRhdGFzZXQudGlja2VyKTsKICAgICAgICB9KTsKICAgICAgfSk7CiAgICB9LCAyNjApOwogIH0pOwp9CmRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hUb2dnbGVCdG4iKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgp",
  "PT57CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoSW5wdXQiKTsKICBpZihpbnB1dCkgaW5wdXQuZm9jdXMoKTsKICBlbHNlIG5hdmlnYXRlKCJkYXNoYm9hcmQiKTsKfSk7CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNIQVJFRCBU",
  "QUJMRSBSRU5ERVIgLS0tLS0tLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiByZW5kZXJUYWJsZUludG8od3JhcElkLCBjYXJkc0lkLCBsaXN0LCBzb3J0LCBzaG93U2VjdG9yQ29sKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQod3JhcElkKTsK",
  "ICBjb25zdCBjYXJkcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKGNhcmRzSWQpOwogIGlmKCFsaXN0Lmxlbmd0aCl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVtcHR5U3RhdGVIVE1MKCJObyBzdG9ja3MgbWF0Y2ggeW91ciBmaWx0ZXJzIiwgIlRyeSB3aWRlbmlu",
  "ZyB5b3VyIHByaWNlIHJhbmdlIG9yIGNsZWFyaW5nIGEgZmlsdGVyLiIpOwogICAgaWYoY2FyZHMpIGNhcmRzLmlubmVySFRNTCA9ICIiOwogICAgcmV0dXJuOwogIH0KICBjb25zdCBzb3J0ZWQgPSBzb3J0U3RvY2tzKGxpc3QsIHNvcnQpOwoKICB3cmFwLmlubmVy",
  "SFRNTCA9IGAKICAgIDx0YWJsZSBjbGFzcz0ic3RvY2stdGFibGUiPgogICAgICA8dGhlYWQ+PHRyPgogICAgICAgIDx0aD48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0ibmFtZSI+Q29tcGFueTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+",
  "CiAgICAgICAgPHRoIGRhdGEta2V5PSJwcmljZSI+UHJpY2U8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0iY2hhbmdlIj5DaGFuZ2U8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgog",
  "ICAgICAgIDx0aCBkYXRhLWtleT0icGN0Ij5DaGFuZ2UgJTxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJtYXJrZXRDYXAiPk1hcmtldCBDYXA8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48",
  "L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0idm9sdW1lIj5Wb2x1bWU8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0iaGlnaDUyIj41MlcgSGlnaDxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFu",
  "PjwvdGg+CiAgICAgICAgPHRoIGRhdGEta2V5PSJsb3c1MiI+NTJXIExvdzxzcGFuIGNsYXNzPSJzb3J0LWluZCI+4pa+PC9zcGFuPjwvdGg+CiAgICAgIDwvdHI+PC90aGVhZD4KICAgICAgPHRib2R5PgogICAgICAgICR7c29ydGVkLm1hcCgocyxpKT0+c3RvY2tS",
  "b3dIVE1MKHMsaSkpLmpvaW4oIiIpfQogICAgICA8L3Rib2R5PgogICAgPC90YWJsZT4KICBgOwogIHdyYXAucXVlcnlTZWxlY3RvckFsbCgidGhbZGF0YS1rZXldIikuZm9yRWFjaCh0aD0+ewogICAgdGguY2xhc3NMaXN0LnRvZ2dsZSgic29ydGVkIiwgdGguZGF0",
  "YXNldC5rZXk9PT1zb3J0LmtleSk7CiAgICBpZih0aC5kYXRhc2V0LmtleT09PXNvcnQua2V5KXsgY29uc3QgaW5kID0gdGgucXVlcnlTZWxlY3RvcigiLnNvcnQtaW5kIik7IGlmKGluZCkgaW5kLnRleHRDb250ZW50ID0gc29ydC5kaXI9PT0iZGVzYyI/IuKWviI6",
  "IuKWtCI7IH0KICAgIHRoLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgICAgY29uc3Qga2V5ID0gdGguZGF0YXNldC5rZXk7CiAgICAgIGNvbnN0IG5ld0RpciA9IChzb3J0LmtleT09PWtleSAmJiBzb3J0LmRpcj09PSJkZXNjIikgPyAiYXNjIiA6",
  "ICJkZXNjIjsKICAgICAgY29uc3QgbmV3U29ydCA9IHtrZXksIGRpcjpuZXdEaXJ9OwogICAgICBpZih3cmFwSWQ9PT0ic2NyZWVuZXJUYWJsZVdyYXAiKSBzdGF0ZS5zY3JlZW5lclNvcnQgPSBuZXdTb3J0OwogICAgICByZW5kZXJUYWJsZUludG8od3JhcElkLCBj",
  "YXJkc0lkLCBsaXN0LCBuZXdTb3J0LCBzaG93U2VjdG9yQ29sKTsKICAgIH0pOwogIH0pOwogIHdpcmVSb3dJbnRlcmFjdGlvbnMod3JhcCk7CgogIGlmKGNhcmRzKXsKICAgIGNhcmRzLmlubmVySFRNTCA9IHNvcnRlZC5tYXAoKHMsaSk9PnN0b2NrQ2FyZEhUTUwo",
  "cyxpKSkuam9pbigiIik7CiAgICB3aXJlUm93SW50ZXJhY3Rpb25zKGNhcmRzKTsKICB9Cn0KCmZ1bmN0aW9uIHNvcnRTdG9ja3MobGlzdCwgc29ydCl7CiAgcmV0dXJuIGxpc3Quc2xpY2UoKS5zb3J0KChhLGIpPT57CiAgICBsZXQgYXY9YVtzb3J0LmtleV0sIGJ2",
  "PWJbc29ydC5rZXldOwogICAgaWYoc29ydC5rZXk9PT0ibmFtZSIpeyBhdj1hLm5hbWU7IGJ2PWIubmFtZTsgcmV0dXJuIHNvcnQuZGlyPT09ImFzYyI/IGF2LmxvY2FsZUNvbXBhcmUoYnYpIDogYnYubG9jYWxlQ29tcGFyZShhdik7IH0KICAgIHJldHVybiBzb3J0",
  "LmRpcj09PSJhc2MiID8gYXYtYnYgOiBidi1hdjsKICB9KTsKfQoKZnVuY3Rpb24gc3RvY2tSb3dIVE1MKHMsaSl7CiAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwogIHJldHVybiBg",
  "CiAgPHRyIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjIyfW1zIj4KICAgIDx0ZCBvbmNsaWNrPSJldmVudC5zdG9wUHJvcGFnYXRpb24oKSI+CiAgICAgIDxidXR0b24gY2xhc3M9InN0YXItYnRuICR7aW5XYXRjaD8nYWN0",
  "aXZlJzonJ30iIGRhdGEtc3Rhcj0iJHtzLnR9IiB0aXRsZT0iJHtpbldhdGNoPydSZW1vdmUgZnJvbSB3YXRjaGxpc3QnOidBZGQgdG8gd2F0Y2hsaXN0J30iPgogICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSIke2luV2F0Y2g/J2N1cnJlbnRD",
  "b2xvcic6J25vbmUnfSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiI+PHBhdGggZD0iTTEyIDE3LjNsLTYuMTYgMy42IDEuNjQtNi45TDIgOS40bDcuMDYtLjZMMTIgMi40bDIuOTQgNi40IDcuMDYuNi01LjQ4IDQuNiAxLjY0IDYuOXoiLz48",
  "L3N2Zz4KICAgICAgPC9idXR0b24+CiAgICA8L3RkPgogICAgPHRkPgogICAgICA8ZGl2IGNsYXNzPSJjZWxsLWNvbXBhbnkiPgogICAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgwLDMpfTwvZGl2PgogICAgICAgIDxkaXY+",
  "CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3MuZXhjaH08L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9k",
  "aXY+CiAgICA8L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj48c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke2NoZ1N0cihzLmNoYW5nZSl9",
  "PC9zcGFuPjwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPjxzcGFuIGNsYXNzPSJjaGFuZ2UtcGlsbCAke3Bvcz8ncG9zJzonbmVnJ30iPiR7cGN0U3RyKHMucGN0KX08L3NwYW4+PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRDb21wYWN0KHMu",
  "bWFya2V0Q2FwKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdFZvbChzLnZvbHVtZSl9PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRJTlIocy5oaWdoNTIpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMu",
  "bG93NTIpfTwvdGQ+CiAgPC90cj5gOwp9CgpmdW5jdGlvbiBzdG9ja0NhcmRIVE1MKHMsaSl7CiAgY29uc3QgcG9zID0gcy5wY3Q+PTA7CiAgY29uc3QgaW5XYXRjaCA9IHN0YXRlLndhdGNobGlzdC5pbmNsdWRlcyhzLnQpOwogIHJldHVybiBgCiAgPGRpdiBjbGFz",
  "cz0iZ2xhc3Mgc3RvY2stY2FyZCIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjZ9bXMiPgogICAgPGRpdiBjbGFzcz0ibGVmdCI+CiAgICAgIDxkaXYgY2xhc3M9ImNlbGwtdGlja2VyLWJhZGdlIj4ke3MudC5zbGljZSgw",
  "LDMpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJuYW1lLWJsb2NrIj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtz",
  "LmV4Y2h9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJyaWdodCI+CiAgICAgIDxkaXYgY2xhc3M9InByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICA8c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwg",
  "JHtwb3M/J3Bvcyc6J25lZyd9IiBzdHlsZT0ibWFyZ2luLXRvcDo0cHg7Ij4ke3BjdFN0cihzLnBjdCl9PC9zcGFuPgogICAgPC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVJvd0ludGVyYWN0aW9ucyhjb250YWluZXIpewogIGNvbnRhaW5lci5xdWVy",
  "eVNlbGVjdG9yQWxsKCJ0cltkYXRhLXRpY2tlcl0sIC5zdG9jay1jYXJkW2RhdGEtdGlja2VyXSIpLmZvckVhY2goZWw9PnsKICAgIGVsLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PiBuYXZpZ2F0ZSgiZGV0YWlsIiwgZWwuZGF0YXNldC50aWNrZXIpKTsK",
  "ICB9KTsKICBjb250YWluZXIucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEtc3Rhcl0iKS5mb3JFYWNoKGJ0bj0+ewogICAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAgIGUuc3RvcFByb3BhZ2F0aW9uKCk7CiAgICAgIHRvZ2dsZVdhdGNo",
  "KGJ0bi5kYXRhc2V0LnN0YXIpOwogICAgICBidG4uY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIik7CiAgICAgIGJ0bi5xdWVyeVNlbGVjdG9yKCJzdmciKS5zZXRBdHRyaWJ1dGUoImZpbGwiLCBidG4uY2xhc3NMaXN0LmNvbnRhaW5zKCJhY3RpdmUiKSA/ICJjdXJy",
  "ZW50Q29sb3IiIDogIm5vbmUiKTsKICAgIH0pOwogIH0pOwp9CgpmdW5jdGlvbiB0b2dnbGVXYXRjaCh0aWNrZXIpewogIGNvbnN0IGlkeCA9IHN0YXRlLndhdGNobGlzdC5pbmRleE9mKHRpY2tlcik7CiAgaWYoaWR4Pj0wKSBzdGF0ZS53YXRjaGxpc3Quc3BsaWNl",
  "KGlkeCwxKTsKICBlbHNlIHN0YXRlLndhdGNobGlzdC5wdXNoKHRpY2tlcik7CiAgcGVyc2lzdFdhdGNobGlzdCgpOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNDUkVFTkVSIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyU2NyZWVuZXIo",
  "KXsKICBjb25zdCBzZWN0b3JzID0gWyJBbGwiLCAuLi5BcnJheS5mcm9tKG5ldyBTZXQoVU5JVkVSU0UubWFwKHM9PnMuc2VjdG9yKSkpXTsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciPgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9u",
  "LWhlYWQiPjxoMj5TY3JlZW5lcjwvaDI+PHNwYW4gY2xhc3M9InN1YiI+RmlsdGVyIHRoZSBtYXJrZXQgb24geW91ciB0ZXJtczwvc3Bhbj48L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImFpLXF1ZXJ5LWJveCBnbGFzcyI+CiAgICAgICAgPGRpdiBjbGFzcz0iYWkt",
  "cXVlcnktcm93Ij4KICAgICAgICAgIDxkaXYgY2xhc3M9ImFpLWF2YXRhciIgc3R5bGU9IndpZHRoOjI0cHg7aGVpZ2h0OjI0cHg7Zm9udC1zaXplOjEycHg7Ij7inKY8L2Rpdj4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iYWlRdWVyeUlucHV0IiBw",
  "bGFjZWhvbGRlcj0iQXNrIGluIHBsYWluIEVuZ2xpc2gg4oCUIGUuZy4g4oCcd2hpY2ggSVQgc3RvY2tzIGFyZSB1cCB0b2RheeKAnSI+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJhaS1xdWVyeS1idG4iIGlkPSJhaVF1ZXJ5QnRuIj5Bc2s8L2J1dHRvbj4KICAg",
  "ICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJhaS1xdWVyeS1hbnN3ZXIiIGlkPSJhaVF1ZXJ5QW5zd2VyIiBzdHlsZT0iZGlzcGxheTpub25lOyI+PC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgZmlsdGVycy1iYXIiPgog",
  "ICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIiBzdHlsZT0ibWluLXdpZHRoOjIwMHB4OyI+CiAgICAgICAgICA8bGFiZWw+U2VhcmNoPC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0iZlF1ZXJ5IiBwbGFjZWhvbGRlcj0iVGlja2Vy",
  "IG9yIGNvbXBhbnnigKYiIHZhbHVlPSIke2VzY2FwZUh0bWwoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnF1ZXJ5KX0iPgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIj4KICAgICAgICAgIDxsYWJlbD5TZWN0b3I8L2xhYmVsPgog",
  "ICAgICAgICAgPHNlbGVjdCBpZD0iZlNlY3RvciI+JHtzZWN0b3JzLm1hcChzPT5gPG9wdGlvbiAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3I9PT1zPydzZWxlY3RlZCc6Jyd9PiR7c308L29wdGlvbj5gKS5qb2luKCIiKX08L3NlbGVjdD4KICAgICAgICA8",
  "L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCI+CiAgICAgICAgICA8bGFiZWw+TWF4IFByaWNlIDxzcGFuIGNsYXNzPSJyYW5nZS12YWwiIGlkPSJmUHJpY2VWYWwiPiR7Zm10SU5SKHN0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZSwwKX08",
  "L3NwYW4+PC9sYWJlbD4KICAgICAgICAgIDxpbnB1dCB0eXBlPSJyYW5nZSIgY2xhc3M9InJhbmdlLXNsaWRlciIgaWQ9ImZNYXhQcmljZSIgbWluPSI1MDAiIG1heD0iMTUwMDAiIHN0ZXA9IjI1MCIgdmFsdWU9IiR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFBy",
  "aWNlfSI+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiIHN0eWxlPSJtaW4td2lkdGg6MTkwcHg7Ij4KICAgICAgICAgIDxsYWJlbD5EaXJlY3Rpb248L2xhYmVsPgogICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWdyb3Vw",
  "Ij4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nYWxsJz8nYWN0aXZlJzonJ30iIGRhdGEtZGlyPSJhbGwiPkFsbDwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUt",
  "YnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLmRpcmVjdGlvbj09PSdnYWluZXJzJz8nYWN0aXZlJzonJ30iIGRhdGEtZGlyPSJnYWluZXJzIj5HYWluZXJzPC9kaXY+CiAgICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5zY3JlZW5lckZp",
  "bHRlcnMuZGlyZWN0aW9uPT09J2xvc2Vycyc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRpcj0ibG9zZXJzIj5Mb3NlcnM8L2Rpdj4KICAgICAgICAgIDwvZGl2PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9InJlc2V0LWZpbHRlcnMiIGlkPSJyZXNldEZp",
  "bHRlcnMiPlJlc2V0IGZpbHRlcnM8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMiBpZD0ic2NyZWVuZXJDb3VudCI+UmVzdWx0czwvaDI+PHNwYW4gY2xhc3M9InN1YiI+U29ydGVkIGJ5IG1hcmtldCBjYXA8L3Nw",
  "YW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJzY3JlZW5lclRhYmxlV3JhcCI+PGRpdiBzdHlsZT0icGFkZGluZzoyMHB4OyI+JHtza2VsZXRvbkxpbmVzKDgpfTwvZGl2PjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJzdG9j",
  "ay1jYXJkcyIgaWQ9InNjcmVlbmVyQ2FyZHMiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKCiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZRdWVyeSIpLmFkZEV2ZW50TGlzdGVuZXIoImlucHV0IiwgZGVib3VuY2UoZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0",
  "ZXJzLnF1ZXJ5ID0gZS50YXJnZXQudmFsdWU7IHJ1blNjcmVlbmVyKCk7CiAgfSwgMjYwKSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZTZWN0b3IiKS5hZGRFdmVudExpc3RlbmVyKCJjaGFuZ2UiLCBlPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMu",
  "c2VjdG9yID0gZS50YXJnZXQudmFsdWU7IHJ1blNjcmVlbmVyKCk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImZNYXhQcmljZSIpLmFkZEV2ZW50TGlzdGVuZXIoImlucHV0IiwgZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFByaWNl",
  "ID0gTnVtYmVyKGUudGFyZ2V0LnZhbHVlKTsKICAgIHNldFRleHQoImZQcmljZVZhbCIsIGZtdElOUihzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UsMCkpOwogICAgcnVuU2NyZWVuZXIoKTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJb",
  "ZGF0YS1kaXJdIikuZm9yRWFjaChidG49PnsKICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb24gPSBidG4uZGF0YXNldC5kaXI7CiAgICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0",
  "b3JBbGwoIltkYXRhLWRpcl0iKS5mb3JFYWNoKGI9PmIuY2xhc3NMaXN0LnRvZ2dsZSgiYWN0aXZlIiwgYj09PWJ0bikpOwogICAgICBydW5TY3JlZW5lcigpOwogICAgfSk7CiAgfSk7CiAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInJlc2V0RmlsdGVycyIpLmFk",
  "ZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycyA9IHtxdWVyeToiIiwgc2VjdG9yOiJBbGwiLCBtaW5QcmljZTowLCBtYXhQcmljZToxNTAwMCwgZGlyZWN0aW9uOiJhbGwifTsKICAgIHJlbmRlclNjcmVlbmVyKCk7",
  "CiAgfSk7CgogIHdpcmVTY3JlZW5lckFpUXVlcnkoKTsKICBydW5TY3JlZW5lcigpOwp9CgpmdW5jdGlvbiB3aXJlU2NyZWVuZXJBaVF1ZXJ5KCl7CiAgY29uc3QgaW5wdXQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlRdWVyeUlucHV0Iik7CiAgY29uc3Qg",
  "YnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpUXVlcnlCdG4iKTsKICBjb25zdCBhbnN3ZXJCb3ggPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlRdWVyeUFuc3dlciIpOwogIGlmKCFpbnB1dCB8fCAhYnRuKSByZXR1cm47CgogIGFzeW5jIGZ1bmN0",
  "aW9uIGFzaygpewogICAgY29uc3QgcXVlc3Rpb24gPSBpbnB1dC52YWx1ZS50cmltKCk7CiAgICBpZighcXVlc3Rpb24gfHwgYnRuLmRpc2FibGVkKSByZXR1cm47CiAgICBidG4uZGlzYWJsZWQgPSB0cnVlOwogICAgY29uc3Qgb3JpZ2luYWxMYWJlbCA9IGJ0bi50",
  "ZXh0Q29udGVudDsKICAgIGJ0bi50ZXh0Q29udGVudCA9ICLigKYiOwogICAgYW5zd2VyQm94LnN0eWxlLmRpc3BsYXkgPSAiYmxvY2siOwogICAgYW5zd2VyQm94LmlubmVySFRNTCA9IHNrZWxldG9uTGluZXMoMik7CiAgICB0cnl7CiAgICAgIGlmKCFsaXZlQmFj",
  "a2VuZEF2YWlsYWJsZSkgYXdhaXQgY2hlY2tMaXZlQmFja2VuZCgpOwogICAgICBpZighbGl2ZUJhY2tlbmRBdmFpbGFibGUpIHRocm93IG5ldyBFcnJvcigiQmFja2VuZCBub3QgY29ubmVjdGVkLiBJZiBpdCB3YXMganVzdCBpZGxlLCB0cnkgYWdhaW4gaW4gYSBt",
  "b21lbnQuIik7CgogICAgICBjb25zdCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogICAgICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCk9PmN0cmwuYWJvcnQoKSwgMjAwMDApOwogICAgICBjb25zdCByZXMgPSBhd2FpdCBmZXRjaChDT05GSUcuQVBJX0JB",
  "U0UgKyAiL2NoYXQiLCB7CiAgICAgICAgbWV0aG9kOiAiUE9TVCIsCiAgICAgICAgaGVhZGVyczogeyJDb250ZW50LVR5cGUiOiAiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICAgIGJvZHk6IEpTT04uc3RyaW5naWZ5KHsKICAgICAgICAgIHF1ZXN0aW9uLAogICAg",
  "ICAgICAgY29udGV4dDogYXdhaXQgYnVpbGRBaUNvbnRleHQoKSwKICAgICAgICAgIGhpc3Rvcnk6IFtdLAogICAgICAgIH0pLAogICAgICAgIHNpZ25hbDogY3RybC5zaWduYWwsCiAgICAgIH0pLmZpbmFsbHkoKCk9PmNsZWFyVGltZW91dChpZCkpOwoKICAgICAg",
  "Y29uc3QganNvbiA9IGF3YWl0IHJlcy5qc29uKCk7CiAgICAgIGlmKCFyZXMub2sgfHwgIWpzb24uc3VjY2VzcykgdGhyb3cgbmV3IEVycm9yKChqc29uLmVycm9yICYmIGpzb24uZXJyb3IubWVzc2FnZSkgfHwgKCJSZXF1ZXN0IGZhaWxlZCAoIiArIHJlcy5zdGF0",
  "dXMgKyAiKSIpKTsKICAgICAgYW5zd2VyQm94LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJhaS1hdmF0YXIiIHN0eWxlPSJ3aWR0aDoyMnB4O2hlaWdodDoyMnB4O2ZvbnQtc2l6ZToxMXB4O2ZsZXgtc2hyaW5rOjA7Ij7inKY8L2Rpdj48ZGl2PiR7ZXNjYXBlSHRt",
  "bChqc29uLmRhdGEuYW5zd2VyKX08L2Rpdj5gOwogICAgfWNhdGNoKGUpewogICAgICBhbnN3ZXJCb3guaW5uZXJIVE1MID0gYDxkaXYgc3R5bGU9ImNvbG9yOnZhcigtLW5lZy1zb2Z0KTsiPkNvdWxkbid0IGdldCBhbiBhbnN3ZXI6ICR7ZXNjYXBlSHRtbChlICYm",
  "IGUubWVzc2FnZSB8fCBTdHJpbmcoZSkpfTwvZGl2PmA7CiAgICB9ZmluYWxseXsKICAgICAgYnRuLmRpc2FibGVkID0gZmFsc2U7CiAgICAgIGJ0bi50ZXh0Q29udGVudCA9IG9yaWdpbmFsTGFiZWw7CiAgICB9CiAgfQoKICBidG4uYWRkRXZlbnRMaXN0ZW5lcigi",
  "Y2xpY2siLCBhc2spOwogIGlucHV0LmFkZEV2ZW50TGlzdGVuZXIoImtleWRvd24iLCAoZSk9PnsgaWYoZS5rZXkgPT09ICJFbnRlciIpIGFzaygpOyB9KTsKfQoKZnVuY3Rpb24gZGVib3VuY2UoZm4sIG1zKXsKICBsZXQgaDsKICByZXR1cm4gKC4uLmFyZ3MpPT57",
  "IGNsZWFyVGltZW91dChoKTsgaD1zZXRUaW1lb3V0KCgpPT5mbiguLi5hcmdzKSwgbXMpOyB9Owp9Cgphc3luYyBmdW5jdGlvbiBydW5TY3JlZW5lcigpewogIGNvbnN0IHdyYXAgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2NyZWVuZXJUYWJsZVdyYXAiKTsK",
  "ICBpZighd3JhcCB8fCBzdGF0ZS52aWV3ICE9PSAic2NyZWVuZXIiKSByZXR1cm47IC8vIHZpZXcgbm90IGFjdGl2ZSDigJQgbm90aGluZyB0byB1cGRhdGUKICB3cmFwLnN0eWxlLm9wYWNpdHkgPSAiMC41NSI7CiAgdHJ5ewogICAgY29uc3QgcmVzdWx0cyA9IGF3",
  "YWl0IEFQSS5mZXRjaFNjcmVlbmVyUmVzdWx0cyhzdGF0ZS5zY3JlZW5lckZpbHRlcnMpOwogICAgaWYoc3RhdGUudmlldyAhPT0gInNjcmVlbmVyIikgcmV0dXJuOyAvLyBuYXZpZ2F0ZWQgYXdheSB3aGlsZSB0aGUgZmV0Y2ggd2FzIGluIGZsaWdodAogICAgc2V0",
  "VGV4dCgic2NyZWVuZXJDb3VudCIsIGBSZXN1bHRzICgke3Jlc3VsdHMubGVuZ3RofSlgKTsKICAgIC8vIE9uZS10aW1lIGRpYWdub3N0aWM6IGlmIGEgc2VjdG9yIGZpbHRlciB5aWVsZHMgemVybywgc2hvdyBleGFjdGx5IHdoYXQKICAgIC8vIHNlY3RvciB2YWx1",
  "ZXMgYWN0dWFsbHkgZXhpc3QgaW4gdGhlIGxvYWRlZCBkYXRhIHNvIGEgbWlzbWF0Y2ggKHR5cG8sCiAgICAvLyBjYXNpbmcsIHN0YWxlIGZpZWxkKSBpcyB2aXNpYmxlIGluc3RlYWQgb2YgZ3Vlc3NlZCBhdC4KICAgIGlmKHJlc3VsdHMubGVuZ3RoID09PSAwICYm",
  "IHN0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3IgJiYgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3RvciAhPT0gIkFsbCIpewogICAgICB0cnl7CiAgICAgICAgY29uc3QgdW5maWx0ZXJlZCA9IGF3YWl0IEFQSS5mZXRjaFNjcmVlbmVyUmVzdWx0cyh7Li4uc3Rh",
  "dGUuc2NyZWVuZXJGaWx0ZXJzLCBzZWN0b3I6IkFsbCJ9KTsKICAgICAgICBjb25zdCBzZWVuU2VjdG9ycyA9IEFycmF5LmZyb20obmV3IFNldCh1bmZpbHRlcmVkLm1hcChzPT5zLnNlY3RvcikpKTsKICAgICAgICBzaG93RXJyb3JCYW5uZXIoYERFQlVHOiAwIHJl",
  "c3VsdHMgZm9yIHNlY3RvciAiJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yfSIuICR7dW5maWx0ZXJlZC5sZW5ndGh9IHN0b2NrcyBsb2FkZWQgdG90YWwuIFNlY3RvciB2YWx1ZXMgYWN0dWFsbHkgcHJlc2VudDogJHtKU09OLnN0cmluZ2lmeShzZWVuU2Vj",
  "dG9ycyl9YCk7CiAgICAgIH1jYXRjaChlKXsgLyogZGlhZ25vc3RpYyBvbmx5LCBpZ25vcmUgZmFpbHVyZXMgaGVyZSAqLyB9CiAgICB9CiAgICByZW5kZXJUYWJsZUludG8oInNjcmVlbmVyVGFibGVXcmFwIiwgInNjcmVlbmVyQ2FyZHMiLCByZXN1bHRzLCBzdGF0",
  "ZS5zY3JlZW5lclNvcnQsIHRydWUpOwogIH1jYXRjaChlKXsKICAgIHdyYXAuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlNjcmVlbmVyIGRhdGEgdW5hdmFpbGFibGUiLCAiV2UgY291bGRuJ3QgbG9hZCBtYXRjaGluZyBzdG9ja3MgcmlnaHQgbm93LiAoIiAr",
  "IChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIik7CiAgICBzaG93RXJyb3JCYW5uZXIoInJ1blNjcmVlbmVyIGZhaWxlZDogIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSk7CiAgfQogIHdyYXAuc3R5bGUub3BhY2l0eSA9ICIxIjsKfQoKLyogLS0tLS0tLS0tLS0t",
  "LS0tLSBNQVJLRVRTIChmdWxsIHVuaXZlcnNlIHRhYmxlICsgdHJlbmRpbmcgaGlnaGxpZ2h0cykgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJNYXJrZXRzKCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3",
  "Ij4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+TWFya2V0czwvaDI+PHNwYW4gY2xhc3M9InN1YiI+RnVsbCBOU0UgdW5pdmVyc2Ugc25hcHNob3Q8L3NwYW4+PC9kaXY+CiAgICAgICR7c2VhcmNoQmxvY2soKX0KCiAgICAgIDxkaXYgY2xhc3M9",
  "InNlY3Rpb24taGVhZCI+PGgyPlRyZW5kaW5nIE5vdzwvaDI+PHNwYW4gY2xhc3M9InN1YiI+VG9kYXkncyBiaWdnZXN0IG1vdmVycywgdXAgb3IgZG93bjwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0idHJlbmRpbmctcm93IiBpZD0idHJlbmRpbmdSb3ci",
  "PiR7c2tlbGV0b25DYXJkcyg0KX08L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCIgc3R5bGU9Im1hcmdpbi10b3A6OHB4OyI+PGgyPkFsbCBTdG9ja3M8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlNvcnRlZCBieSBtYXJrZXQgY2FwPC9zcGFuPjwv",
  "ZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIGdsYXNzIiBpZD0ibWFya2V0c1RhYmxlV3JhcCI+PGRpdiBzdHlsZT0icGFkZGluZzoyMHB4OyI+JHtza2VsZXRvbkxpbmVzKDEwKX08L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2Fy",
  "ZHMiIGlkPSJtYXJrZXRzQ2FyZHMiPjwvZGl2PgogICAgPC9kaXY+CiAgYDsKICB3aXJlU2VhcmNoKCk7CiAgdHJ5ewogICAgY29uc3QgbGlzdCA9IGF3YWl0IEFQSS5mZXRjaFNjcmVlbmVyUmVzdWx0cyh7fSk7CiAgICByZW5kZXJUcmVuZGluZyhsaXN0KTsKICAg",
  "IHJlbmRlclRhYmxlSW50bygibWFya2V0c1RhYmxlV3JhcCIsICJtYXJrZXRzQ2FyZHMiLCBsaXN0LCB7a2V5OiJtYXJrZXRDYXAiLCBkaXI6ImRlc2MifSwgdHJ1ZSk7CiAgfWNhdGNoKGUpewogICAgZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1hcmtldHNUYWJs",
  "ZVdyYXAiKS5pbm5lckhUTUwgPSBlcnJvclN0YXRlSFRNTCgiTWFya2V0IGRhdGEgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUiLCAiUGxlYXNlIHRyeSBhZ2FpbiBpbiBhIG1vbWVudC4iKTsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ0cmVuZGluZ1JvdyIp",
  "LmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJUcmVuZGluZyBkYXRhIHVuYXZhaWxhYmxlIiwgIlBsZWFzZSB0cnkgYWdhaW4gaW4gYSBtb21lbnQuIik7CiAgfQp9CgpmdW5jdGlvbiByZW5kZXJUcmVuZGluZyhsaXN0KXsKICBjb25zdCBlbCA9IGRvY3VtZW50",
  "LmdldEVsZW1lbnRCeUlkKCJ0cmVuZGluZ1JvdyIpOwogIGlmKCFlbCkgcmV0dXJuOwogIGlmKCFsaXN0Lmxlbmd0aCl7IGVsLmlubmVySFRNTCA9IGVtcHR5U3RhdGVIVE1MKCJObyB0cmVuZGluZyBkYXRhIiwgIk5vIHN0b2NrcyB3ZXJlIHJldHVybmVkIHRvIHJh",
  "bmsuIik7IHJldHVybjsgfQogIGNvbnN0IGhvdCA9IGxpc3Quc2xpY2UoKS5zb3J0KChhLGIpPT5NYXRoLmFicyhiLnBjdCktTWF0aC5hYnMoYS5wY3QpKS5zbGljZSgwLDYpOwogIGVsLmlubmVySFRNTCA9IGhvdC5tYXAoKHMsaSk9PnsKICAgIGNvbnN0IHBvcyA9",
  "IHMucGN0Pj0wOwogICAgcmV0dXJuIGAKICAgIDxkaXYgY2xhc3M9ImdsYXNzIHRyZW5kaW5nLWNhcmQiIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjQwfW1zIj4KICAgICAgPGRpdiBjbGFzcz0idHJlbmRpbmctdG9wIj4K",
  "ICAgICAgICA8ZGl2IGNsYXNzPSJjZWxsLXRpY2tlci1iYWRnZSI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJpbmRleC1iYWRnZSAke3Bvcz8ncG9zJzonbmVnJ30iPiR7cG9zPyfilrInOifilrwnfSAke3BjdFN0cihzLnBjdCl9",
  "PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiIHN0eWxlPSJtYXJnaW4tdG9wOjEwcHg7Ij4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1zdWIiPiR7cy50fSDCtyAke3Mu",
  "ZXhjaH08L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToxOXB4O21hcmdpbi10b3A6OHB4OyI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImluZGV4LXNwYXJrIiBzdHls",
  "ZT0iaGVpZ2h0OjI4cHg7bWFyZ2luLXRvcDo4cHg7Ij4ke3NwYXJrbGluZVNWRyhzLnNlcmllcywgcG9zKX08L2Rpdj4KICAgIDwvZGl2PmA7CiAgfSkuam9pbigiIik7CiAgZWwucXVlcnlTZWxlY3RvckFsbCgiLnRyZW5kaW5nLWNhcmQiKS5mb3JFYWNoKGNhcmQ9",
  "PnsKICAgIGNhcmQuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+IG5hdmlnYXRlKCJkZXRhaWwiLCBjYXJkLmRhdGFzZXQudGlja2VyKSk7CiAgfSk7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gV0FUQ0hMSVNUIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMg",
  "ZnVuY3Rpb24gcmVuZGVyV2F0Y2hsaXN0KCl7CiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3Ij4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDI+V2F0Y2hsaXN0PC9oMj48c3BhbiBjbGFzcz0ic3ViIj4ke3N0YXRlLndh",
  "dGNobGlzdC5sZW5ndGh9IHN0b2NrJHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RoPT09MT8nJzoncyd9IHRyYWNrZWQ8L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9IndhdGNobGlzdC1ncmlkIiBpZD0id2F0Y2hHcmlkIj4ke3NrZWxldG9uQ2FyZHMoTWF0aC5t",
  "YXgoc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCwzKSl9PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIGlmKCFzdGF0ZS53YXRjaGxpc3QubGVuZ3RoKXsKICAgIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJ3YXRjaEdyaWQiKS5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0i",
  "d2F0Y2gtZW1wdHkgZ2xhc3MiPiR7ZW1wdHlTdGF0ZUlubmVyKCJZb3VyIHdhdGNobGlzdCBpcyBlbXB0eSIsICJTdGFyIGFueSBzdG9jayBmcm9tIHRoZSBkYXNoYm9hcmQsIHNjcmVlbmVyIG9yIG1hcmtldHMgdmlldyB0byB0cmFjayBpdCBoZXJlLiIpfTwvZGl2",
  "PmA7CiAgICByZXR1cm47CiAgfQogIHRyeXsKICAgIGNvbnN0IHN0b2NrcyA9IGF3YWl0IFByb21pc2UuYWxsKHN0YXRlLndhdGNobGlzdC5tYXAodD0+QVBJLmZldGNoU3RvY2sodCkpKTsKICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgi",
  "d2F0Y2hHcmlkIik7CiAgICBncmlkLmlubmVySFRNTCA9IHN0b2Nrcy5maWx0ZXIoQm9vbGVhbikubWFwKChzLGkpPT53YXRjaENhcmRIVE1MKHMsaSkpLmpvaW4oIiIpOwogICAgd2lyZVdhdGNoQ2FyZHMoKTsKICB9Y2F0Y2goZSl7CiAgICBkb2N1bWVudC5nZXRF",
  "bGVtZW50QnlJZCgid2F0Y2hHcmlkIikuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byBsb2FkIHdhdGNobGlzdCIsICJQbGVhc2UgdHJ5IGFnYWluLiIpOwogIH0KfQoKZnVuY3Rpb24gd2F0Y2hDYXJkSFRNTChzLGkpewogIGNvbnN0IHBvcyA9",
  "IHMucGN0Pj0wOwogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0iZ2xhc3Mgd2F0Y2gtY2FyZCBlbnRlcmluZyIgZGF0YS10aWNrZXI9IiR7cy50fSIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqNDB9bXMiPgogICAgPGRpdiBjbGFzcz0id2F0Y2gtdG9wIj4KICAg",
  "ICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LW5hbWUiPiR7ZXNjYXBlSHRtbChzLm5hbWUpfTwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8",
  "YnV0dG9uIGNsYXNzPSJzdGFyLWJ0biBhY3RpdmUiIGRhdGEtdW5zdGFyPSIke3MudH0iIHRpdGxlPSJSZW1vdmUiPgogICAgICAgIDxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJjdXJyZW50Q29sb3IiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Ut",
  "d2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9zdmc+CiAgICAgIDwvYnV0dG9uPgogICAgPC9kaXY+CiAgICA8ZGl2IGNs",
  "YXNzPSJpbmRleC12YWx1ZSB0YWJ1bGFyIiBzdHlsZT0iZm9udC1zaXplOjIycHg7Ij4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LWNoYW5nZSAke3Bvcz8ncG9zJzonbmVnJ30gdGFidWxhciI+JHtjaGdTdHIocy5jaGFuZ2Up",
  "fSAoJHtwY3RTdHIocy5wY3QpfSk8L2Rpdj4KICAgIDxkaXYgY2xhc3M9ImluZGV4LXNwYXJrIj4ke3NwYXJrbGluZVNWRyhzLnNlcmllcywgcG9zKX08L2Rpdj4KICA8L2Rpdj5gOwp9CgpmdW5jdGlvbiB3aXJlV2F0Y2hDYXJkcygpewogIGRvY3VtZW50LnF1ZXJ5",
  "U2VsZWN0b3JBbGwoIi53YXRjaC1jYXJkIikuZm9yRWFjaChjYXJkPT57CiAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKGUpPT57CiAgICAgIGlmKGUudGFyZ2V0LmNsb3Nlc3QoIltkYXRhLXVuc3Rhcl0iKSkgcmV0dXJuOwogICAgICBuYXZpZ2F0",
  "ZSgiZGV0YWlsIiwgY2FyZC5kYXRhc2V0LnRpY2tlcik7CiAgICB9KTsKICB9KTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS11bnN0YXJdIikuZm9yRWFjaChidG49PnsKICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChlKT0+ewog",
  "ICAgICBlLnN0b3BQcm9wYWdhdGlvbigpOwogICAgICBjb25zdCBjYXJkID0gYnRuLmNsb3Nlc3QoIi53YXRjaC1jYXJkIik7CiAgICAgIGNhcmQuY2xhc3NMaXN0LmFkZCgicmVtb3ZpbmciKTsKICAgICAgdG9nZ2xlV2F0Y2goYnRuLmRhdGFzZXQudW5zdGFyKTsK",
  "ICAgICAgc2V0VGltZW91dCgoKT0+ewogICAgICAgIGlmKCFzdGF0ZS53YXRjaGxpc3QubGVuZ3RoKSByZW5kZXJXYXRjaGxpc3QoKTsKICAgICAgICBlbHNlIGNhcmQucmVtb3ZlKCk7CiAgICAgICAgY29uc3Qgc3ViRWwgPSBkb2N1bWVudC5xdWVyeVNlbGVjdG9y",
  "KCIuc2VjdGlvbi1oZWFkIC5zdWIiKTsKICAgICAgICBpZihzdWJFbCkgc3ViRWwudGV4dENvbnRlbnQgPSBgJHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RofSBzdG9jayR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aD09PTE/Jyc6J3MnfSB0cmFja2VkYDsKICAgICAgfSwg",
  "MjgwKTsKICAgIH0pOwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNUT0NLIERFVEFJTCAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlckRldGFpbCgpewogIHJvb3QuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InZpZXciIGlkPSJk",
  "ZXRhaWxTa2VsZXRvbiI+CiAgICA8ZGl2IGNsYXNzPSJnbGFzcyBza2VsLWNhcmQgc2tlbCIgc3R5bGU9ImhlaWdodDo4OHB4O21hcmdpbi1ib3R0b206MjRweDsiPjwvZGl2PgogICAgPGRpdiBjbGFzcz0ibWV0cmljcy1ncmlkIj4ke3NrZWxldG9uQ2FyZHMoNil9",
  "PC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJnbGFzcyBza2VsLWNhcmQgc2tlbCIgc3R5bGU9ImhlaWdodDozMjBweDsiPjwvZGl2PgogIDwvZGl2PmA7CgogIGxldCBzOwogIHRyeXsgcyA9IGF3YWl0IEFQSS5mZXRjaFN0b2NrKHN0YXRlLmRldGFpbFRpY2tlcik7IH1j",
  "YXRjaChlKXsgcyA9IG51bGw7IH0KICBpZighcyl7CiAgICByb290LmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gcmV0cmlldmUgdGhpcyBzdG9jayIsICJUaGUgdGlja2VyIHlvdSdyZSBsb29raW5nIGZvciBpc24ndCBhdmFpbGFibGUgcmln",
  "aHQgbm93LiIpOwogICAgcmV0dXJuOwogIH0KICBjb25zdCBwb3MgPSBzLnBjdCA+PSAwOwogIGNvbnN0IGluV2F0Y2ggPSBzdGF0ZS53YXRjaGxpc3QuaW5jbHVkZXMocy50KTsKCiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3Ij4KICAg",
  "ICAgPGRpdiBjbGFzcz0iZGV0YWlsLWhlYWQiPgogICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC10aXRsZS1yb3ciPgogICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXRpY2tlci1iYWRnZSI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICAgIDxkaXY+",
  "CiAgICAgICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofSDCtyAke3Muc2VjdG9yfTwvZGl2PgogICAgICAg",
  "ICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTRweDsiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXByaWNlLWJsb2NrIj4KICAgICAgICAgICAgPGRpdiBj",
  "bGFzcz0iZGV0YWlsLXByaWNlIHRhYnVsYXIiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtY2hhbmdlICR7cG9zPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihzLmNoYW5nZSl9ICgke3BjdFN0cihz",
  "LnBjdCl9KSB0b2RheTwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJpY29uLWJ0biIgaWQ9ImRldGFpbFN0YXIiIHN0eWxlPSJ3aWR0aDo0NHB4O2hlaWdodDo0NHB4O2NvbG9yOiR7aW5XYXRjaD8nI0ZGQzg1Nyc6J3Zhcigt",
  "LXRleHQtbWlkKSd9Ij4KICAgICAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9IiR7aW5XYXRjaD8nY3VycmVudENvbG9yJzonbm9uZSd9IiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHlsZT0id2lkdGg6MTlweDto",
  "ZWlnaHQ6MTlweDsiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9zdmc+CiAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4K",
  "ICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPgogICAgICAgICR7bWV0cmljQ2FyZCgiT3BlbiIsIGZtdElOUihzLm9wZW4pKX0KICAgICAgICAke21ldHJpY0NhcmQoIkRheSBIaWdoIiwgZm10SU5SKHMuZGF5SGlnaCkpfQogICAg",
  "ICAgICR7bWV0cmljQ2FyZCgiRGF5IExvdyIsIGZtdElOUihzLmRheUxvdykpfQogICAgICAgICR7bWV0cmljQ2FyZCgiTWFya2V0IENhcCIsIGZtdENvbXBhY3Qocy5tYXJrZXRDYXApKX0KICAgICAgICAke21ldHJpY0NhcmQoIlZvbHVtZSIsIGZtdFZvbChzLnZv",
  "bHVtZSkpfQogICAgICAgICR7bWV0cmljQ2FyZCgiNTJXIEhpZ2ggLyBMb3ciLCBmbXRJTlIocy5oaWdoNTIsMCkrIiAvICIrZm10SU5SKHMubG93NTIsMCkpfQogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGNoYXJ0LWNhcmQiPgogICAgICAg",
  "IDxkaXYgY2xhc3M9ImNoYXJ0LWhlYWQiPgogICAgICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIiBzdHlsZT0ibWFyZ2luOjA7Ij48aDI+UHJpY2UgQ2hhcnQ8L2gyPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0icmFuZ2UtdGFicyIgaWQ9InJhbmdl",
  "VGFicyI+CiAgICAgICAgICAgICR7WyIxRCIsIjFXIiwiMU0iLCIzTSIsIjZNIiwiMVkiXS5tYXAocj0+YDxidXR0b24gZGF0YS1yYW5nZT0iJHtyfSIgY2xhc3M9IiR7c3RhdGUuZGV0YWlsUmFuZ2U9PT1yPydhY3RpdmUnOicnfSI+JHtyfTwvYnV0dG9uPmApLmpv",
  "aW4oIiIpfQogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtY2FudmFzLXdyYXAiIGlkPSJjaGFydFdyYXAiPgogICAgICAgICAgPGNhbnZhcyBpZD0icHJpY2VDaGFydCI+PC9jYW52YXM+CiAgICAgICAgICA8",
  "ZGl2IGNsYXNzPSJjaGFydC10b29sdGlwIiBpZD0iY2hhcnRUb29sdGlwIj48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ2b2x1bWUtd3JhcCIgaWQ9InZvbHVtZVdyYXAiPgogICAgICAgICAgPGRpdiBjbGFzcz0idm9sdW1lLWxhYmVs",
  "Ij5Wb2x1bWUgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtZmFpbnQpO2ZvbnQtd2VpZ2h0OjYwMDsiPihyZWxhdGl2ZSwgZGVyaXZlZCBmcm9tIHByaWNlIG1vdmVtZW50KTwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDxjYW52YXMgaWQ9InZvbHVtZUNoYXJ0",
  "Ij48L2NhbnZhcz4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tYm90dG9tOjI4cHg7Ij4KICAgICAgICA8YnV0dG9uIGNsYXNzPSJleHBsYWluLWJ0biIgaWQ9ImV4cGxhaW5CdG4iPgogICAgICAgICAgPHN2ZyB2",
  "aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDhWNEg4Ii8+PHJlY3QgeD0iNCIg",
  "eT0iOCIgd2lkdGg9IjE2IiBoZWlnaHQ9IjEyIiByeD0iMiIvPjxwYXRoIGQ9Ik0yIDE0aDJNMjAgMTRoMk05IDEzdjJNMTUgMTN2MiIvPjwvc3ZnPgogICAgICAgICAgRXhwbGFpbiB0aGlzIHN0b2NrCiAgICAgICAgPC9idXR0b24+CiAgICAgICAgPGRpdiBjbGFz",
  "cz0iZ2xhc3MgZXhwbGFpbi1jYXJkIiBpZD0iZXhwbGFpbkNhcmQiIHN0eWxlPSJkaXNwbGF5Om5vbmU7Ij48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4KICBgOwoKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZGV0YWlsU3RhciIpLmFkZEV2ZW50TGlz",
  "dGVuZXIoImNsaWNrIiwgKCk9PnsKICAgIHRvZ2dsZVdhdGNoKHMudCk7CiAgICByZW5kZXJEZXRhaWwoKTsKICB9KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgicmFuZ2VUYWJzIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgIGNvbnN0",
  "IGJ0biA9IGUudGFyZ2V0LmNsb3Nlc3QoImJ1dHRvbltkYXRhLXJhbmdlXSIpOwogICAgaWYoIWJ0bikgcmV0dXJuOwogICAgc3RhdGUuZGV0YWlsUmFuZ2UgPSBidG4uZGF0YXNldC5yYW5nZTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIiNyYW5nZVRh",
  "YnMgYnV0dG9uIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGI9PT1idG4pKTsKICAgIGxvYWRDaGFydChzLnQsIHMucGN0Pj0wKTsKICB9KTsKICB3aXJlRXhwbGFpbkJ1dHRvbihzLnQpOwoKICBsb2FkQ2hhcnQocy50LCBwb3MpOwp9",
  "CgpmdW5jdGlvbiBtZXRyaWNDYXJkKGxhYmVsLCB2YWx1ZSl7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJnbGFzcyBtZXRyaWMtY2FyZCI+PGRpdiBjbGFzcz0ibWV0cmljLWxhYmVsIj4ke2xhYmVsfTwvZGl2PjxkaXYgY2xhc3M9Im1ldHJpYy12YWx1ZSB0YWJ1bGFy",
  "Ij4ke3ZhbHVlfTwvZGl2PjwvZGl2PmA7Cn0KCmFzeW5jIGZ1bmN0aW9uIGxvYWRDaGFydCh0aWNrZXIsIHBvc2l0aXZlKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImNoYXJ0V3JhcCIpOwogIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50",
  "LmdldEVsZW1lbnRCeUlkKCJwcmljZUNoYXJ0Iik7CiAgaWYoIXdyYXAgfHwgIWNhbnZhcykgcmV0dXJuOwogIGNhbnZhcy5zdHlsZS5vcGFjaXR5ID0gIjAuMjUiOwogIGxldCBzZXJpZXM7CiAgdHJ5ewogICAgc2VyaWVzID0gYXdhaXQgQVBJLmZldGNoU3RvY2tI",
  "aXN0b3J5KHRpY2tlciwgc3RhdGUuZGV0YWlsUmFuZ2UpOwogIH1jYXRjaChlKXsKICAgIHdyYXAuaW5uZXJIVE1MID0gZXJyb3JTdGF0ZUhUTUwoIkNoYXJ0IGRhdGEgdW5hdmFpbGFibGUiLCAiVGhpcyB0aW1lZnJhbWUgY291bGRuJ3QgYmUgbG9hZGVkLiBUcnkg",
  "YSBkaWZmZXJlbnQgcmFuZ2UuIik7CiAgICByZXR1cm47CiAgfQogIGNhbnZhcy5zdHlsZS5vcGFjaXR5ID0gIjEiOwogIGRyYXdDaGFydChjYW52YXMsIHNlcmllcywgcG9zaXRpdmUsIHRpY2tlcik7CiAgZHJhd1ZvbHVtZUNoYXJ0KHNlcmllcywgcG9zaXRpdmUp",
  "Owp9CgpmdW5jdGlvbiBkcmF3Vm9sdW1lQ2hhcnQoc2VyaWVzLCBwb3NpdGl2ZSl7CiAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInZvbHVtZUNoYXJ0Iik7CiAgaWYoIWNhbnZhcykgcmV0dXJuOwogIGNvbnN0IHJlY3QgPSBjYW52YXMu",
  "Z2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgY29uc3QgZHByID0gd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTsKICBjYW52YXMud2lkdGggPSByZWN0LndpZHRoICogZHByOwogIGNhbnZhcy5oZWlnaHQgPSByZWN0LmhlaWdodCAqIGRwcjsKICBjb25zdCBj",
  "dHggPSBjYW52YXMuZ2V0Q29udGV4dCgiMmQiKTsKICBjdHguc2NhbGUoZHByLGRwcik7CiAgY29uc3QgVyA9IHJlY3Qud2lkdGgsIEggPSByZWN0LmhlaWdodDsKICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwoKICAvLyBEZXJpdmUgYSBwbGF1c2libGUgcmVsYXRp",
  "dmUgdm9sdW1lIHByb2ZpbGUgZnJvbSB0aGUgcHJpY2Ugc2VyaWVzJwogIC8vIHBvaW50LXRvLXBvaW50IHZvbGF0aWxpdHkgKGJpZ2dlciBtb3ZlcyB0ZW5kIHRvIGNvaW5jaWRlIHdpdGggaGlnaGVyCiAgLy8gdm9sdW1lKSDigJQgaWxsdXN0cmF0aXZlIG9ubHk7",
  "IHRoZSBiYWNrZW5kIGhhcyBubyBoaXN0b3JpY2FsIHZvbHVtZSBmZWVkLgogIGNvbnN0IGRlbHRhcyA9IHNlcmllcy5tYXAoKHYsaSk9PiBpPT09MCA/IDAgOiBNYXRoLmFicyh2LXNlcmllc1tpLTFdKSk7CiAgY29uc3QgbWF4RCA9IE1hdGgubWF4KC4uLmRlbHRh",
  "cywgMWUtNik7CiAgY29uc3QgYmFyVyA9IFcvc2VyaWVzLmxlbmd0aDsKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8gIiMzM0Q2QTYiIDogIiNGQjZCNkIiOwogIHNlcmllcy5mb3JFYWNoKCh2LGkpPT57CiAgICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChzdGF0",
  "ZS5kZXRhaWxUaWNrZXIpK2kqNzsKICAgIGNvbnN0IGggPSBNYXRoLm1heCgzLCAoZGVsdGFzW2ldL21heEQpICogSCAqIDAuODUgKiAoMC41NSArIHNlZWRlZFJhbmQoc2VlZCkqMC42KSk7CiAgICBjb25zdCB1cCA9IGk9PT0wID8gdHJ1ZSA6IHNlcmllc1tpXSA+",
  "PSBzZXJpZXNbaS0xXTsKICAgIGN0eC5maWxsU3R5bGUgPSB1cCA/ICJyZ2JhKDUxLDIxNCwxNjYsMC41NSkiIDogInJnYmEoMjUxLDEwNywxMDcsMC41NSkiOwogICAgY3R4LmZpbGxSZWN0KGkqYmFyVytiYXJXKjAuMTUsIEgtaCwgTWF0aC5tYXgoMSxiYXJXKjAu",
  "NyksIGgpOwogIH0pOwp9CgpmdW5jdGlvbiBkcmF3Q2hhcnQoY2FudmFzLCBzZXJpZXMsIHBvc2l0aXZlLCB0aWNrZXIpewogIGNvbnN0IHdyYXAgPSBjYW52YXMucGFyZW50RWxlbWVudDsKICBjb25zdCBkcHIgPSB3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAx",
  "OwogIGNvbnN0IHJlY3QgPSB3cmFwLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogIGNhbnZhcy53aWR0aCA9IHJlY3Qud2lkdGggKiBkcHI7CiAgY2FudmFzLmhlaWdodCA9IHJlY3QuaGVpZ2h0ICogZHByOwogIGNhbnZhcy5zdHlsZS53aWR0aCA9IHJlY3Qud2lk",
  "dGgrInB4IjsKICBjYW52YXMuc3R5bGUuaGVpZ2h0ID0gcmVjdC5oZWlnaHQrInB4IjsKICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgiMmQiKTsKICBjdHguc2NhbGUoZHByLGRwcik7CgogIGNvbnN0IFcgPSByZWN0LndpZHRoLCBIID0gcmVjdC5oZWln",
  "aHQ7CiAgY29uc3QgcGFkID0ge3RvcDoxNiwgcmlnaHQ6OCwgYm90dG9tOjI0LCBsZWZ0Ojh9OwogIGNvbnN0IG1pbiA9IE1hdGgubWluKC4uLnNlcmllcyksIG1heCA9IE1hdGgubWF4KC4uLnNlcmllcyk7CiAgY29uc3QgcmFuZ2VWID0gKG1heC1taW4pIHx8IDE7",
  "CiAgY29uc3QgaW5uZXJXID0gVyAtIHBhZC5sZWZ0IC0gcGFkLnJpZ2h0OwogIGNvbnN0IGlubmVySCA9IEggLSBwYWQudG9wIC0gcGFkLmJvdHRvbTsKICBjb25zdCBzdGVwID0gaW5uZXJXLyhzZXJpZXMubGVuZ3RoLTEpOwoKICBmdW5jdGlvbiB4eShpLHYpewog",
  "ICAgcmV0dXJuIFtwYWQubGVmdCArIGkqc3RlcCwgcGFkLnRvcCArIGlubmVySCAtICgodi1taW4pL3JhbmdlVikqaW5uZXJIXTsKICB9CiAgY29uc3QgcHRzID0gc2VyaWVzLm1hcCgodixpKT0+eHkoaSx2KSk7CgogIGN0eC5jbGVhclJlY3QoMCwwLFcsSCk7Cgog",
  "IC8vIGdyaWRsaW5lcwogIGN0eC5zdHJva2VTdHlsZSA9ICJyZ2JhKDE1OCwxNzEsMjE0LDAuMDgpIjsKICBjdHgubGluZVdpZHRoID0gMTsKICBmb3IobGV0IGk9MDtpPD0zO2krKyl7CiAgICBjb25zdCB5ID0gcGFkLnRvcCArIChpbm5lckgvMykqaTsKICAgIGN0",
  "eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbyhwYWQubGVmdCx5KTsgY3R4LmxpbmVUbyhXLXBhZC5yaWdodCx5KTsgY3R4LnN0cm9rZSgpOwogIH0KCiAgY29uc3QgY29sb3IgPSBwb3NpdGl2ZSA/ICIjMzNENkE2IiA6ICIjRkI2QjZCIjsKCiAgLy8gc21vb3RoIHBh",
  "dGgKICBmdW5jdGlvbiBzbW9vdGhQYXRoKHBvaW50cyl7CiAgICBpZihwb2ludHMubGVuZ3RoPDMpIHJldHVybiBgTSR7cG9pbnRzWzBdWzBdfSwke3BvaW50c1swXVsxXX0gTCR7cG9pbnRzWzFdWzBdfSwke3BvaW50c1sxXVsxXX1gOwogICAgbGV0IGQgPSBgTSR7",
  "cG9pbnRzWzBdWzBdfSwke3BvaW50c1swXVsxXX1gOwogICAgZm9yKGxldCBpPTA7aTxwb2ludHMubGVuZ3RoLTE7aSsrKXsKICAgICAgY29uc3QgcDAgPSBwb2ludHNbaT09PTA/MDppLTFdOwogICAgICBjb25zdCBwMSA9IHBvaW50c1tpXTsKICAgICAgY29uc3Qg",
  "cDIgPSBwb2ludHNbaSsxXTsKICAgICAgY29uc3QgcDMgPSBwb2ludHNbaSsyPHBvaW50cy5sZW5ndGg/aSsyOmkrMV07CiAgICAgIGNvbnN0IGNwMXggPSBwMVswXSArIChwMlswXS1wMFswXSkvNjsKICAgICAgY29uc3QgY3AxeSA9IHAxWzFdICsgKHAyWzFdLXAw",
  "WzFdKS82OwogICAgICBjb25zdCBjcDJ4ID0gcDJbMF0gLSAocDNbMF0tcDFbMF0pLzY7CiAgICAgIGNvbnN0IGNwMnkgPSBwMlsxXSAtIChwM1sxXS1wMVsxXSkvNjsKICAgICAgZCArPSBgIEMke2NwMXh9LCR7Y3AxeX0gJHtjcDJ4fSwke2NwMnl9ICR7cDJbMF19",
  "LCR7cDJbMV19YDsKICAgIH0KICAgIHJldHVybiBkOwogIH0KICBjb25zdCBsaW5lUGF0aCA9IG5ldyBQYXRoMkQoc21vb3RoUGF0aChwdHMpKTsKCiAgLy8gYXJlYSBmaWxsCiAgY29uc3QgZ3JhZCA9IGN0eC5jcmVhdGVMaW5lYXJHcmFkaWVudCgwLHBhZC50b3As",
  "MCxwYWQudG9wK2lubmVySCk7CiAgZ3JhZC5hZGRDb2xvclN0b3AoMCwgY29sb3IrIjU1Iik7CiAgZ3JhZC5hZGRDb2xvclN0b3AoMSwgY29sb3IrIjAyIik7CiAgY3R4LnNhdmUoKTsKICBjb25zdCBhcmVhUGF0aCA9IG5ldyBQYXRoMkQoc21vb3RoUGF0aChwdHMp",
  "KTsKICBhcmVhUGF0aC5saW5lVG8ocHRzW3B0cy5sZW5ndGgtMV1bMF0sIHBhZC50b3AraW5uZXJIKTsKICBhcmVhUGF0aC5saW5lVG8ocHRzWzBdWzBdLCBwYWQudG9wK2lubmVySCk7CiAgYXJlYVBhdGguY2xvc2VQYXRoKCk7CiAgY3R4LmZpbGxTdHlsZSA9IGdy",
  "YWQ7CiAgY3R4LmZpbGwoYXJlYVBhdGgpOwogIGN0eC5yZXN0b3JlKCk7CgogIC8vIGxpbmUKICBjdHguc3Ryb2tlU3R5bGUgPSBjb2xvcjsKICBjdHgubGluZVdpZHRoID0gMjsKICBjdHgubGluZUpvaW4gPSAicm91bmQiOwogIGN0eC5saW5lQ2FwID0gInJvdW5k",
  "IjsKICBjdHguc3Ryb2tlKGxpbmVQYXRoKTsKCiAgLy8gZW50cmFuY2UgYW5pbWF0aW9uIHZpYSBjbGlwIHJldmVhbAogIGNhbnZhcy5fY2hhcnRNZXRhID0ge3B0cywgc2VyaWVzLCBXLCBILCBwYWQsIGNvbG9yfTsKCiAgLy8gY3Jvc3NoYWlyIGludGVyYWN0aXZp",
  "dHkKICBjb25zdCB0b29sdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImNoYXJ0VG9vbHRpcCIpOwogIGNhbnZhcy5vbm1vdXNlbW92ZSA9IChlKT0+ewogICAgY29uc3QgciA9IGNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgIGNvbnN0IG14",
  "ID0gZS5jbGllbnRYIC0gci5sZWZ0OwogICAgbGV0IGlkeCA9IE1hdGgucm91bmQoKG14LXBhZC5sZWZ0KS9zdGVwKTsKICAgIGlkeCA9IE1hdGgubWF4KDAsIE1hdGgubWluKHNlcmllcy5sZW5ndGgtMSwgaWR4KSk7CiAgICBjb25zdCBbcHgscHldID0gcHRzW2lk",
  "eF07CgogICAgcmVkcmF3V2l0aENyb3NzaGFpcihjdHgsIGNhbnZhcy5fY2hhcnRNZXRhLCBweCwgcHkpOwoKICAgIHRvb2x0aXAuc3R5bGUub3BhY2l0eSA9ICIxIjsKICAgIHRvb2x0aXAuc3R5bGUubGVmdCA9IHB4KyJweCI7CiAgICB0b29sdGlwLnN0eWxlLnRv",
  "cCA9IHB5KyJweCI7CiAgICB0b29sdGlwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ0dC1wcmljZSI+JHtmbXRJTlIoc2VyaWVzW2lkeF0pfTwvZGl2PjxkaXYgY2xhc3M9InR0LWRhdGUiPlBvaW50ICR7aWR4KzF9IG9mICR7c2VyaWVzLmxlbmd0aH08L2Rpdj5g",
  "OwogIH07CiAgY2FudmFzLm9ubW91c2VsZWF2ZSA9ICgpPT57CiAgICB0b29sdGlwLnN0eWxlLm9wYWNpdHkgPSAiMCI7CiAgICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwogICAgcmVkcmF3KGN0eCwgY2FudmFzLl9jaGFydE1ldGEpOwogIH07CgogIGZ1bmN0aW9u",
  "IHJlZHJhdyhjdHgsIG1ldGEpewogICAgY29uc3Qge3B0cywgVywgSCwgcGFkLCBjb2xvcn0gPSBtZXRhOwogICAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9ICJyZ2JhKDE1OCwxNzEsMjE0LDAuMDgpIjsKICAgIGN0eC5saW5l",
  "V2lkdGggPSAxOwogICAgY29uc3QgaW5uZXJIMiA9IEgtcGFkLnRvcC1wYWQuYm90dG9tOwogICAgZm9yKGxldCBpPTA7aTw9MztpKyspewogICAgICBjb25zdCB5ID0gcGFkLnRvcCArIChpbm5lckgyLzMpKmk7CiAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1v",
  "dmVUbyhwYWQubGVmdCx5KTsgY3R4LmxpbmVUbyhXLXBhZC5yaWdodCx5KTsgY3R4LnN0cm9rZSgpOwogICAgfQogICAgY29uc3QgZ3JhZDIgPSBjdHguY3JlYXRlTGluZWFyR3JhZGllbnQoMCxwYWQudG9wLDAscGFkLnRvcCtpbm5lckgyKTsKICAgIGdyYWQyLmFk",
  "ZENvbG9yU3RvcCgwLCBjb2xvcisiNTUiKTsgZ3JhZDIuYWRkQ29sb3JTdG9wKDEsIGNvbG9yKyIwMiIpOwogICAgY29uc3QgYXJlYVBhdGgyID0gbmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpOwogICAgYXJlYVBhdGgyLmxpbmVUbyhwdHNbcHRzLmxlbmd0aC0x",
  "XVswXSwgcGFkLnRvcCtpbm5lckgyKTsKICAgIGFyZWFQYXRoMi5saW5lVG8ocHRzWzBdWzBdLCBwYWQudG9wK2lubmVySDIpOwogICAgYXJlYVBhdGgyLmNsb3NlUGF0aCgpOwogICAgY3R4LmZpbGxTdHlsZSA9IGdyYWQyOyBjdHguZmlsbChhcmVhUGF0aDIpOwog",
  "ICAgY3R4LnN0cm9rZVN0eWxlID0gY29sb3I7IGN0eC5saW5lV2lkdGggPSAyOyBjdHgubGluZUpvaW49InJvdW5kIjsgY3R4LmxpbmVDYXA9InJvdW5kIjsKICAgIGN0eC5zdHJva2UobmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpKTsKICB9CiAgZnVuY3Rpb24g",
  "cmVkcmF3V2l0aENyb3NzaGFpcihjdHgsIG1ldGEsIHB4LCBweSl7CiAgICByZWRyYXcoY3R4LCBtZXRhKTsKICAgIGNvbnN0IHtILCBwYWQsIGNvbG9yfSA9IG1ldGE7CiAgICBjdHguc2F2ZSgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gInJnYmEoMTU4LDE3MSwy",
  "MTQsMC4zNSkiOwogICAgY3R4LmxpbmVXaWR0aCA9IDE7CiAgICBjdHguc2V0TGluZURhc2goWzMsM10pOwogICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKHB4LCBwYWQudG9wKTsgY3R4LmxpbmVUbyhweCwgSC1wYWQuYm90dG9tKTsgY3R4LnN0cm9rZSgp",
  "OwogICAgY3R4LnNldExpbmVEYXNoKFtdKTsKICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyhweCxweSw0LDAsTWF0aC5QSSoyKTsKICAgIGN0eC5maWxsU3R5bGUgPSBjb2xvcjsgY3R4LmZpbGwoKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9ICIjMDUwNjBCIjsg",
  "Y3R4LmxpbmVXaWR0aD0yOyBjdHguc3Ryb2tlKCk7CiAgICBjdHgucmVzdG9yZSgpOwogIH0KfQoKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInJlc2l6ZSIsIGRlYm91bmNlKCgpPT57CiAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInBy",
  "aWNlQ2hhcnQiKTsKICBpZihjYW52YXMgJiYgc3RhdGUudmlldz09PSJkZXRhaWwiKSBsb2FkQ2hhcnQoc3RhdGUuZGV0YWlsVGlja2VyLCB0cnVlKTsKfSwgMjAwKSk7CgovKiAtLS0tLS0tLS0tLS0tLS0tIFNUQVRFIEhFTFBFUlMgLS0tLS0tLS0tLS0tLS0tLSAq",
  "LwpmdW5jdGlvbiBlbXB0eVN0YXRlSW5uZXIodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGAKICAgIDxkaXYgY2xhc3M9InN0YXRlLWljb24iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMjIiIGhlaWdodD0iMjIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3Vy",
  "cmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEgMjFsLTQuMy00LjMiLz48L3N2Zz48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXRpdGxlIj4ke3RpdGxlfTwvZGl2PgogICAgPGRp",
  "diBjbGFzcz0ic3RhdGUtc3ViIj4ke3N1Yn08L2Rpdj4KICBgOwp9CmZ1bmN0aW9uIGVtcHR5U3RhdGVIVE1MKHRpdGxlLCBzdWIpewogIHJldHVybiBgPGRpdiBjbGFzcz0ic3RhdGUtYm94Ij4ke2VtcHR5U3RhdGVJbm5lcih0aXRsZSwgc3ViKX08L2Rpdj5gOwp9",
  "CmZ1bmN0aW9uIGVycm9yU3RhdGVIVE1MKHRpdGxlLCBzdWIpewogIHJldHVybiBgPGRpdiBjbGFzcz0ic3RhdGUtYm94Ij4KICAgIDxkaXYgY2xhc3M9InN0YXRlLWljb24iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMjIiIGhlaWdodD0iMjIiIGZp",
  "bGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiA5djRNMTIgMTdoLjAxTTEwLjI5IDMuODZMMS44MiAxOGEyIDIgMCAwMDEuNzEgM2gxNi45NGEyIDIgMCAwMDEuNzEtM0wxMy43MSAzLjg2YTIgMiAwIDAw",
  "LTMuNDIgMHoiLz48L3N2Zz48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXRpdGxlIj4ke3RpdGxlfTwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtc3ViIj4ke3N1Yn08L2Rpdj4KICA8L2Rpdj5gOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEJPT1QKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEFJIEFTU0lTVEFOVCDigJQgY2hhdCBwYW5lbCArIHBlci1zdG9jayBleHBsYWluCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT0gKi8KY29uc3QgYWlTdGF0ZSA9IHsgb3BlbjogZmFsc2UsIGhpc3Rvcnk6IFtdLCBjb25maWd1cmVkOiBudWxsLCBidXN5OiBmYWxzZSB9OwoKZnVuY3Rpb24gYWlTZXRTdGF0dXNMaW5lKHRleHQpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVu",
  "dEJ5SWQoImFpU3RhdHVzTGluZSIpOwogIGlmKGVsKSBlbC50ZXh0Q29udGVudCA9IHRleHQ7Cn0KCmFzeW5jIGZ1bmN0aW9uIGNoZWNrQWlTdGF0dXMoKXsKICB0cnl7CiAgICBjb25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChDT05GSUcuQVBJX0JBU0Ug",
  "KyAiL2FpL3N0YXR1cyIsIENPTkZJRy5MSVZFX1RJTUVPVVRfTVMpOwogICAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcigiYmFkIHN0YXR1cyIpOwogICAgY29uc3QganNvbiA9IGF3YWl0IHIuanNvbigpOwogICAgYWlTdGF0ZS5jb25maWd1cmVkID0gISFqc29u",
  "LmNvbmZpZ3VyZWQ7CiAgICBhaVNldFN0YXR1c0xpbmUoYWlTdGF0ZS5jb25maWd1cmVkID8gIlJlYWR5IiA6ICJOb3QgY29uZmlndXJlZCBvbiBzZXJ2ZXIiKTsKICB9Y2F0Y2goZSl7CiAgICBhaVN0YXRlLmNvbmZpZ3VyZWQgPSBmYWxzZTsKICAgIGFpU2V0U3Rh",
  "dHVzTGluZShsaXZlQmFja2VuZEF2YWlsYWJsZSA/ICJVbmF2YWlsYWJsZSIgOiAiQmFja2VuZCBub3QgY29ubmVjdGVkIik7CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBidWlsZEFpQ29udGV4dCgpewogIC8vIFJlYWwgbWFya2V0IHNuYXBzaG90IHNvIHRoZSBhc3Np",
  "c3RhbnQgY2FuIGFuc3dlciBnZW5lcmFsIHF1ZXN0aW9ucwogIC8vICgid2hvIGFyZSB0aGUgZ2FpbmVycyIsICJob3cncyBteSB3YXRjaGxpc3QgZG9pbmciKSBub3QganVzdCBxdWVzdGlvbnMKICAvLyBhYm91dCB3aGF0ZXZlciBzaW5nbGUgc3RvY2sgaGFwcGVu",
  "cyB0byBiZSBvbiBzY3JlZW4uIFJldXNlcyB0aGUgc2FtZQogIC8vIGNhY2hlZC9zaGFyZWQgZmV0Y2ggdGhlIHJlc3Qgb2YgdGhlIGFwcCB1c2VzLCBzbyB0aGlzIGRvZXNuJ3QgY29zdCBhbnkKICAvLyBleHRyYSBOU0UgY2FsbHMgd2hlbiB0aGUgY2FjaGUgaXMg",
  "YWxyZWFkeSB3YXJtLgogIGNvbnN0IGN0eCA9IHsgdmlldzogc3RhdGUudmlldyB9OwogIHRyeXsKICAgIGNvbnN0IGxpc3QgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoe30pOwogICAgY29uc3QgY29tcGFjdCA9IGxpc3QubWFwKHM9Pih7dGlja2Vy",
  "OnMudCwgbmFtZTpzLm5hbWUsIHByaWNlOnMucHJpY2UsIGNoYW5nZVBjdDpzLnBjdCwgc2VjdG9yOnMuc2VjdG9yfSkpOwogICAgY29uc3QgYnlTaXplID0gbGlzdC5zbGljZSgpLnNvcnQoKGEsYik9PmIucGN0LWEucGN0KTsKICAgIGN0eC5tYXJrZXQgPSB7CiAg",
  "ICAgIGFzT2Y6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwKICAgICAgc3RvY2tzOiBjb21wYWN0LAogICAgICB0b3BHYWluZXJzOiBieVNpemUuc2xpY2UoMCw1KS5tYXAocz0+KHt0aWNrZXI6cy50LCBjaGFuZ2VQY3Q6cy5wY3QsIHByaWNlOnMucHJpY2V9KSks",
  "CiAgICAgIHRvcExvc2VyczogYnlTaXplLnNsaWNlKC01KS5yZXZlcnNlKCkubWFwKHM9Pih7dGlja2VyOnMudCwgY2hhbmdlUGN0OnMucGN0LCBwcmljZTpzLnByaWNlfSkpLAogICAgfTsKICB9Y2F0Y2goZSl7CiAgICBjdHgubWFya2V0RGF0YUVycm9yID0gIkNv",
  "dWxkIG5vdCBsb2FkIGN1cnJlbnQgbWFya2V0IGRhdGEuIjsKICB9CiAgaWYoc3RhdGUudmlldyA9PT0gImRldGFpbCIpIGN0eC5jdXJyZW50bHlWaWV3aW5nU3RvY2sgPSBzdGF0ZS5kZXRhaWxUaWNrZXI7CiAgaWYoc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCkgY3R4",
  "LndhdGNobGlzdFRpY2tlcnMgPSBzdGF0ZS53YXRjaGxpc3Quc2xpY2UoMCwgMTApOwogIHJldHVybiBjdHg7Cn0KCmZ1bmN0aW9uIGFwcGVuZEFpTWVzc2FnZShyb2xlLCB0ZXh0LCBleHRyYUNsYXNzKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVu",
  "dEJ5SWQoImFpTWVzc2FnZXMiKTsKICBpZighd3JhcCkgcmV0dXJuIG51bGw7CiAgY29uc3QgZGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiZGl2Iik7CiAgZGl2LmNsYXNzTmFtZSA9ICJhaS1tc2cgIiArIHJvbGUgKyAoZXh0cmFDbGFzcyA/ICIgIiArIGV4",
  "dHJhQ2xhc3MgOiAiIik7CiAgZGl2LnRleHRDb250ZW50ID0gdGV4dDsKICB3cmFwLmFwcGVuZENoaWxkKGRpdik7CiAgd3JhcC5zY3JvbGxUb3AgPSB3cmFwLnNjcm9sbEhlaWdodDsKICByZXR1cm4gZGl2Owp9Cgphc3luYyBmdW5jdGlvbiBzZW5kQWlNZXNzYWdl",
  "KHF1ZXN0aW9uKXsKICBpZighcXVlc3Rpb24udHJpbSgpIHx8IGFpU3RhdGUuYnVzeSkgcmV0dXJuOwogIGFwcGVuZEFpTWVzc2FnZSgidXNlciIsIHF1ZXN0aW9uKTsKICBhaVN0YXRlLmJ1c3kgPSB0cnVlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVNl",
  "bmRCdG4iKS5kaXNhYmxlZCA9IHRydWU7CiAgY29uc3QgcGVuZGluZyA9IGFwcGVuZEFpTWVzc2FnZSgiYXNzaXN0YW50IiwgIlRoaW5raW5n4oCmIiwgInBlbmRpbmciKTsKCiAgdHJ5ewogICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSBhd2FpdCBjaGVja0xp",
  "dmVCYWNrZW5kKCk7IC8vIG1heSBqdXN0IGJlIHdha2luZyBmcm9tIGEgY29sZCBzdGFydAogICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSB0aHJvdyBuZXcgRXJyb3IoIkJhY2tlbmQgbm90IGNvbm5lY3RlZCDigJQgdGhlIEFJIGFzc2lzdGFudCBuZWVkcyB0",
  "aGUgbGl2ZSBiYWNrZW5kIHJ1bm5pbmcuIElmIGl0IHdhcyBqdXN0IGlkbGUsIHRyeSBhZ2FpbiBpbiBhIG1vbWVudC4iKTsKICAgIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250cm9sbGVyKCk7CiAgICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCk9PmN0cmwuYWJv",
  "cnQoKSwgMjAwMDApOwogICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goQ09ORklHLkFQSV9CQVNFICsgIi9jaGF0IiwgewogICAgICBtZXRob2Q6ICJQT1NUIiwKICAgICAgaGVhZGVyczogeyJDb250ZW50LVR5cGUiOiAiYXBwbGljYXRpb24vanNvbiJ9LAogICAg",
  "ICBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgcXVlc3Rpb246IHF1ZXN0aW9uLnRyaW0oKSwKICAgICAgICBjb250ZXh0OiBhd2FpdCBidWlsZEFpQ29udGV4dCgpLAogICAgICAgIGhpc3Rvcnk6IGFpU3RhdGUuaGlzdG9yeS5zbGljZSgtNiksCiAgICAg",
  "IH0pLAogICAgICBzaWduYWw6IGN0cmwuc2lnbmFsLAogICAgfSkuZmluYWxseSgoKT0+Y2xlYXJUaW1lb3V0KGlkKSk7CgogICAgY29uc3QganNvbiA9IGF3YWl0IHJlcy5qc29uKCk7CiAgICBpZighcmVzLm9rIHx8ICFqc29uLnN1Y2Nlc3MpIHRocm93IG5ldyBF",
  "cnJvcigoanNvbi5lcnJvciAmJiBqc29uLmVycm9yLm1lc3NhZ2UpIHx8ICgiUmVxdWVzdCBmYWlsZWQgKCIgKyByZXMuc3RhdHVzICsgIikiKSk7CgogICAgcGVuZGluZy5yZW1vdmUoKTsKICAgIGFwcGVuZEFpTWVzc2FnZSgiYXNzaXN0YW50IiwganNvbi5kYXRh",
  "LmFuc3dlcik7CiAgICBhaVN0YXRlLmhpc3RvcnkucHVzaCh7cm9sZToidXNlciIsIGNvbnRlbnQ6IHF1ZXN0aW9uLnRyaW0oKX0pOwogICAgYWlTdGF0ZS5oaXN0b3J5LnB1c2goe3JvbGU6ImFzc2lzdGFudCIsIGNvbnRlbnQ6IGpzb24uZGF0YS5hbnN3ZXJ9KTsK",
  "ICB9Y2F0Y2goZSl7CiAgICBwZW5kaW5nLnJlbW92ZSgpOwogICAgYXBwZW5kQWlNZXNzYWdlKCJhc3Npc3RhbnQiLCAiQ291bGRuJ3QgZ2V0IGEgcmVzcG9uc2U6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSksICJlcnJvciIpOwogIH1maW5hbGx5ewogICAgYWlT",
  "dGF0ZS5idXN5ID0gZmFsc2U7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlTZW5kQnRuIikuZGlzYWJsZWQgPSBmYWxzZTsKICB9Cn0KCmZ1bmN0aW9uIHdpcmVBaVBhbmVsKCl7CiAgY29uc3QgZmFiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFp",
  "RmFiIik7CiAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlQYW5lbCIpOwogIGNvbnN0IGNsb3NlQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpQ2xvc2VCdG4iKTsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1l",
  "bnRCeUlkKCJhaUlucHV0Iik7CiAgY29uc3Qgc2VuZEJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVNlbmRCdG4iKTsKCiAgcGFuZWwuY2xhc3NMaXN0LmFkZCgiaGlkZGVuIik7CgogIGZhYi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAg",
  "ICBhaVN0YXRlLm9wZW4gPSAhYWlTdGF0ZS5vcGVuOwogICAgcGFuZWwuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwgIWFpU3RhdGUub3Blbik7CiAgICBpZihhaVN0YXRlLm9wZW4peyBjaGVja0FpU3RhdHVzKCk7IGlucHV0LmZvY3VzKCk7IH0KICB9KTsKICBj",
  "bG9zZUJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICBhaVN0YXRlLm9wZW4gPSBmYWxzZTsKICAgIHBhbmVsLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOwogIH0pOwogIGNvbnN0IHNlbmQgPSAoKT0+ewogICAgY29uc3QgcSA9IGlucHV0LnZh",
  "bHVlOwogICAgaW5wdXQudmFsdWUgPSAiIjsKICAgIHNlbmRBaU1lc3NhZ2UocSk7CiAgfTsKICBzZW5kQnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgc2VuZCk7CiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsIChlKT0+eyBpZihlLmtleSA9",
  "PT0gIkVudGVyIikgc2VuZCgpOyB9KTsKfQoKLy8gIkV4cGxhaW4gdGhpcyBzdG9jayIg4oCUIGNhbGxlZCBmcm9tIHJlbmRlckRldGFpbCBvbmNlIHN0b2NrIGRhdGEgaXMgbG9hZGVkLgphc3luYyBmdW5jdGlvbiB3aXJlRXhwbGFpbkJ1dHRvbih0aWNrZXIpewog",
  "IGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJleHBsYWluQnRuIik7CiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJleHBsYWluQ2FyZCIpOwogIGlmKCFidG4pIHJldHVybjsKICBidG4uYWRkRXZlbnRMaXN0ZW5lcigi",
  "Y2xpY2siLCBhc3luYyAoKT0+ewogICAgYnRuLmRpc2FibGVkID0gdHJ1ZTsKICAgIGJ0bi50ZXh0Q29udGVudCA9ICJUaGlua2luZ+KApiI7CiAgICBjYXJkLnN0eWxlLmRpc3BsYXkgPSAiYmxvY2siOwogICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0i",
  "ZXhwbGFpbi1oZWFkIj48ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTNweDsiPkFJIEV4cGxhbmF0aW9uPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iZXhwbGFpbi10ZXh0Ij4ke3NrZWxl",
  "dG9uTGluZXMoMyl9PC9kaXY+YDsKICAgIHRyeXsKICAgICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSBhd2FpdCBjaGVja0xpdmVCYWNrZW5kKCk7IC8vIG1heSBqdXN0IGJlIHdha2luZyBmcm9tIGEgY29sZCBzdGFydAogICAgICBpZighbGl2ZUJhY2tlbmRB",
  "dmFpbGFibGUpIHRocm93IG5ldyBFcnJvcigiQmFja2VuZCBub3QgY29ubmVjdGVkLiBJZiBpdCB3YXMganVzdCBpZGxlLCB0cnkgYWdhaW4gaW4gYSBtb21lbnQuIik7CiAgICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KGAke0NPTkZJRy5BUElf",
  "QkFTRX0vZXhwbGFpbi8ke2VuY29kZVVSSUNvbXBvbmVudCh0aWNrZXIpfWAsIDIwMDAwKTsKICAgICAgY29uc3QganNvbiA9IGF3YWl0IHIuanNvbigpOwogICAgICBpZighci5vayB8fCAhanNvbi5zdWNjZXNzKSB0aHJvdyBuZXcgRXJyb3IoKGpzb24uZXJyb3Ig",
  "JiYganNvbi5lcnJvci5tZXNzYWdlKSB8fCAoIlJlcXVlc3QgZmFpbGVkICgiICsgci5zdGF0dXMgKyAiKSIpKTsKICAgICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZXhwbGFpbi1oZWFkIj48ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2Pjxk",
  "aXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTNweDsiPkFJIEV4cGxhbmF0aW9uPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iZXhwbGFpbi10ZXh0Ij4ke2VzY2FwZUh0bWwoanNvbi5kYXRhLmV4cGxhbmF0aW9uKX08L2Rpdj5gOwogICAgfWNhdGNo",
  "KGUpewogICAgICBjYXJkLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJleHBsYWluLWhlYWQiPjxkaXYgY2xhc3M9ImFpLWF2YXRhciI+4pymPC9kaXY+PGRpdiBzdHlsZT0iZm9udC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxM3B4OyI+QUkgRXhwbGFuYXRpb248L2Rp",
  "dj48L2Rpdj48ZGl2IGNsYXNzPSJleHBsYWluLXRleHQiIHN0eWxlPSJjb2xvcjp2YXIoLS1uZWctc29mdCk7Ij5Db3VsZG4ndCBnZW5lcmF0ZSBhbiBleHBsYW5hdGlvbjogJHtlc2NhcGVIdG1sKGUgJiYgZS5tZXNzYWdlIHx8IFN0cmluZyhlKSl9PC9kaXY+YDsK",
  "ICAgIH1maW5hbGx5ewogICAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgYnRuLnRleHRDb250ZW50ID0gIuKcpiBFeHBsYWluIHRoaXMgc3RvY2siOwogICAgfQogIH0pOwp9CgpzZXRBY3RpdmVOYXYoImRhc2hib2FyZCIpOwp3aXJlQWlQYW5lbCgpOwpj",
  "aGVja0xpdmVCYWNrZW5kKCkuZmluYWxseShyZW5kZXIpOwpzZXRJbnRlcnZhbChjaGVja0xpdmVCYWNrZW5kLCA0NTAwMCk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K"
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
