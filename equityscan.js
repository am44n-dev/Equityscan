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
  "bC50ZXh0Q29udGVudCA9IHRleHQ7Cn0KZnVuY3Rpb24gc2V0SFRNTChpZCwgaHRtbCl7CiAgY29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChpZCk7CiAgaWYoZWwpIGVsLmlubmVySFRNTCA9IGh0bWw7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSU5URUdSQVRJT04gTEFZRVIKICAgVGhpcyBmcm9udGVuZCBub3cgdGFsa3MgdG8gYSByZWFsIEVxdWl0eVNjYW4gYmFja2VuZCAoc2VlIC9iYWNrZW5kKQogICB3aGljaCBwcm94",
  "aWVzIE5TRSB2aWEgc3RvY2stbnNlLWluZGlhLCBjYWNoZWQgYW5kIGJ1ZGdldC1saW1pdGVkIHRvCiAgIH41MCB1cHN0cmVhbSBjYWxscy9kYXkuIEV2ZXJ5IEFQSS4qIG1ldGhvZCBiZWxvdyB0cmllcyB0aGUgbGl2ZQogICBiYWNrZW5kIGZpcnN0IGFuZCBmYWxs",
  "cyBiYWNrIHRvIGRldGVybWluaXN0aWMgbW9jayBkYXRhIGlmIHRoZQogICBiYWNrZW5kIGlzIHVucmVhY2hhYmxlIOKAlCB3aGljaCBpcyBleHBlY3RlZCB3aGVuIHRoaXMgcGFnZSBpcyBvcGVuZWQKICAgYXMgYSBob3N0ZWQgcHJldmlldywgc2luY2UgYSBwdWJs",
  "aXNoZWQgcGFnZSBjYW5ub3QgcmVhY2ggYQogICBsb2NhbGhvc3Qgc2VydmVyLiBSdW4gdGhlIGJhY2tlbmQgYW5kIG9wZW4gdGhpcyBmaWxlIGxvY2FsbHkgKG5vdAogICB0aGUgcHVibGlzaGVkIHByZXZpZXcpIHRvIHNlZSByZWFsIE5TRSBxdW90ZXMgZW5kIHRv",
  "IGVuZC4KICAgVGhlIGJhY2tlbmQgaGFzIG5vIGhpc3RvcmljYWwtcHJpY2UgZW5kcG9pbnQgeWV0LCBzbyBjaGFydCBzZXJpZXMKICAgYW5kIHNwYXJrbGluZXMgc3RheSBzeW50aGV0aWMgZXZlbiBpbiBsaXZlIG1vZGUg4oCUIGV2ZXJ5dGhpbmcgZWxzZQogICAo",
  "cHJpY2UsIGNoYW5nZSAlLCA1MlcgaGlnaC9sb3csIGNvbXBhbnkgbmFtZSwgbWFya2V0IHN0YXR1cykgaXMKICAgcmVhbCB3aGVuIHRoZSBiYWNrZW5kIGlzIHJlYWNoYWJsZS4KICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCBDT05GSUcgPSB7CiAgQVBJX0JBU0U6ICh3aW5kb3cubG9jYXRpb24ucHJvdG9jb2wgPT09ICJmaWxlOiIgPyAiaHR0cDovL2xvY2FsaG9zdDozMDAwIiA6IHdpbmRvdy5sb2NhdGlvbi5vcmlnaW4pICsgIi9hcGki",
  "LAogIExJVkVfVElNRU9VVF9NUzogODAwMCwKICAvLyBSZW5kZXIncyBmcmVlIHRpZXIgc3BpbnMgdGhlIHNlcnZlciBkb3duIGFmdGVyIH4xNSBtaW4gaWRsZSwgYW5kIHdha2luZwogIC8vIGl0IGJhY2sgdXAgY2FuIHRha2UgMzAtNTBzLiBUaGUgaGVhbHRoIGNo",
  "ZWNrIG5lZWRzIGEgbXVjaCBsb25nZXIgbGVhc2gKICAvLyB0aGFuIGEgbm9ybWFsIGRhdGEgcmVxdWVzdCwgb3IgaXQgd3JvbmdseSBjb25jbHVkZXMgImJhY2tlbmQgaXMgZG93biIKICAvLyBkdXJpbmcgZXhhY3RseSB0aGUgbW9tZW50IGl0J3MganVzdCBzbG93",
  "bHkgc3RhcnRpbmcgdXAuCiAgSEVBTFRIX1RJTUVPVVRfTVM6IDQ1MDAwLAp9OwpsZXQgbGl2ZUJhY2tlbmRBdmFpbGFibGUgPSBmYWxzZTsKY29uc3QgTU9DS19MQVRFTkNZID0gNDIwOwoKZnVuY3Rpb24gZmV0Y2hXaXRoVGltZW91dCh1cmwsIG1zKXsKICBjb25z",
  "dCBjdHJsID0gbmV3IEFib3J0Q29udHJvbGxlcigpOwogIGNvbnN0IGlkID0gc2V0VGltZW91dCgoKT0+Y3RybC5hYm9ydCgpLCBtcyk7CiAgcmV0dXJuIGZldGNoKHVybCwge3NpZ25hbDogY3RybC5zaWduYWx9KS5maW5hbGx5KCgpPT5jbGVhclRpbWVvdXQoaWQp",
  "KTsKfQoKYXN5bmMgZnVuY3Rpb24gY2hlY2tMaXZlQmFja2VuZCgpewogIHRyeXsKICAgIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KENPTkZJRy5BUElfQkFTRSArICIvaGVhbHRoIiwgQ09ORklHLkhFQUxUSF9USU1FT1VUX01TKTsKICAgIGxpdmVC",
  "YWNrZW5kQXZhaWxhYmxlID0gISEociAmJiByLm9rKTsKICB9Y2F0Y2goZSl7CiAgICBsaXZlQmFja2VuZEF2YWlsYWJsZSA9IGZhbHNlOwogIH0KICB1cGRhdGVCYWNrZW5kQmFkZ2UoKTsKICByZXR1cm4gbGl2ZUJhY2tlbmRBdmFpbGFibGU7Cn0KCmZ1bmN0aW9u",
  "IHVwZGF0ZUJhY2tlbmRCYWRnZSgpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImJhY2tlbmRCYWRnZSIpOwogIGlmKCFlbCkgcmV0dXJuOwogIGVsLmNsYXNzTGlzdC50b2dnbGUoImxpdmUiLCBsaXZlQmFja2VuZEF2YWlsYWJsZSk7CiAg",
  "ZWwucXVlcnlTZWxlY3RvcigiLmRvdC1saXZlIikuc3R5bGUuYmFja2dyb3VuZCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gInZhcigtLXBvcykiIDogInZhcigtLXRleHQtZmFpbnQpIjsKICBlbC5xdWVyeVNlbGVjdG9yKCJzcGFuOmxhc3QtY2hpbGQiKS50ZXh0",
  "Q29udGVudCA9IGxpdmVCYWNrZW5kQXZhaWxhYmxlID8gIkxpdmUgTlNFIERhdGEiIDogIkRlbW8gRGF0YSI7CiAgZWwudGl0bGUgPSBsaXZlQmFja2VuZEF2YWlsYWJsZQogICAgPyAiQ29ubmVjdGVkIHRvIHRoZSBFcXVpdHlTY2FuIGJhY2tlbmQg4oCUIHByaWNl",
  "cyBhcmUgcmVhbCBOU0UgcXVvdGVzLiIKICAgIDogIkJhY2tlbmQgbm90IHJlYWNoYWJsZSBhdCAiICsgQ09ORklHLkFQSV9CQVNFICsgIiDigJQgc2hvd2luZyBkZXRlcm1pbmlzdGljIGRlbW8gZGF0YS4iOwp9CgpmdW5jdGlvbiBtYXBCYWNrZW5kVG9Gcm9udGVu",
  "ZChkKXsKICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkLnN5bWJvbCk7CiAgY29uc3QgYmFzaXMgPSBkLmN1cnJlbnRQcmljZSB8fCAxMDAwOwogIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkLCAyMCwgMC4wMDUsIGJhc2lzKTsKICBjb25zdCBrbm93bkRl",
  "ZiA9IFVOSVZFUlNFLmZpbmQodT0+dS50PT09ZC5zeW1ib2wpOwogIHJldHVybiB7CiAgICB0OiBkLnN5bWJvbCwKICAgIG5hbWU6IGQuY29tcGFueU5hbWUgfHwgKGtub3duRGVmICYmIGtub3duRGVmLm5hbWUpIHx8IGQuc3ltYm9sLAogICAgZXhjaDogZC5leGNo",
  "YW5nZSB8fCAiTlNFIiwKICAgIC8vIFRoZSBsaXZlIGJhY2tlbmQncyBpbmR1c3RyeSBsYWJlbCBkb2Vzbid0IHJlbGlhYmx5IG1hdGNoIG91ciBmaWx0ZXIKICAgIC8vIGRyb3Bkb3duJ3Mgdm9jYWJ1bGFyeSAob3IgbWF5IGJlIG1pc3NpbmcpLCBzbyBwcmVmZXIg",
  "b3VyIGtub3duIG1hcHBpbmcKICAgIC8vIGZvciBmaWx0ZXJpbmcgcHVycG9zZXMgYW5kIG9ubHkgZmFsbCBiYWNrIHRvIHRoZSBiYWNrZW5kJ3MgcmF3IHZhbHVlLgogICAgc2VjdG9yOiAoa25vd25EZWYgJiYga25vd25EZWYuc2VjdG9yKSB8fCBkLnNlY3RvciB8",
  "fCAi4oCUIiwKICAgIHByaWNlOiBkLmN1cnJlbnRQcmljZSwKICAgIGNoYW5nZTogZC5jaGFuZ2UsCiAgICBwY3Q6IGQucGVyY2VudENoYW5nZSwKICAgIG1hcmtldENhcDogZC5tYXJrZXRDYXAsCiAgICB2b2x1bWU6IGQudm9sdW1lLAogICAgaGlnaDUyOiBkLndl",
  "ZWs1MkhpZ2gsCiAgICBsb3c1MjogZC53ZWVrNTJMb3csCiAgICBvcGVuOiBkLm9wZW4sCiAgICBkYXlIaWdoOiBkLmRheUhpZ2gsCiAgICBkYXlMb3c6IGQuZGF5TG93LAogICAgc2VyaWVzLAogICAgbGl2ZTogdHJ1ZSwKICAgIGRhdGFTdGF0dXM6IGQuZGF0YVN0",
  "YXR1cywKICB9Owp9Cgphc3luYyBmdW5jdGlvbiBsaXZlRmV0Y2hTdG9jayh0aWNrZXIpewogIGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KGAke0NPTkZJRy5BUElfQkFTRX0vc3RvY2svJHtlbmNvZGVVUklDb21wb25lbnQodGlja2VyKX1gLCBDT05G",
  "SUcuTElWRV9USU1FT1VUX01TKTsKICBpZighci5vaykgdGhyb3cgbmV3IEVycm9yKCJiYWNrZW5kIHN0YXR1cyAiK3Iuc3RhdHVzKTsKICBjb25zdCBqc29uID0gYXdhaXQgci5qc29uKCk7CiAgaWYoIWpzb24uc3VjY2VzcyB8fCAhanNvbi5kYXRhKSB0aHJvdyBu",
  "ZXcgRXJyb3IoImJhY2tlbmQgcGF5bG9hZCBlcnJvciIpOwogIHJldHVybiBtYXBCYWNrZW5kVG9Gcm9udGVuZChqc29uLmRhdGEpOwp9Cgphc3luYyBmdW5jdGlvbiBsaXZlRmV0Y2hNYW55KHRpY2tlcnMpewogIGNvbnN0IHNldHRsZWQgPSBhd2FpdCBQcm9taXNl",
  "LmFsbFNldHRsZWQodGlja2Vycy5tYXAobGl2ZUZldGNoU3RvY2spKTsKICByZXR1cm4gc2V0dGxlZC5maWx0ZXIocz0+cy5zdGF0dXM9PT0iZnVsZmlsbGVkIikubWFwKHM9PnMudmFsdWUpOwp9Cgpjb25zdCBVTklWRVJTRSA9IFsKICB7dDoiVENTIiwgbmFtZToi",
  "VGF0YSBDb25zdWx0YW5jeSBTZXJ2aWNlcyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSVQgU2VydmljZXMiLCBiYXNlOjM4NDJ9LAogIHt0OiJSRUxJQU5DRSIsIG5hbWU6IlJlbGlhbmNlIEluZHVzdHJpZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkVuZXJneSIsIGJh",
  "c2U6Mjk1MX0sCiAge3Q6IkhERkNCQU5LIiwgbmFtZToiSERGQyBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxNjg3fSwKICB7dDoiSU5GWSIsIG5hbWU6IkluZm9zeXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IklUIFNlcnZpY2VzIiwg",
  "YmFzZToxODQxfSwKICB7dDoiSUNJQ0lCQU5LIiwgbmFtZToiSUNJQ0kgQmFuayIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQmFua2luZyIsIGJhc2U6MTI2NH0sCiAge3Q6IkJIQVJUSUFSVEwiLCBuYW1lOiJCaGFydGkgQWlydGVsIiwgZXhjaDoiTlNFIiwgc2VjdG9y",
  "OiJUZWxlY29tIiwgYmFzZToxNjk4fSwKICB7dDoiU0JJTiIsIG5hbWU6IlN0YXRlIEJhbmsgb2YgSW5kaWEiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkJhbmtpbmciLCBiYXNlOjgyNH0sCiAge3Q6IklUQyIsIG5hbWU6IklUQyBMaW1pdGVkIiwgZXhjaDoiTlNFIiwg",
  "c2VjdG9yOiJGTUNHIiwgYmFzZTo0Nzh9LAogIHt0OiJMVCIsIG5hbWU6IkxhcnNlbiAmIFRvdWJybyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiSW5mcmFzdHJ1Y3R1cmUiLCBiYXNlOjM2MTJ9LAogIHt0OiJLT1RBS0JBTksiLCBuYW1lOiJLb3RhayBNYWhpbmRyYSBC",
  "YW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxNzg5fSwKICB7dDoiSElORFVOSUxWUiIsIG5hbWU6IkhpbmR1c3RhbiBVbmlsZXZlciIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiRk1DRyIsIGJhc2U6MjU0N30sCiAge3Q6IkFYSVNCQU5LIiwg",
  "bmFtZToiQXhpcyBCYW5rIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJCYW5raW5nIiwgYmFzZToxMTQyfSwKICB7dDoiQkFKRklOQU5DRSIsIG5hbWU6IkJhamFqIEZpbmFuY2UiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZpbmFuY2lhbCBTZXJ2aWNlcyIsIGJhc2U6NzI4",
  "NH0sCiAge3Q6Ik1BUlVUSSIsIG5hbWU6Ik1hcnV0aSBTdXp1a2kiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkF1dG9tb2JpbGUiLCBiYXNlOjEyNDgwfSwKICB7dDoiQVNJQU5QQUlOVCIsIG5hbWU6IkFzaWFuIFBhaW50cyIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiQ29u",
  "c3VtZXIgR29vZHMiLCBiYXNlOjI4OTR9LAogIHt0OiJXSVBSTyIsIG5hbWU6IldpcHJvIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJJVCBTZXJ2aWNlcyIsIGJhc2U6NTEyfSwKICB7dDoiVElUQU4iLCBuYW1lOiJUaXRhbiBDb21wYW55IiwgZXhjaDoiTlNFIiwgc2Vj",
  "dG9yOiJDb25zdW1lciBHb29kcyIsIGJhc2U6MzQyMX0sCiAge3Q6IlNVTlBIQVJNQSIsIG5hbWU6IlN1biBQaGFybWFjZXV0aWNhbCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUGhhcm1hIiwgYmFzZToxNzg2fSwKICB7dDoiTlRQQyIsIG5hbWU6Ik5UUEMgTGltaXRl",
  "ZCIsIGV4Y2g6Ik5TRSIsIHNlY3RvcjoiUG93ZXIiLCBiYXNlOjM2Mn0sCiAge3Q6IkFEQU5JRU5UIiwgbmFtZToiQWRhbmkgRW50ZXJwcmlzZXMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkRpdmVyc2lmaWVkIiwgYmFzZToyOTE0fSwKICB7dDoiVUxUUkFDRU1DTyIs",
  "IG5hbWU6IlVsdHJhVGVjaCBDZW1lbnQiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkNlbWVudCIsIGJhc2U6MTEyNDB9LAogIHt0OiJQT1dFUkdSSUQiLCBuYW1lOiJQb3dlciBHcmlkIENvcnAiLCBleGNoOiJOU0UiLCBzZWN0b3I6IlBvd2VyIiwgYmFzZTozMTh9LAog",
  "IHt0OiJORVNUTEVJTkQiLCBuYW1lOiJOZXN0bGUgSW5kaWEiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkZNQ0ciLCBiYXNlOjIyNzh9LAogIHt0OiJUQVRBTU9UT1JTIiwgbmFtZToiVGF0YSBNb3RvcnMiLCBleGNoOiJOU0UiLCBzZWN0b3I6IkF1dG9tb2JpbGUiLCBi",
  "YXNlOjk0OH0sCiAge3Q6IkpTV1NURUVMIiwgbmFtZToiSlNXIFN0ZWVsIiwgZXhjaDoiTlNFIiwgc2VjdG9yOiJNZXRhbHMiLCBiYXNlOjEwMTJ9LApdOwoKZnVuY3Rpb24gc2VlZGVkUmFuZChzZWVkKXsKICBsZXQgeCA9IE1hdGguc2luKHNlZWQpICogMTAwMDA7",
  "CiAgcmV0dXJuIHggLSBNYXRoLmZsb29yKHgpOwp9CmZ1bmN0aW9uIGRheU9mWWVhcigpewogIGNvbnN0IG5vdyA9IG5ldyBEYXRlKCk7CiAgcmV0dXJuIE1hdGguZmxvb3IoKG5vdyAtIG5ldyBEYXRlKG5vdy5nZXRGdWxsWWVhcigpLDAsMCkpIC8gODY0MDAwMDAp",
  "Owp9CmZ1bmN0aW9uIGdlblNlcmllcyhzZWVkLCBwb2ludHMsIHZvbGF0aWxpdHksIGJhc2UpewogIGNvbnN0IGFyciA9IFtdOwogIGxldCB2ID0gYmFzZTsKICBmb3IobGV0IGk9MDtpPHBvaW50cztpKyspewogICAgY29uc3QgciA9IHNlZWRlZFJhbmQoc2VlZCAq",
  "IDk3LjcgKyBpICogMTMuMzEpIC0gMC41OwogICAgdiA9IHYgKiAoMSArIHIgKiB2b2xhdGlsaXR5KTsKICAgIGFyci5wdXNoKHYpOwogIH0KICByZXR1cm4gYXJyOwp9CmZ1bmN0aW9uIHRpY2tlclNlZWQodGlja2VyKXsKICBsZXQgaCA9IDA7CiAgZm9yKGxldCBp",
  "PTA7aTx0aWNrZXIubGVuZ3RoO2krKykgaCA9IChoKjMxICsgdGlja2VyLmNoYXJDb2RlQXQoaSkpICUgMTAwMDAwOwogIHJldHVybiBoICsgZGF5T2ZZZWFyKCk7Cn0KCmZ1bmN0aW9uIHdpdGhMYXRlbmN5KHZhbHVlKXsKICByZXR1cm4gbmV3IFByb21pc2UocmVz",
  "ID0+IHNldFRpbWVvdXQoKCkgPT4gcmVzKHZhbHVlKSwgTU9DS19MQVRFTkNZKSk7Cn0KCmNvbnN0IEFQSSA9IHsKICBhc3luYyBmZXRjaEluZGljZXMoKXsKICAgIGNvbnN0IGRlZnMgPSBbCiAgICAgIHtjb2RlOiJOSUZUWSA1MCIsIGZ1bGw6Ik5TRSBOaWZ0eSA1",
  "MCBJbmRleCIsIGJhc2U6MjQ4MTJ9LAogICAgICB7Y29kZToiU0VOU0VYIiwgZnVsbDoiQlNFIFNlbnNleCIsIGJhc2U6ODE2NDB9LAogICAgICB7Y29kZToiTklGVFkgQkFOSyIsIGZ1bGw6Ik5TRSBCYW5rIE5pZnR5IEluZGV4IiwgYmFzZTo1MjE0MH0sCiAgICBd",
  "OwogICAgY29uc3Qgb3V0ID0gZGVmcy5tYXAoZD0+ewogICAgICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChkLmNvZGUpOwogICAgICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjQsIDAuMDA2LCBkLmJhc2UpOwogICAgICBjb25zdCBsYXN0ID0gc2Vy",
  "aWVzW3Nlcmllcy5sZW5ndGgtMV07CiAgICAgIGNvbnN0IHByZXYgPSBkLmJhc2U7CiAgICAgIGNvbnN0IGNoZyA9IGxhc3QgLSBwcmV2OwogICAgICBjb25zdCBwY3QgPSAoY2hnL3ByZXYpKjEwMDsKICAgICAgcmV0dXJuIHsuLi5kLCB2YWx1ZTpsYXN0LCBjaGFu",
  "Z2U6Y2hnLCBwY3QsIHNlcmllc307CiAgICB9KTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShvdXQpOwogIH0sCgogIGFzeW5jIHNlYXJjaFN0b2NrcyhxdWVyeSl7CiAgICBjb25zdCBxID0gcXVlcnkudHJpbSgpLnRvTG93ZXJDYXNlKCk7CiAgICBpZighcSkgcmV0",
  "dXJuIHdpdGhMYXRlbmN5KFtdKTsKICAgIGNvbnN0IG1hdGNoZXMgPSBVTklWRVJTRS5maWx0ZXIocyA9PiBzLnQudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSB8fCBzLm5hbWUudG9Mb3dlckNhc2UoKS5pbmNsdWRlcyhxKSkuc2xpY2UoMCw4KTsKICAgIGlmKGxp",
  "dmVCYWNrZW5kQXZhaWxhYmxlKXsKICAgICAgY29uc3QgbGl2ZSA9IGF3YWl0IGxpdmVGZXRjaE1hbnkobWF0Y2hlcy5tYXAobT0+bS50KSk7CiAgICAgIGlmKGxpdmUubGVuZ3RoKSByZXR1cm4gbGl2ZTsKICAgIH0KICAgIHJldHVybiB3aXRoTGF0ZW5jeShtYXRj",
  "aGVzLm1hcChzID0+IGRlY29yYXRlU3RvY2socykpKTsKICB9LAoKICBhc3luYyBmZXRjaFNjcmVlbmVyUmVzdWx0cyhmaWx0ZXJzKXsKICAgIGxldCBsaXN0OwogICAgaWYobGl2ZUJhY2tlbmRBdmFpbGFibGUpewogICAgICBjb25zdCBsaXZlID0gYXdhaXQgbGl2",
  "ZUZldGNoTWFueShVTklWRVJTRS5tYXAocz0+cy50KSk7CiAgICAgIGxpc3QgPSBsaXZlLmxlbmd0aCA/IGxpdmUgOiBVTklWRVJTRS5tYXAocz0+ZGVjb3JhdGVTdG9jayhzKSk7CiAgICB9IGVsc2UgewogICAgICBsaXN0ID0gVU5JVkVSU0UubWFwKGRlY29yYXRl",
  "U3RvY2spOwogICAgICBhd2FpdCB3aXRoTGF0ZW5jeShudWxsKTsKICAgIH0KICAgIGlmKGZpbHRlcnMucXVlcnkpewogICAgICBjb25zdCBxID0gZmlsdGVycy5xdWVyeS50b0xvd2VyQ2FzZSgpOwogICAgICBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy50LnRvTG93",
  "ZXJDYXNlKCkuaW5jbHVkZXMocSl8fHMubmFtZS50b0xvd2VyQ2FzZSgpLmluY2x1ZGVzKHEpKTsKICAgIH0KICAgIGlmKGZpbHRlcnMuc2VjdG9yICYmIGZpbHRlcnMuc2VjdG9yICE9PSAiQWxsIikgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMuc2VjdG9yPT09Zmls",
  "dGVycy5zZWN0b3IpOwogICAgaWYoZmlsdGVycy5taW5QcmljZSkgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucHJpY2U+PWZpbHRlcnMubWluUHJpY2UpOwogICAgaWYoZmlsdGVycy5tYXhQcmljZSkgbGlzdCA9IGxpc3QuZmlsdGVyKHM9PnMucHJpY2U8PWZpbHRl",
  "cnMubWF4UHJpY2UpOwogICAgaWYoZmlsdGVycy5kaXJlY3Rpb249PT0iZ2FpbmVycyIpIGxpc3QgPSBsaXN0LmZpbHRlcihzPT5zLnBjdD49MCk7CiAgICBpZihmaWx0ZXJzLmRpcmVjdGlvbj09PSJsb3NlcnMiKSBsaXN0ID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q8",
  "MCk7CiAgICByZXR1cm4gbGlzdDsKICB9LAoKICBhc3luYyBmZXRjaFN0b2NrKHRpY2tlcil7CiAgICBpZihsaXZlQmFja2VuZEF2YWlsYWJsZSl7CiAgICAgIHRyeXsgcmV0dXJuIGF3YWl0IGxpdmVGZXRjaFN0b2NrKHRpY2tlcik7IH0KICAgICAgY2F0Y2goZSl7",
  "IC8qIGZhbGwgdGhyb3VnaCB0byBtb2NrICovIH0KICAgIH0KICAgIGNvbnN0IGRlZiA9IFVOSVZFUlNFLmZpbmQocz0+cy50PT09dGlja2VyKTsKICAgIGlmKCFkZWYpIHJldHVybiB3aXRoTGF0ZW5jeShudWxsKTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShkZWNv",
  "cmF0ZVN0b2NrKGRlZiwgdHJ1ZSkpOwogIH0sCgogIGFzeW5jIGZldGNoU3RvY2tIaXN0b3J5KHRpY2tlciwgcmFuZ2UpewogICAgY29uc3Qgc2VlZCA9IHRpY2tlclNlZWQodGlja2VyKTsKICAgIGNvbnN0IGNmZyA9IHsKICAgICAgIjFEIjp7cG9pbnRzOjc4LCB2",
  "b2w6MC4wMDE2fSwKICAgICAgIjFXIjp7cG9pbnRzOjM1LCB2b2w6MC4wMDN9LAogICAgICAiMU0iOntwb2ludHM6MjIsIHZvbDowLjAwOH0sCiAgICAgICIzTSI6e3BvaW50czo2NSwgdm9sOjAuMDA5fSwKICAgICAgIjZNIjp7cG9pbnRzOjEzMCwgdm9sOjAuMDEw",
  "fSwKICAgICAgIjFZIjp7cG9pbnRzOjI1MCwgdm9sOjAuMDEyfSwKICAgIH1bcmFuZ2VdIHx8IHtwb2ludHM6NjAsIHZvbDowLjAwOH07CiAgICBjb25zdCBkZWYgPSBVTklWRVJTRS5maW5kKHM9PnMudD09PXRpY2tlcik7CiAgICBjb25zdCBiYXNlID0gZGVmID8g",
  "ZGVmLmJhc2UgKiAwLjk0IDogMTAwMDsKICAgIGNvbnN0IHNlcmllcyA9IGdlblNlcmllcyhzZWVkICsgcmFuZ2UubGVuZ3RoLCBjZmcucG9pbnRzLCBjZmcudm9sLCBiYXNlKTsKICAgIHJldHVybiB3aXRoTGF0ZW5jeShzZXJpZXMpOwogIH0sCn07CgpmdW5jdGlv",
  "biBkZWNvcmF0ZVN0b2NrKGRlZiwgZGV0YWlsZWQpewogIGNvbnN0IHNlZWQgPSB0aWNrZXJTZWVkKGRlZi50KTsKICBjb25zdCBzZXJpZXMgPSBnZW5TZXJpZXMoc2VlZCwgMjAsIDAuMDA1LCBkZWYuYmFzZSk7CiAgY29uc3QgcHJpY2UgPSBzZXJpZXNbc2VyaWVz",
  "Lmxlbmd0aC0xXTsKICBjb25zdCBwcmV2Q2xvc2UgPSBkZWYuYmFzZTsKICBjb25zdCBjaGFuZ2UgPSBwcmljZSAtIHByZXZDbG9zZTsKICBjb25zdCBwY3QgPSAoY2hhbmdlL3ByZXZDbG9zZSkqMTAwOwogIGNvbnN0IG1hcmtldENhcCA9IHByaWNlICogKHNlZWRl",
  "ZFJhbmQoc2VlZCoyLjEpKjQwMDArODAwKSAqIDFlNjsKICBjb25zdCB2b2x1bWUgPSBNYXRoLnJvdW5kKHNlZWRlZFJhbmQoc2VlZCozLjMpKjhfMDAwXzAwMCArIDIwMF8wMDApOwogIGNvbnN0IGhpZ2g1MiA9IHByaWNlICogKDEgKyBzZWVkZWRSYW5kKHNlZWQq",
  "NC40KSowLjM1ICsgMC4wNSk7CiAgY29uc3QgbG93NTIgPSBwcmljZSAqICgxIC0gc2VlZGVkUmFuZChzZWVkKjUuNSkqMC4zMCAtIDAuMDQpOwogIGNvbnN0IG91dCA9IHsKICAgIHQ6ZGVmLnQsIG5hbWU6ZGVmLm5hbWUsIGV4Y2g6ZGVmLmV4Y2gsIHNlY3Rvcjpk",
  "ZWYuc2VjdG9yLAogICAgcHJpY2UsIGNoYW5nZSwgcGN0LCBtYXJrZXRDYXAsIHZvbHVtZSwgaGlnaDUyLCBsb3c1Miwgc2VyaWVzLAogIH07CiAgaWYoZGV0YWlsZWQpewogICAgb3V0Lm9wZW4gPSBwcmljZSAtIGNoYW5nZSowLjY7CiAgICBvdXQuZGF5SGlnaCA9",
  "IE1hdGgubWF4KHByaWNlLCBvdXQub3BlbikgKiAoMStzZWVkZWRSYW5kKHNlZWQqNi42KSowLjAxMik7CiAgICBvdXQuZGF5TG93ID0gTWF0aC5taW4ocHJpY2UsIG91dC5vcGVuKSAqICgxLXNlZWRlZFJhbmQoc2VlZCo3LjcpKjAuMDEyKTsKICB9CiAgcmV0dXJu",
  "IG91dDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBGT1JNQVQgSEVMUEVSUwogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09ICovCmZ1bmN0aW9uIGZtdElOUih2LCBkZWNpbWFscyl7CiAgaWYodj09PXVuZGVmaW5lZHx8dj09PW51bGx8fGlzTmFOKHYpKSByZXR1cm4gIuKAlCI7CiAgY29uc3QgZCA9IGRlY2ltYWxzPT09dW5kZWZpbmVkPzI6ZGVjaW1hbHM7CiAgcmV0",
  "dXJuICLigrkiICsgdi50b0xvY2FsZVN0cmluZygiZW4tSU4iLCB7bWluaW11bUZyYWN0aW9uRGlnaXRzOmQsIG1heGltdW1GcmFjdGlvbkRpZ2l0czpkfSk7Cn0KZnVuY3Rpb24gZm10Q29tcGFjdCh2KXsKICBpZih2PT09dW5kZWZpbmVkfHx2PT09bnVsbHx8aXNO",
  "YU4odikpIHJldHVybiAi4oCUIjsKICBpZih2Pj0xZTEyKSByZXR1cm4gIuKCuSIrKHYvMWUxMikudG9GaXhlZCgyKSsiVCI7CiAgaWYodj49MWU5KSByZXR1cm4gIuKCuSIrKHYvMWU5KS50b0ZpeGVkKDIpKyJCIjsKICBpZih2Pj0xZTcpIHJldHVybiAi4oK5Iiso",
  "di8xZTcpLnRvRml4ZWQoMikrIkNyIjsKICBpZih2Pj0xZTUpIHJldHVybiAi4oK5Iisodi8xZTUpLnRvRml4ZWQoMikrIkwiOwogIHJldHVybiAi4oK5Iit2LnRvRml4ZWQoMCk7Cn0KZnVuY3Rpb24gZm10Vm9sKHYpewogIGlmKHY+PTFlNykgcmV0dXJuICh2LzFl",
  "NykudG9GaXhlZCgyKSsiQ3IiOwogIGlmKHY+PTFlNSkgcmV0dXJuICh2LzFlNSkudG9GaXhlZCgyKSsiTCI7CiAgaWYodj49MWUzKSByZXR1cm4gKHYvMWUzKS50b0ZpeGVkKDEpKyJLIjsKICByZXR1cm4gU3RyaW5nKHYpOwp9CmZ1bmN0aW9uIHBjdFN0cihwKXsg",
  "cmV0dXJuIChwPj0wPyIrIjoiIikgKyBwLnRvRml4ZWQoMikgKyAiJSI7IH0KZnVuY3Rpb24gY2hnU3RyKGMpeyByZXR1cm4gKGM+PTA/IisiOiIiKSArIGZtdElOUihNYXRoLmFicyhjKSk7IH0KZnVuY3Rpb24gZXNjYXBlSHRtbChzKXsKICByZXR1cm4gU3RyaW5n",
  "KHMpLnJlcGxhY2UoL1smPD4iJ10vZywgbSA9PiAoeyImIjoiJmFtcDsiLCI8IjoiJmx0OyIsIj4iOiImZ3Q7IiwnIic6IiZxdW90OyIsIiciOiImIzM5OyJ9W21dKSk7Cn0KCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT0KICAgU1RBVEUKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PSAqLwpjb25zdCBzdGF0ZSA9IHsKICB2aWV3OiAiZGFzaGJvYXJkIiwKICB3YXRjaGxpc3Q6IFtd",
  "LAogIGRldGFpbFRpY2tlcjogIlRDUyIsCiAgZGV0YWlsUmFuZ2U6ICIxTSIsCiAgc2NyZWVuZXJGaWx0ZXJzOiB7cXVlcnk6IiIsIHNlY3RvcjoiQWxsIiwgbWluUHJpY2U6MCwgbWF4UHJpY2U6MTUwMDAsIGRpcmVjdGlvbjoiYWxsIn0sCiAgc2NyZWVuZXJTb3J0",
  "OiB7a2V5OiJtYXJrZXRDYXAiLCBkaXI6ImRlc2MifSwKfTsKCnRyeXsKICBjb25zdCBzYXZlZCA9IGxvY2FsU3RvcmFnZS5nZXRJdGVtKCJlcXVpdHlzY2FuX3dhdGNobGlzdCIpOwogIGlmKHNhdmVkKSBzdGF0ZS53YXRjaGxpc3QgPSBKU09OLnBhcnNlKHNhdmVk",
  "KTsKfWNhdGNoKGUpe30KZnVuY3Rpb24gcGVyc2lzdFdhdGNobGlzdCgpewogIHRyeXsgbG9jYWxTdG9yYWdlLnNldEl0ZW0oImVxdWl0eXNjYW5fd2F0Y2hsaXN0IiwgSlNPTi5zdHJpbmdpZnkoc3RhdGUud2F0Y2hsaXN0KSk7IH1jYXRjaChlKXt9Cn0KCi8qID09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgU1BBUktMSU5FIChpbmxpbmUgU1ZHKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09ICovCi8qID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgTlVNQkVSIENPVU5ULVVQIOKAlCB0aWNrcyBhIG51bWJlciBmcm9tIDAgKG9yIGEgZ2l2ZW4gc3RhcnQpIHVwIHRvIGl0",
  "cwogICByZWFsIHZhbHVlIHdpdGggYW4gZWFzZS1vdXQgY3VydmUuIFJlc3BlY3RzIHByZWZlcnMtcmVkdWNlZC1tb3Rpb24uCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3Qg",
  "cHJlZmVyc1JlZHVjZWRNb3Rpb24gPSB3aW5kb3cubWF0Y2hNZWRpYSgnKHByZWZlcnMtcmVkdWNlZC1tb3Rpb246IHJlZHVjZSknKS5tYXRjaGVzOwpmdW5jdGlvbiBhbmltYXRlTnVtYmVyKGVsLCB0b1ZhbHVlLCBvcHRzKXsKICBvcHRzID0gb3B0cyB8fCB7fTsK",
  "ICBpZighZWwgfHwgdHlwZW9mIHRvVmFsdWUgIT09ICJudW1iZXIiIHx8ICFpc0Zpbml0ZSh0b1ZhbHVlKSkgcmV0dXJuOwogIGNvbnN0IGRlY2ltYWxzID0gb3B0cy5kZWNpbWFscyAhPT0gdW5kZWZpbmVkID8gb3B0cy5kZWNpbWFscyA6IDI7CiAgY29uc3QgZm9y",
  "bWF0ID0gb3B0cy5mb3JtYXQgfHwgKCh2KT0+IHYudG9Mb2NhbGVTdHJpbmcoImVuLUlOIiwge21pbmltdW1GcmFjdGlvbkRpZ2l0czpkZWNpbWFscywgbWF4aW11bUZyYWN0aW9uRGlnaXRzOmRlY2ltYWxzfSkpOwogIGlmKHByZWZlcnNSZWR1Y2VkTW90aW9uKXsg",
  "ZWwudGV4dENvbnRlbnQgPSBmb3JtYXQodG9WYWx1ZSk7IHJldHVybjsgfQogIGNvbnN0IGZyb21WYWx1ZSA9IG9wdHMuZnJvbSAhPT0gdW5kZWZpbmVkID8gb3B0cy5mcm9tIDogMDsKICBjb25zdCBkdXJhdGlvbiA9IG9wdHMuZHVyYXRpb24gfHwgOTAwOwogIGNv",
  "bnN0IHN0YXJ0ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgZnVuY3Rpb24gdGljayhub3cpewogICAgY29uc3QgdCA9IE1hdGgubWluKDEsIChub3ctc3RhcnQpL2R1cmF0aW9uKTsKICAgIGNvbnN0IGVhc2VkID0gMSAtIE1hdGgucG93KDEtdCwgMyk7CiAgICBlbC50",
  "ZXh0Q29udGVudCA9IGZvcm1hdChmcm9tVmFsdWUgKyAodG9WYWx1ZS1mcm9tVmFsdWUpKmVhc2VkKTsKICAgIGlmKHQ8MSkgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHRpY2spOwogICAgZWxzZSBlbC50ZXh0Q29udGVudCA9IGZvcm1hdCh0b1ZhbHVlKTsKICB9CiAg",
  "cmVxdWVzdEFuaW1hdGlvbkZyYW1lKHRpY2spOwp9Ci8vIFNjYW5zIGEgY29udGFpbmVyIGZvciBlbGVtZW50cyBtYXJrZWQgZGF0YS1jb3VudHVwPSI8dmFsdWU+IiBhbmQgYW5pbWF0ZXMKLy8gZWFjaCBmcm9tIDAgdXAgdG8gdGhhdCB2YWx1ZS4gVXNlZCBhbnl3",
  "aGVyZSBtYXJrdXAgaXMgZ2VuZXJhdGVkIGFzIGEKLy8gdGVtcGxhdGUgc3RyaW5nIChzbyB0aGUgdGFyZ2V0IHRleHQgY2FuJ3QgYmUgc2V0IHVudGlsIGFmdGVyIGluc2VydGlvbikuCmZ1bmN0aW9uIHJ1bkNvdW50VXBzKGNvbnRhaW5lcil7CiAgaWYoIWNvbnRh",
  "aW5lcikgcmV0dXJuOwogIGNvbnRhaW5lci5xdWVyeVNlbGVjdG9yQWxsKCJbZGF0YS1jb3VudHVwXSIpLmZvckVhY2goZWw9PnsKICAgIGNvbnN0IHRhcmdldCA9IE51bWJlcihlbC5kYXRhc2V0LmNvdW50dXApOwogICAgY29uc3QgZGVjaW1hbHMgPSBlbC5kYXRh",
  "c2V0LmRlY2ltYWxzICE9PSB1bmRlZmluZWQgPyBOdW1iZXIoZWwuZGF0YXNldC5kZWNpbWFscykgOiAyOwogICAgYW5pbWF0ZU51bWJlcihlbCwgdGFyZ2V0LCB7ZGVjaW1hbHN9KTsKICB9KTsKfQoKZnVuY3Rpb24gc3BhcmtsaW5lU1ZHKHNlcmllcywgcG9zaXRp",
  "dmUsIHcsIGgpewogIHcgPSB3fHwxMjA7IGggPSBofHwzNjsKICBpZighc2VyaWVzIHx8IHNlcmllcy5sZW5ndGg8MikgcmV0dXJuICIiOwogIGNvbnN0IG1pbiA9IE1hdGgubWluKC4uLnNlcmllcyksIG1heCA9IE1hdGgubWF4KC4uLnNlcmllcyk7CiAgY29uc3Qg",
  "cmFuZ2UgPSAobWF4LW1pbil8fDE7CiAgY29uc3Qgc3RlcCA9IHcvKHNlcmllcy5sZW5ndGgtMSk7CiAgY29uc3QgcHRzID0gc2VyaWVzLm1hcCgodixpKT0+W2kqc3RlcCwgaCAtICgodi1taW4pL3JhbmdlKSpoKjAuODYgLSBoKjAuMDddKTsKICBjb25zdCBwYXRo",
  "ID0gcHRzLm1hcCgocCxpKT0+KGk9PT0wPyJNIjoiTCIpK3BbMF0udG9GaXhlZCgxKSsiLCIrcFsxXS50b0ZpeGVkKDEpKS5qb2luKCIgIik7CiAgY29uc3QgYXJlYVBhdGggPSBwYXRoICsgYCBMJHt3fSwke2h9IEwwLCR7aH0gWmA7CiAgY29uc3QgY29sb3IgPSBw",
  "b3NpdGl2ZSA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS1uZWcpIjsKICBjb25zdCBnaWQgPSAic2ciK01hdGgucmFuZG9tKCkudG9TdHJpbmcoMzYpLnNsaWNlKDIsOSk7CiAgcmV0dXJuIGA8c3ZnIHZpZXdCb3g9IjAgMCAke3d9ICR7aH0iIHdpZHRoPSIxMDAlIiBo",
  "ZWlnaHQ9IjEwMCUiIHByZXNlcnZlQXNwZWN0UmF0aW89Im5vbmUiPgogICAgPGRlZnM+PGxpbmVhckdyYWRpZW50IGlkPSIke2dpZH0iIHgxPSIwIiB5MT0iMCIgeDI9IjAiIHkyPSIxIj4KICAgICAgPHN0b3Agb2Zmc2V0PSIwJSIgc3RvcC1jb2xvcj0iJHtjb2xv",
  "cn0iIHN0b3Atb3BhY2l0eT0iMC4zNSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEwMCUiIHN0b3AtY29sb3I9IiR7Y29sb3J9IiBzdG9wLW9wYWNpdHk9IjAiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+PC9kZWZzPgogICAgPHBhdGggZD0iJHthcmVhUGF0aH0iIGZp",
  "bGw9InVybCgjJHtnaWR9KSIgc3Ryb2tlPSJub25lIi8+CiAgICA8cGF0aCBkPSIke3BhdGh9IiBmaWxsPSJub25lIiBzdHJva2U9IiR7Y29sb3J9IiBzdHJva2Utd2lkdGg9IjEuNiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIiBzdHJva2UtbGluZWpvaW49InJvdW5k",
  "Ii8+CiAgPC9zdmc+YDsKfQoKLyogPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PQogICBBTUJJRU5UIERFQ09SQVRJVkUgTElORVMgKGRyYXduIG9uY2UpCiAgID09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KKGZ1bmN0aW9uIGRyYXdBbWJpZW50TGluZXMoKXsKICBjb25zdCBzdmcgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYW1iaWVudExpbmVzIik7CiAgY29uc3QgdyA9IDE0MDAs",
  "IGggPSA4MDA7CiAgc3ZnLnNldEF0dHJpYnV0ZSgidmlld0JveCIsIGAwIDAgJHt3fSAke2h9YCk7CiAgbGV0IGh0bWwgPSAiIjsKICBmb3IobGV0IGk9MDtpPDM7aSsrKXsKICAgIGNvbnN0IHNlZWQgPSBpKjE3KzM7CiAgICBjb25zdCBwdHMgPSBbXTsKICAgIGNv",
  "bnN0IG4gPSAxMjsKICAgIGZvcihsZXQgaj0wO2o8PW47aisrKXsKICAgICAgY29uc3QgeCA9IChqL24pKnc7CiAgICAgIGNvbnN0IHkgPSBoKjAuMjUgKyBpKjEzMCArIChzZWVkZWRSYW5kKHNlZWQraiktMC41KSo5MDsKICAgICAgcHRzLnB1c2goW3gseV0pOwog",
  "ICAgfQogICAgY29uc3QgcGF0aCA9IHB0cy5tYXAoKHAsaWR4KT0+KGlkeD09PTA/Ik0iOiJMIikrcFswXS50b0ZpeGVkKDApKyIsIitwWzFdLnRvRml4ZWQoMCkpLmpvaW4oIiAiKTsKICAgIGNvbnN0IGNvbG9ycyA9IFsiIzRDN0RGRiIsIiM4QjZCRjAiLCIjMzFE",
  "NUVFIl07CiAgICBodG1sICs9IGA8cGF0aCBkPSIke3BhdGh9IiBmaWxsPSJub25lIiBzdHJva2U9IiR7Y29sb3JzW2klM119IiBzdHJva2Utd2lkdGg9IjEiIG9wYWNpdHk9IjAuMTAiLz5gOwogIH0KICBzdmcuaW5uZXJIVE1MID0gaHRtbDsKfSkoKTsKCi8qID09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0KICAgSEVBREVSIEJFSEFWSU9SCiAgID09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0g",
  "Ki8KY29uc3QgdG9wYmFyID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInRvcGJhciIpOwp3aW5kb3cuYWRkRXZlbnRMaXN0ZW5lcigic2Nyb2xsIiwgKCk9PnsKICB0b3BiYXIuY2xhc3NMaXN0LnRvZ2dsZSgic2Nyb2xsZWQiLCB3aW5kb3cuc2Nyb2xsWSA+IDgp",
  "Owp9KTsKCmZ1bmN0aW9uIHNldEFjdGl2ZU5hdih2aWV3KXsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIjbWFpbk5hdiBidXR0b24sICNib3R0b21OYXYgYnV0dG9uIikuZm9yRWFjaChiPT57CiAgICBiLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGIu",
  "ZGF0YXNldC52aWV3PT09dmlldyk7CiAgfSk7Cn0KZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoIm1haW5OYXYiKS5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIGU9PnsKICBjb25zdCBidG4gPSBlLnRhcmdldC5jbG9zZXN0KCJidXR0b25bZGF0YS12aWV3XSIpOwog",
  "IGlmKGJ0bikgbmF2aWdhdGUoYnRuLmRhdGFzZXQudmlldyk7Cn0pOwpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYm90dG9tTmF2IikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCBlPT57CiAgY29uc3QgYnRuID0gZS50YXJnZXQuY2xvc2VzdCgiYnV0dG9uW2Rh",
  "dGEtdmlld10iKTsKICBpZihidG4pIG5hdmlnYXRlKGJ0bi5kYXRhc2V0LnZpZXcpOwp9KTsKCmZ1bmN0aW9uIG5hdmlnYXRlKHZpZXcsIHRpY2tlcil7CiAgc3RhdGUudmlldyA9IHZpZXc7CiAgaWYodGlja2VyKSBzdGF0ZS5kZXRhaWxUaWNrZXIgPSB0aWNrZXI7",
  "CiAgc2V0QWN0aXZlTmF2KHZpZXcgPT09ICJkZXRhaWwiID8gIm1hcmtldHMiIDogdmlldyk7CiAgd2luZG93LnNjcm9sbFRvKHt0b3A6MCwgYmVoYXZpb3I6IHdpbmRvdy5tYXRjaE1lZGlhKCcocHJlZmVycy1yZWR1Y2VkLW1vdGlvbjogcmVkdWNlKScpLm1hdGNo",
  "ZXMgPyAiYXV0byIgOiAic21vb3RoIn0pOwogIHJlbmRlcigpOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIE1BUktFVCBTVEFUVVMgKElTVCBidXNpbmVzcyBob3VycywgcHVy",
  "ZWx5IHByZXNlbnRhdGlvbmFsKQogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCihmdW5jdGlvbiBtYXJrZXRTdGF0dXMoKXsKICBjb25zdCBub3cgPSBuZXcgRGF0ZSgpOwogIGNvbnN0",
  "IGlzdEhvdXIgPSAobm93LmdldFVUQ0hvdXJzKCkrNSklMjQgKyAobm93LmdldFVUQ01pbnV0ZXMoKSszMD49NjA/MTowKTsKICBjb25zdCBtaW5zID0gKG5vdy5nZXRVVENNaW51dGVzKCkrMzApJTYwOwogIGNvbnN0IHRvdGFsTWluID0gKChub3cuZ2V0VVRDSG91",
  "cnMoKSs1KSUyNCkqNjAgKyBtaW5zOwogIGNvbnN0IG9wZW4gPSB0b3RhbE1pbiA+PSA1NTUgJiYgdG90YWxNaW4gPD0gOTMwOyAvLyA5OjE1IC0gMTU6MzAgSVNUCiAgc2V0VGV4dCgibWFya2V0U3RhdHVzVGV4dCIsIG9wZW4gPyAiTWFya2V0IE9wZW4iIDogIk1h",
  "cmtldCBDbG9zZWQiKTsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yKCIuZG90LWxpdmUiKS5zdHlsZS5iYWNrZ3JvdW5kID0gb3BlbiA/ICJ2YXIoLS1wb3MpIiA6ICJ2YXIoLS10ZXh0LWZhaW50KSI7Cn0pKCk7CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIFJFTkRFUjogUk9PVAogICA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09ICovCmNvbnN0IHJvb3QgPSBkb2N1bWVudC5n",
  "ZXRFbGVtZW50QnlJZCgibWFpblJvb3QiKTsKCmZ1bmN0aW9uIHJlbmRlcigpewogIGlmKHN0YXRlLnZpZXcgPT09ICJkYXNoYm9hcmQiKSByZW5kZXJEYXNoYm9hcmQoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJzY3JlZW5lciIpIHJlbmRlclNjcmVlbmVy",
  "KCk7CiAgZWxzZSBpZihzdGF0ZS52aWV3ID09PSAibWFya2V0cyIpIHJlbmRlck1hcmtldHMoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJ3YXRjaGxpc3QiKSByZW5kZXJXYXRjaGxpc3QoKTsKICBlbHNlIGlmKHN0YXRlLnZpZXcgPT09ICJkZXRhaWwiKSBy",
  "ZW5kZXJEZXRhaWwoKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBEQVNIQk9BUkQgLS0tLS0tLS0tLS0tLS0tLSAqLwphc3luYyBmdW5jdGlvbiByZW5kZXJEYXNoYm9hcmQoKXsKICByb290LmlubmVySFRNTCA9IGAKICAgIDxkaXYgY2xhc3M9InZpZXciIGlkPSJk",
  "YXNoVmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPk1hcmtldCBPdmVydmlldzwvaDI+PHNwYW4gY2xhc3M9InN1YiI+UmVhbC10aW1lIGluZGV4IHNuYXBzaG90PC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJoZXJvLXJvdyIg",
  "aWQ9ImluZGljZXNSb3ciPgogICAgICAgICR7c2tlbGV0b25DYXJkcygzKX0KICAgICAgPC9kaXY+CgogICAgICAke3NlYXJjaEJsb2NrKCl9CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5NYXJrZXQgQnJlYWR0aDwvaDI+PHNwYW4gY2xhc3M9",
  "InN1YiI+QWR2YW5jZXJzIHZzIGRlY2xpbmVycywgZnVsbCB1bml2ZXJzZTwvc3Bhbj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgYnJlYWR0aC1jYXJkIiBpZD0iYnJlYWR0aENhcmQiIHN0eWxlPSJwYWRkaW5nOjE4cHggMjJweDttYXJnaW4tYm90dG9t",
  "OjM0cHg7Ij4ke3NrZWxldG9uTGluZXMoMil9PC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiPjxoMj5Ub3AgTW92ZXJzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5CeSBhYnNvbHV0ZSBjaGFuZ2UgdG9kYXk8L3NwYW4+PC9kaXY+CiAgICAgIDxk",
  "aXYgY2xhc3M9InRhYmxlLXdyYXAgZ2xhc3MiIGlkPSJtb3ZlcnNUYWJsZVdyYXAiPjxkaXYgc3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tlbGV0b25MaW5lcyg2KX08L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2FyZHMiIGlkPSJtb3ZlcnND",
  "YXJkcyI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIHdpcmVTZWFyY2goKTsKCiAgdHJ5ewogICAgY29uc3QgaW5kaWNlcyA9IGF3YWl0IEFQSS5mZXRjaEluZGljZXMoKTsKICAgIGlmKHN0YXRlLnZpZXcgIT09ICJkYXNoYm9hcmQiKSByZXR1cm47IC8vIG5hdmln",
  "YXRlZCBhd2F5IHdoaWxlIHRoaXMgd2FzIGluIGZsaWdodAogICAgY29uc3QgaW5kaWNlc1Jvd0VsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImluZGljZXNSb3ciKTsKICAgIGlmKGluZGljZXNSb3dFbCl7CiAgICAgIGluZGljZXNSb3dFbC5pbm5lckhUTUwg",
  "PSBpbmRpY2VzLm1hcChpbmRleENhcmRIVE1MKS5qb2luKCIiKTsKICAgICAgcnVuQ291bnRVcHMoaW5kaWNlc1Jvd0VsKTsKICAgICAgaW5kaWNlc1Jvd0VsLnF1ZXJ5U2VsZWN0b3JBbGwoIi5pbmRleC1zcGFyayIpLmZvckVhY2goKGVsLGkpPT57CiAgICAgICAg",
  "ZWwuaW5uZXJIVE1MID0gc3BhcmtsaW5lU1ZHKGluZGljZXNbaV0uc2VyaWVzLCBpbmRpY2VzW2ldLmNoYW5nZT49MCk7CiAgICAgIH0pOwogICAgfQogIH1jYXRjaChlKXsKICAgIHNldEhUTUwoImluZGljZXNSb3ciLCBlcnJvclN0YXRlSFRNTCgiTWFya2V0IGRh",
  "dGEgdGVtcG9yYXJpbHkgdW5hdmFpbGFibGUiLCAiV2UgY291bGRuJ3QgcmVhY2ggdGhlIGluZGljZXMgZmVlZC4gUGxlYXNlIHRyeSBhZ2FpbiBzaG9ydGx5LiIpKTsKICB9CgogIHRyeXsKICAgIGNvbnN0IGZ1bGwgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJl",
  "c3VsdHMoe30pOwogICAgaWYoc3RhdGUudmlldyAhPT0gImRhc2hib2FyZCIpIHJldHVybjsgLy8gbmF2aWdhdGVkIGF3YXkgd2hpbGUgdGhpcyB3YXMgaW4gZmxpZ2h0CiAgICB0cnl7CiAgICAgIHJlbmRlckJyZWFkdGgoZnVsbCk7CiAgICB9Y2F0Y2goZSl7CiAg",
  "ICAgIHNldEhUTUwoImJyZWFkdGhDYXJkIiwgZXJyb3JTdGF0ZUhUTUwoIkJyZWFkdGggZGF0YSB1bmF2YWlsYWJsZSIsICJDb3VsZG4ndCBjb21wdXRlIGFkdmFuY2VycyB2cyBkZWNsaW5lcnMuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKSk7CiAg",
  "ICAgIHNob3dFcnJvckJhbm5lcigicmVuZGVyQnJlYWR0aCBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogICAgfQogICAgdHJ5ewogICAgICBjb25zdCBtb3ZlcnMgPSBmdWxsLnNsaWNlKCkuc29ydCgoYSxiKT0+TWF0aC5hYnMoYi5wY3QpLU1h",
  "dGguYWJzKGEucGN0KSkuc2xpY2UoMCw4KTsKICAgICAgcmVuZGVyVGFibGVJbnRvKCJtb3ZlcnNUYWJsZVdyYXAiLCAibW92ZXJzQ2FyZHMiLCBtb3ZlcnMsIHtrZXk6InBjdCIsIGRpcjoiZGVzYyJ9LCBmYWxzZSk7CiAgICB9Y2F0Y2goZSl7CiAgICAgIHNldEhU",
  "TUwoIm1vdmVyc1RhYmxlV3JhcCIsIGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gcmV0cmlldmUgbW92ZXJzIiwgIlNvbWV0aGluZyB3ZW50IHdyb25nIGxvYWRpbmcgdGhpcyBsaXN0LiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIikpOwogICAgICBz",
  "aG93RXJyb3JCYW5uZXIoIm1vdmVycyB0YWJsZSByZW5kZXIgZmFpbGVkOiAiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICAgIH0KICB9Y2F0Y2goZSl7CiAgICBpZihzdGF0ZS52aWV3ICE9PSAiZGFzaGJvYXJkIikgcmV0dXJuOwogICAgc2V0SFRNTCgibW92",
  "ZXJzVGFibGVXcmFwIiwgZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byByZXRyaWV2ZSBtb3ZlcnMiLCAiU29tZXRoaW5nIHdlbnQgd3JvbmcgbG9hZGluZyB0aGlzIGxpc3QuICgiICsgKGUgJiYgZS5tZXNzYWdlIHx8IGUpICsgIikiKSk7CiAgICBzZXRIVE1MKCJi",
  "cmVhZHRoQ2FyZCIsIGVycm9yU3RhdGVIVE1MKCJCcmVhZHRoIGRhdGEgdW5hdmFpbGFibGUiLCAiQ291bGRuJ3QgY29tcHV0ZSBhZHZhbmNlcnMgdnMgZGVjbGluZXJzLiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIikpOwogICAgc2hvd0Vycm9yQmFu",
  "bmVyKCJmZXRjaFNjcmVlbmVyUmVzdWx0cyBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogIH0KfQoKZnVuY3Rpb24gcmVuZGVyQnJlYWR0aChsaXN0KXsKICBjb25zdCBlbCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJicmVhZHRoQ2FyZCIp",
  "OwogIGlmKCFlbCB8fCAhbGlzdC5sZW5ndGgpeyBpZihlbCkgZWwuaW5uZXJIVE1MID0gZW1wdHlTdGF0ZUhUTUwoIk5vIGJyZWFkdGggZGF0YSIsICJObyBzdG9ja3Mgd2VyZSByZXR1cm5lZCB0byBjb21wdXRlIHRoaXMgZnJvbS4iKTsgcmV0dXJuOyB9CiAgY29u",
  "c3QgYWR2YW5jZXJzID0gbGlzdC5maWx0ZXIocz0+cy5wY3Q+MCkubGVuZ3RoOwogIGNvbnN0IGRlY2xpbmVycyA9IGxpc3QuZmlsdGVyKHM9PnMucGN0PDApLmxlbmd0aDsKICBjb25zdCBmbGF0ID0gbGlzdC5sZW5ndGggLSBhZHZhbmNlcnMgLSBkZWNsaW5lcnM7",
  "CiAgY29uc3QgdG90YWwgPSBsaXN0Lmxlbmd0aDsKICBjb25zdCBhZHZQY3QgPSAoYWR2YW5jZXJzL3RvdGFsKSoxMDAsIGRlY1BjdCA9IChkZWNsaW5lcnMvdG90YWwpKjEwMCwgZmxhdFBjdCA9IChmbGF0L3RvdGFsKSoxMDA7CiAgZWwuaW5uZXJIVE1MID0gYAog",
  "ICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2p1c3RpZnktY29udGVudDpzcGFjZS1iZXR3ZWVuO2FsaWduLWl0ZW1zOmJhc2VsaW5lO21hcmdpbi1ib3R0b206MTJweDtmbGV4LXdyYXA6d3JhcDtnYXA6OHB4OyI+CiAgICAgIDxkaXYgc3R5bGU9ImRpc3BsYXk6",
  "ZmxleDtnYXA6MjBweDsiPgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjBweDtjb2xvcjp2YXIoLS1wb3Mtc29mdCk7IiBkYXRhLWNvdW50dXA9IiR7YWR2YW5jZXJzfSIgZGF0YS1kZWNpbWFs",
  "cz0iMCI+MDwvc3Bhbj4gPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4OyI+YWR2YW5jaW5nPC9zcGFuPjwvZGl2PgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNp",
  "emU6MjBweDtjb2xvcjp2YXIoLS1uZWctc29mdCk7IiBkYXRhLWNvdW50dXA9IiR7ZGVjbGluZXJzfSIgZGF0YS1kZWNpbWFscz0iMCI+MDwvc3Bhbj4gPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtbG8pO2ZvbnQtc2l6ZToxMnB4OyI+ZGVjbGluaW5nPC9z",
  "cGFuPjwvZGl2PgogICAgICAgIDxkaXY+PHNwYW4gY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MjBweDtjb2xvcjp2YXIoLS10ZXh0LW1pZCk7IiBkYXRhLWNvdW50dXA9IiR7ZmxhdH0iIGRhdGEtZGVjaW1hbHM9IjAiPjA8L3Nw",
  "YW4+IDxzcGFuIHN0eWxlPSJjb2xvcjp2YXIoLS10ZXh0LWxvKTtmb250LXNpemU6MTJweDsiPnVuY2hhbmdlZDwvc3Bhbj48L2Rpdj4KICAgICAgPC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9ImZvbnQtc2l6ZToxMS41cHg7Y29sb3I6dmFyKC0tdGV4dC1mYWludCk7",
  "Ij5vZiAke3RvdGFsfSB0cmFja2VkIHN0b2NrczwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJicmVhZHRoLWJhciIgc3R5bGU9ImRpc3BsYXk6ZmxleDtoZWlnaHQ6MTBweDtib3JkZXItcmFkaXVzOjZweDtvdmVyZmxvdzpoaWRkZW47YmFja2dyb3Vu",
  "ZDp2YXIoLS1iZy1iYXNlKTsiPgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDowJTtiYWNrZ3JvdW5kOmxpbmVhci1ncmFkaWVudCg5MGRlZyx2YXIoLS1wb3MpLHZhcigtLXBvcy1zb2Z0KSk7dHJhbnNpdGlvbjp3aWR0aCAxcyBjdWJpYy1iZXppZXIoLjE2LDEsLjMs",
  "MSkgLjFzOyIgZGF0YS13PSIke2FkdlBjdH0iPjwvZGl2PgogICAgICA8ZGl2IHN0eWxlPSJ3aWR0aDowJTtiYWNrZ3JvdW5kOnZhcigtLXRleHQtZmFpbnQpO3RyYW5zaXRpb246d2lkdGggMXMgY3ViaWMtYmV6aWVyKC4xNiwxLC4zLDEpIC4xczsiIGRhdGEtdz0i",
  "JHtmbGF0UGN0fSI+PC9kaXY+CiAgICAgIDxkaXYgc3R5bGU9IndpZHRoOjAlO2JhY2tncm91bmQ6bGluZWFyLWdyYWRpZW50KDkwZGVnLHZhcigtLW5lZy1zb2Z0KSx2YXIoLS1uZWcpKTt0cmFuc2l0aW9uOndpZHRoIDFzIGN1YmljLWJlemllciguMTYsMSwuMywx",
  "KSAuMXM7IiBkYXRhLXc9IiR7ZGVjUGN0fSI+PC9kaXY+CiAgICA8L2Rpdj4KICBgOwogIHJ1bkNvdW50VXBzKGVsKTsKICByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCk9PiByZXF1ZXN0QW5pbWF0aW9uRnJhbWUoKCk9PnsKICAgIGVsLnF1ZXJ5U2VsZWN0b3JBbGwo",
  "Ii5icmVhZHRoLWJhciBbZGF0YS13XSIpLmZvckVhY2goYmFyPT57IGJhci5zdHlsZS53aWR0aCA9IGJhci5kYXRhc2V0LncgKyAiJSI7IH0pOwogIH0pKTsKfQoKZnVuY3Rpb24gaW5kZXhDYXJkSFRNTChpZHgpewogIGNvbnN0IHBvc2l0aXZlID0gaWR4LmNoYW5n",
  "ZSA+PSAwOwogIHJldHVybiBgCiAgPGRpdiBjbGFzcz0iZ2xhc3MgaW5kZXgtY2FyZCI+CiAgICA8ZGl2IGNsYXNzPSJyb3cxIj4KICAgICAgPGRpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJpbmRleC1uYW1lIj4ke2lkeC5jb2RlfTwvZGl2PgogICAgICAgIDxkaXYg",
  "Y2xhc3M9ImluZGV4LWZ1bGwiPiR7aWR4LmZ1bGx9PC9kaXY+CiAgICAgIDwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJpbmRleC1iYWRnZSAke3Bvc2l0aXZlPydwb3MnOiduZWcnfSI+CiAgICAgICAgJHtwb3NpdGl2ZT8n4payJzon4pa8J30gJHtwY3RTdHIoaWR4",
  "LnBjdCl9CiAgICAgIDwvZGl2PgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC12YWx1ZSBpbmRleC12YWx1ZS1ncmFkaWVudCB0YWJ1bGFyIiBkYXRhLWNvdW50dXA9IiR7aWR4LnZhbHVlfSIgZGF0YS1kZWNpbWFscz0iMiI+MDwvZGl2PgogICAgPGRp",
  "diBjbGFzcz0iaW5kZXgtY2hhbmdlICR7cG9zaXRpdmU/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKGlkeC5jaGFuZ2UpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtc3BhcmsiPjwvZGl2PgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHNrZWxldG9u",
  "Q2FyZHMobil7CiAgcmV0dXJuIEFycmF5LmZyb20oe2xlbmd0aDpufSkubWFwKCgpPT5gPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwiPjwvZGl2PmApLmpvaW4oIiIpOwp9CmZ1bmN0aW9uIHNrZWxldG9uTGluZXMobil7CiAgcmV0dXJuIEFycmF5LmZy",
  "b20oe2xlbmd0aDpufSkubWFwKCgpPT5gPGRpdiBjbGFzcz0ic2tlbCBza2VsLWxpbmUiIHN0eWxlPSJ3aWR0aDokezYwK01hdGgucmFuZG9tKCkqMzV9JSI+PC9kaXY+YCkuam9pbigiIik7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0gU0VBUkNIIC0tLS0tLS0tLS0t",
  "LS0tLS0gKi8KZnVuY3Rpb24gc2VhcmNoQmxvY2soKXsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9InNlYXJjaC13cmFwIiBzdHlsZT0ibWFyZ2luLXRvcDo4cHg7Ij4KICAgIDxkaXYgY2xhc3M9InNlYXJjaC1ib3ggZ2xhc3MiIGlkPSJzZWFyY2hCb3giPgogICAg",
  "ICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJjdXJyZW50Q29sb3IiIHN0cm9rZS13aWR0aD0iMiIgc3Ryb2tlLWxpbmVjYXA9InJvdW5kIj48Y2lyY2xlIGN4PSIxMSIgY3k9IjExIiByPSI3Ii8+PHBhdGggZD0iTTIxIDIxbC00",
  "LjMtNC4zIi8+PC9zdmc+CiAgICAgIDxpbnB1dCB0eXBlPSJ0ZXh0IiBpZD0ic2VhcmNoSW5wdXQiIHBsYWNlaG9sZGVyPSJTZWFyY2ggc3RvY2tzIGJ5IG5hbWUgb3IgdGlja2Vy4oCmIiBhdXRvY29tcGxldGU9Im9mZiI+CiAgICAgIDxrYmQgY2xhc3M9ImtzaG9y",
  "dGN1dCI+Lzwva2JkPgogICAgPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJzZWFyY2gtZHJvcCBnbGFzcyIgaWQ9InNlYXJjaERyb3AiIHN0eWxlPSJkaXNwbGF5Om5vbmU7Ij48L2Rpdj4KICA8L2Rpdj5gOwp9CgpsZXQgc2VhcmNoRGVib3VuY2U7CmZ1bmN0aW9uIHdp",
  "cmVTZWFyY2goKXsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hJbnB1dCIpOwogIGNvbnN0IGJveCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJzZWFyY2hCb3giKTsKICBjb25zdCBkcm9wID0gZG9jdW1lbnQuZ2V0RWxl",
  "bWVudEJ5SWQoInNlYXJjaERyb3AiKTsKICBpZighaW5wdXQpIHJldHVybjsKCiAgZG9jdW1lbnQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsIChlKT0+ewogICAgaWYoZS5rZXkgPT09ICIvIiAmJiBkb2N1bWVudC5hY3RpdmVFbGVtZW50ICE9PSBpbnB1dCl7",
  "CiAgICAgIGUucHJldmVudERlZmF1bHQoKTsKICAgICAgaW5wdXQuZm9jdXMoKTsKICAgIH0KICAgIGlmKGUua2V5ID09PSAiRXNjYXBlIil7IGlucHV0LmJsdXIoKTsgZHJvcC5zdHlsZS5kaXNwbGF5PSJub25lIjsgYm94LmNsYXNzTGlzdC5yZW1vdmUoImZvY3Vz",
  "ZWQiKTsgfQogIH0pOwoKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJmb2N1cyIsICgpPT4gYm94LmNsYXNzTGlzdC5hZGQoImZvY3VzZWQiKSk7CiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiYmx1ciIsICgpPT4gc2V0VGltZW91dCgoKT0+eyBib3guY2xhc3NM",
  "aXN0LnJlbW92ZSgiZm9jdXNlZCIpOyBkcm9wLnN0eWxlLmRpc3BsYXk9Im5vbmUiOyB9LCAxNjApKTsKCiAgaW5wdXQuYWRkRXZlbnRMaXN0ZW5lcigiaW5wdXQiLCAoKT0+ewogICAgY2xlYXJUaW1lb3V0KHNlYXJjaERlYm91bmNlKTsKICAgIGNvbnN0IHEgPSBp",
  "bnB1dC52YWx1ZTsKICAgIGlmKCFxLnRyaW0oKSl7IGRyb3Auc3R5bGUuZGlzcGxheT0ibm9uZSI7IHJldHVybjsgfQogICAgZHJvcC5zdHlsZS5kaXNwbGF5PSJibG9jayI7CiAgICBkcm9wLmlubmVySFRNTCA9IGA8ZGl2IHN0eWxlPSJwYWRkaW5nOjE0cHggMTZw",
  "eDsiPiR7c2tlbGV0b25MaW5lcygzKX08L2Rpdj5gOwogICAgc2VhcmNoRGVib3VuY2UgPSBzZXRUaW1lb3V0KGFzeW5jICgpPT57CiAgICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBBUEkuc2VhcmNoU3RvY2tzKHEpOwogICAgICBpZighcmVzdWx0cy5sZW5ndGgp",
  "ewogICAgICAgIGRyb3AuaW5uZXJIVE1MID0gYDxkaXYgY2xhc3M9InNlYXJjaC1lbXB0eSI+Tm8gc3RvY2tzIG1hdGNoIOKAnCR7ZXNjYXBlSHRtbChxKX3igJ08L2Rpdj5gOwogICAgICAgIHJldHVybjsKICAgICAgfQogICAgICBkcm9wLmlubmVySFRNTCA9IHJl",
  "c3VsdHMubWFwKChzLGkpPT5gCiAgICAgICAgPGRpdiBjbGFzcz0ic2VhcmNoLXJvdyIgc3R5bGU9ImFuaW1hdGlvbi1kZWxheToke2kqMjh9bXMiIGRhdGEtdGlja2VyPSIke3MudH0iPgogICAgICAgICAgPGRpdiBjbGFzcz0ic3ItbGVmdCI+CiAgICAgICAgICAg",
  "IDxkaXYgY2xhc3M9InNyLXRpY2tlciI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICAgICAgPGRpdj4KICAgICAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICAgICAgICA8ZGl2IGNs",
  "YXNzPSJzci1tZXRhIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgICAgICAgIDwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJzci1wcmljZSB0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgICA8",
  "L2Rpdj4KICAgICAgYCkuam9pbigiIik7CiAgICAgIGRyb3AucXVlcnlTZWxlY3RvckFsbCgiLnNlYXJjaC1yb3ciKS5mb3JFYWNoKHJvdz0+ewogICAgICAgIHJvdy5hZGRFdmVudExpc3RlbmVyKCJtb3VzZWRvd24iLCAoKT0+ewogICAgICAgICAgbmF2aWdhdGUo",
  "ImRldGFpbCIsIHJvdy5kYXRhc2V0LnRpY2tlcik7CiAgICAgICAgfSk7CiAgICAgIH0pOwogICAgfSwgMjYwKTsKICB9KTsKfQpkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgic2VhcmNoVG9nZ2xlQnRuIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewog",
  "IGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNlYXJjaElucHV0Iik7CiAgaWYoaW5wdXQpIGlucHV0LmZvY3VzKCk7CiAgZWxzZSBuYXZpZ2F0ZSgiZGFzaGJvYXJkIik7Cn0pOwoKLyogLS0tLS0tLS0tLS0tLS0tLSBTSEFSRUQgVEFCTEUg",
  "UkVOREVSIC0tLS0tLS0tLS0tLS0tLS0gKi8KZnVuY3Rpb24gcmVuZGVyVGFibGVJbnRvKHdyYXBJZCwgY2FyZHNJZCwgbGlzdCwgc29ydCwgc2hvd1NlY3RvckNvbCl7CiAgY29uc3Qgd3JhcCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKHdyYXBJZCk7CiAgY29u",
  "c3QgY2FyZHMgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChjYXJkc0lkKTsKICBpZighbGlzdC5sZW5ndGgpewogICAgd3JhcC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gc3RvY2tzIG1hdGNoIHlvdXIgZmlsdGVycyIsICJUcnkgd2lkZW5pbmcgeW91",
  "ciBwcmljZSByYW5nZSBvciBjbGVhcmluZyBhIGZpbHRlci4iKTsKICAgIGlmKGNhcmRzKSBjYXJkcy5pbm5lckhUTUwgPSAiIjsKICAgIHJldHVybjsKICB9CiAgY29uc3Qgc29ydGVkID0gc29ydFN0b2NrcyhsaXN0LCBzb3J0KTsKCiAgd3JhcC5pbm5lckhUTUwg",
  "PSBgCiAgICA8dGFibGUgY2xhc3M9InN0b2NrLXRhYmxlIj4KICAgICAgPHRoZWFkPjx0cj4KICAgICAgICA8dGg+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9Im5hbWUiPkNvbXBhbnk8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAg",
  "ICAgIDx0aCBkYXRhLWtleT0icHJpY2UiPlByaWNlPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImNoYW5nZSI+Q2hhbmdlPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAg",
  "ICA8dGggZGF0YS1rZXk9InBjdCI+Q2hhbmdlICU8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICAgIDx0aCBkYXRhLWtleT0ibWFya2V0Q2FwIj5NYXJrZXQgQ2FwPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4K",
  "ICAgICAgICA8dGggZGF0YS1rZXk9InZvbHVtZSI+Vm9sdW1lPHNwYW4gY2xhc3M9InNvcnQtaW5kIj7ilr48L3NwYW4+PC90aD4KICAgICAgICA8dGggZGF0YS1rZXk9ImhpZ2g1MiI+NTJXIEhpZ2g8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3Ro",
  "PgogICAgICAgIDx0aCBkYXRhLWtleT0ibG93NTIiPjUyVyBMb3c8c3BhbiBjbGFzcz0ic29ydC1pbmQiPuKWvjwvc3Bhbj48L3RoPgogICAgICA8L3RyPjwvdGhlYWQ+CiAgICAgIDx0Ym9keT4KICAgICAgICAke3NvcnRlZC5tYXAoKHMsaSk9PnN0b2NrUm93SFRN",
  "TChzLGkpKS5qb2luKCIiKX0KICAgICAgPC90Ym9keT4KICAgIDwvdGFibGU+CiAgYDsKICB3cmFwLnF1ZXJ5U2VsZWN0b3JBbGwoInRoW2RhdGEta2V5XSIpLmZvckVhY2godGg9PnsKICAgIHRoLmNsYXNzTGlzdC50b2dnbGUoInNvcnRlZCIsIHRoLmRhdGFzZXQu",
  "a2V5PT09c29ydC5rZXkpOwogICAgaWYodGguZGF0YXNldC5rZXk9PT1zb3J0LmtleSl7IGNvbnN0IGluZCA9IHRoLnF1ZXJ5U2VsZWN0b3IoIi5zb3J0LWluZCIpOyBpZihpbmQpIGluZC50ZXh0Q29udGVudCA9IHNvcnQuZGlyPT09ImRlc2MiPyLilr4iOiLilrQi",
  "OyB9CiAgICB0aC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICAgIGNvbnN0IGtleSA9IHRoLmRhdGFzZXQua2V5OwogICAgICBjb25zdCBuZXdEaXIgPSAoc29ydC5rZXk9PT1rZXkgJiYgc29ydC5kaXI9PT0iZGVzYyIpID8gImFzYyIgOiAiZGVz",
  "YyI7CiAgICAgIGNvbnN0IG5ld1NvcnQgPSB7a2V5LCBkaXI6bmV3RGlyfTsKICAgICAgaWYod3JhcElkPT09InNjcmVlbmVyVGFibGVXcmFwIikgc3RhdGUuc2NyZWVuZXJTb3J0ID0gbmV3U29ydDsKICAgICAgcmVuZGVyVGFibGVJbnRvKHdyYXBJZCwgY2FyZHNJ",
  "ZCwgbGlzdCwgbmV3U29ydCwgc2hvd1NlY3RvckNvbCk7CiAgICB9KTsKICB9KTsKICB3aXJlUm93SW50ZXJhY3Rpb25zKHdyYXApOwoKICBpZihjYXJkcyl7CiAgICBjYXJkcy5pbm5lckhUTUwgPSBzb3J0ZWQubWFwKChzLGkpPT5zdG9ja0NhcmRIVE1MKHMsaSkp",
  "LmpvaW4oIiIpOwogICAgd2lyZVJvd0ludGVyYWN0aW9ucyhjYXJkcyk7CiAgfQp9CgpmdW5jdGlvbiBzb3J0U3RvY2tzKGxpc3QsIHNvcnQpewogIHJldHVybiBsaXN0LnNsaWNlKCkuc29ydCgoYSxiKT0+ewogICAgbGV0IGF2PWFbc29ydC5rZXldLCBidj1iW3Nv",
  "cnQua2V5XTsKICAgIGlmKHNvcnQua2V5PT09Im5hbWUiKXsgYXY9YS5uYW1lOyBidj1iLm5hbWU7IHJldHVybiBzb3J0LmRpcj09PSJhc2MiPyBhdi5sb2NhbGVDb21wYXJlKGJ2KSA6IGJ2LmxvY2FsZUNvbXBhcmUoYXYpOyB9CiAgICByZXR1cm4gc29ydC5kaXI9",
  "PT0iYXNjIiA/IGF2LWJ2IDogYnYtYXY7CiAgfSk7Cn0KCmZ1bmN0aW9uIHN0b2NrUm93SFRNTChzLGkpewogIGNvbnN0IHBvcyA9IHMucGN0Pj0wOwogIGNvbnN0IGluV2F0Y2ggPSBzdGF0ZS53YXRjaGxpc3QuaW5jbHVkZXMocy50KTsKICByZXR1cm4gYAogIDx0",
  "ciBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSoyMn1tcyI+CiAgICA8dGQgb25jbGljaz0iZXZlbnQuc3RvcFByb3BhZ2F0aW9uKCkiPgogICAgICA8YnV0dG9uIGNsYXNzPSJzdGFyLWJ0biAke2luV2F0Y2g/J2FjdGl2ZSc6",
  "Jyd9IiBkYXRhLXN0YXI9IiR7cy50fSIgdGl0bGU9IiR7aW5XYXRjaD8nUmVtb3ZlIGZyb20gd2F0Y2hsaXN0JzonQWRkIHRvIHdhdGNobGlzdCd9Ij4KICAgICAgICA8c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iJHtpbldhdGNoPydjdXJyZW50Q29sb3In",
  "Oidub25lJ30iIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0LjYgMS42NCA2Ljl6Ii8+PC9zdmc+",
  "CiAgICAgIDwvYnV0dG9uPgogICAgPC90ZD4KICAgIDx0ZD4KICAgICAgPGRpdiBjbGFzcz0iY2VsbC1jb21wYW55Ij4KICAgICAgICA8ZGl2IGNsYXNzPSJjZWxsLXRpY2tlci1iYWRnZSI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICA8ZGl2PgogICAg",
  "ICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnktc3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgIDwvZGl2Pgog",
  "ICAgPC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRJTlIocy5wcmljZSl9PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+PHNwYW4gY2xhc3M9ImNoYW5nZS1waWxsICR7cG9zPydwb3MnOiduZWcnfSI+JHtjaGdTdHIocy5jaGFuZ2UpfTwvc3Bh",
  "bj48L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj48c3BhbiBjbGFzcz0iY2hhbmdlLXBpbGwgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke3BjdFN0cihzLnBjdCl9PC9zcGFuPjwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10Q29tcGFjdChzLm1hcmtl",
  "dENhcCl9PC90ZD4KICAgIDx0ZCBjbGFzcz0idGFidWxhciI+JHtmbXRWb2wocy52b2x1bWUpfTwvdGQ+CiAgICA8dGQgY2xhc3M9InRhYnVsYXIiPiR7Zm10SU5SKHMuaGlnaDUyKX08L3RkPgogICAgPHRkIGNsYXNzPSJ0YWJ1bGFyIj4ke2ZtdElOUihzLmxvdzUy",
  "KX08L3RkPgogIDwvdHI+YDsKfQoKZnVuY3Rpb24gc3RvY2tDYXJkSFRNTChzLGkpewogIGNvbnN0IHBvcyA9IHMucGN0Pj0wOwogIGNvbnN0IGluV2F0Y2ggPSBzdGF0ZS53YXRjaGxpc3QuaW5jbHVkZXMocy50KTsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9Imds",
  "YXNzIHN0b2NrLWNhcmQiIGRhdGEtdGlja2VyPSIke3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjI2fW1zIj4KICAgIDxkaXYgY2xhc3M9ImxlZnQiPgogICAgICA8ZGl2IGNsYXNzPSJjZWxsLXRpY2tlci1iYWRnZSI+JHtzLnQuc2xpY2UoMCwzKX08",
  "L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ibmFtZS1ibG9jayI+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNo",
  "fTwvZGl2PgogICAgICA8L2Rpdj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0icmlnaHQiPgogICAgICA8ZGl2IGNsYXNzPSJwcmljZSB0YWJ1bGFyIj4ke2ZtdElOUihzLnByaWNlKX08L2Rpdj4KICAgICAgPHNwYW4gY2xhc3M9ImNoYW5nZS1waWxsICR7cG9z",
  "Pydwb3MnOiduZWcnfSIgc3R5bGU9Im1hcmdpbi10b3A6NHB4OyI+JHtwY3RTdHIocy5wY3QpfTwvc3Bhbj4KICAgIDwvZGl2PgogIDwvZGl2PmA7Cn0KCmZ1bmN0aW9uIHdpcmVSb3dJbnRlcmFjdGlvbnMoY29udGFpbmVyKXsKICBjb250YWluZXIucXVlcnlTZWxl",
  "Y3RvckFsbCgidHJbZGF0YS10aWNrZXJdLCAuc3RvY2stY2FyZFtkYXRhLXRpY2tlcl0iKS5mb3JFYWNoKGVsPT57CiAgICBlbC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT4gbmF2aWdhdGUoImRldGFpbCIsIGVsLmRhdGFzZXQudGlja2VyKSk7CiAgfSk7",
  "CiAgY29udGFpbmVyLnF1ZXJ5U2VsZWN0b3JBbGwoIltkYXRhLXN0YXJdIikuZm9yRWFjaChidG49PnsKICAgIGJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsIChlKT0+ewogICAgICBlLnN0b3BQcm9wYWdhdGlvbigpOwogICAgICB0b2dnbGVXYXRjaChidG4u",
  "ZGF0YXNldC5zdGFyKTsKICAgICAgYnRuLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIpOwogICAgICBidG4ucXVlcnlTZWxlY3Rvcigic3ZnIikuc2V0QXR0cmlidXRlKCJmaWxsIiwgYnRuLmNsYXNzTGlzdC5jb250YWlucygiYWN0aXZlIikgPyAiY3VycmVudENv",
  "bG9yIiA6ICJub25lIik7CiAgICB9KTsKICB9KTsKfQoKZnVuY3Rpb24gdG9nZ2xlV2F0Y2godGlja2VyKXsKICBjb25zdCBpZHggPSBzdGF0ZS53YXRjaGxpc3QuaW5kZXhPZih0aWNrZXIpOwogIGlmKGlkeD49MCkgc3RhdGUud2F0Y2hsaXN0LnNwbGljZShpZHgs",
  "MSk7CiAgZWxzZSBzdGF0ZS53YXRjaGxpc3QucHVzaCh0aWNrZXIpOwogIHBlcnNpc3RXYXRjaGxpc3QoKTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBTQ1JFRU5FUiAtLS0tLS0tLS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlclNjcmVlbmVyKCl7CiAg",
  "Y29uc3Qgc2VjdG9ycyA9IFsiQWxsIiwgLi4uQXJyYXkuZnJvbShuZXcgU2V0KFVOSVZFUlNFLm1hcChzPT5zLnNlY3RvcikpKV07CiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3Ij4KICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFk",
  "Ij48aDI+U2NyZWVuZXI8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkZpbHRlciB0aGUgbWFya2V0IG9uIHlvdXIgdGVybXM8L3NwYW4+PC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJhaS1xdWVyeS1ib3ggZ2xhc3MiPgogICAgICAgIDxkaXYgY2xhc3M9ImFpLXF1ZXJ5",
  "LXJvdyI+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJhaS1hdmF0YXIiIHN0eWxlPSJ3aWR0aDoyNHB4O2hlaWdodDoyNHB4O2ZvbnQtc2l6ZToxMnB4OyI+4pymPC9kaXY+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImFpUXVlcnlJbnB1dCIgcGxhY2Vo",
  "b2xkZXI9IkFzayBpbiBwbGFpbiBFbmdsaXNoIOKAlCBlLmcuIOKAnHdoaWNoIElUIHN0b2NrcyBhcmUgdXAgdG9kYXnigJ0iPgogICAgICAgICAgPGJ1dHRvbiBjbGFzcz0iYWktcXVlcnktYnRuIiBpZD0iYWlRdWVyeUJ0biI+QXNrPC9idXR0b24+CiAgICAgICAg",
  "PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iYWktcXVlcnktYW5zd2VyIiBpZD0iYWlRdWVyeUFuc3dlciIgc3R5bGU9ImRpc3BsYXk6bm9uZTsiPjwvZGl2PgogICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGZpbHRlcnMtYmFyIj4KICAgICAg",
  "ICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCIgc3R5bGU9Im1pbi13aWR0aDoyMDBweDsiPgogICAgICAgICAgPGxhYmVsPlNlYXJjaDwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0idGV4dCIgaWQ9ImZRdWVyeSIgcGxhY2Vob2xkZXI9IlRpY2tlciBvciBj",
  "b21wYW554oCmIiB2YWx1ZT0iJHtlc2NhcGVIdG1sKHN0YXRlLnNjcmVlbmVyRmlsdGVycy5xdWVyeSl9Ij4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJmaWx0ZXItY2hpcCI+CiAgICAgICAgICA8bGFiZWw+U2VjdG9yPC9sYWJlbD4KICAgICAg",
  "ICAgIDxzZWxlY3QgaWQ9ImZTZWN0b3IiPiR7c2VjdG9ycy5tYXAocz0+YDxvcHRpb24gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yPT09cz8nc2VsZWN0ZWQnOicnfT4ke3N9PC9vcHRpb24+YCkuam9pbigiIil9PC9zZWxlY3Q+CiAgICAgICAgPC9kaXY+",
  "CiAgICAgICAgPGRpdiBjbGFzcz0iZmlsdGVyLWNoaXAiPgogICAgICAgICAgPGxhYmVsPk1heCBQcmljZSA8c3BhbiBjbGFzcz0icmFuZ2UtdmFsIiBpZD0iZlByaWNlVmFsIj4ke2ZtdElOUihzdGF0ZS5zY3JlZW5lckZpbHRlcnMubWF4UHJpY2UsMCl9PC9zcGFu",
  "PjwvbGFiZWw+CiAgICAgICAgICA8aW5wdXQgdHlwZT0icmFuZ2UiIGNsYXNzPSJyYW5nZS1zbGlkZXIiIGlkPSJmTWF4UHJpY2UiIG1pbj0iNTAwIiBtYXg9IjE1MDAwIiBzdGVwPSIyNTAiIHZhbHVlPSIke3N0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZX0i",
  "PgogICAgICAgIDwvZGl2PgogICAgICAgIDxkaXYgY2xhc3M9ImZpbHRlci1jaGlwIiBzdHlsZT0ibWluLXdpZHRoOjE5MHB4OyI+CiAgICAgICAgICA8bGFiZWw+RGlyZWN0aW9uPC9sYWJlbD4KICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1ncm91cCI+CiAg",
  "ICAgICAgICAgIDxkaXYgY2xhc3M9InRvZ2dsZS1idG4gJHtzdGF0ZS5zY3JlZW5lckZpbHRlcnMuZGlyZWN0aW9uPT09J2FsbCc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRpcj0iYWxsIj5BbGw8L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0idG9nZ2xlLWJ0biAk",
  "e3N0YXRlLnNjcmVlbmVyRmlsdGVycy5kaXJlY3Rpb249PT0nZ2FpbmVycyc/J2FjdGl2ZSc6Jyd9IiBkYXRhLWRpcj0iZ2FpbmVycyI+R2FpbmVyczwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJ0b2dnbGUtYnRuICR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJz",
  "LmRpcmVjdGlvbj09PSdsb3NlcnMnPydhY3RpdmUnOicnfSIgZGF0YS1kaXI9Imxvc2VycyI+TG9zZXJzPC9kaXY+CiAgICAgICAgICA8L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJyZXNldC1maWx0ZXJzIiBpZD0icmVzZXRGaWx0ZXJz",
  "Ij5SZXNldCBmaWx0ZXJzPC9kaXY+CiAgICAgIDwvZGl2PgoKICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIj48aDIgaWQ9InNjcmVlbmVyQ291bnQiPlJlc3VsdHM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlNvcnRlZCBieSBtYXJrZXQgY2FwPC9zcGFuPjwv",
  "ZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ0YWJsZS13cmFwIGdsYXNzIiBpZD0ic2NyZWVuZXJUYWJsZVdyYXAiPjxkaXYgc3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tlbGV0b25MaW5lcyg4KX08L2Rpdj48L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0ic3RvY2stY2Fy",
  "ZHMiIGlkPSJzY3JlZW5lckNhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CgogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmUXVlcnkiKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsIGRlYm91bmNlKGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5x",
  "dWVyeSA9IGUudGFyZ2V0LnZhbHVlOyBydW5TY3JlZW5lcigpOwogIH0sIDI2MCkpOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmU2VjdG9yIikuYWRkRXZlbnRMaXN0ZW5lcigiY2hhbmdlIiwgZT0+ewogICAgc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3Rv",
  "ciA9IGUudGFyZ2V0LnZhbHVlOyBydW5TY3JlZW5lcigpOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJmTWF4UHJpY2UiKS5hZGRFdmVudExpc3RlbmVyKCJpbnB1dCIsIGU9PnsKICAgIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5tYXhQcmljZSA9IE51",
  "bWJlcihlLnRhcmdldC52YWx1ZSk7CiAgICBzZXRUZXh0KCJmUHJpY2VWYWwiLCBmbXRJTlIoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzLm1heFByaWNlLDApKTsKICAgIHJ1blNjcmVlbmVyKCk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgiW2RhdGEt",
  "ZGlyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoKT0+ewogICAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMuZGlyZWN0aW9uID0gYnRuLmRhdGFzZXQuZGlyOwogICAgICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxs",
  "KCJbZGF0YS1kaXJdIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGI9PT1idG4pKTsKICAgICAgcnVuU2NyZWVuZXIoKTsKICAgIH0pOwogIH0pOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJyZXNldEZpbHRlcnMiKS5hZGRFdmVu",
  "dExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICBzdGF0ZS5zY3JlZW5lckZpbHRlcnMgPSB7cXVlcnk6IiIsIHNlY3RvcjoiQWxsIiwgbWluUHJpY2U6MCwgbWF4UHJpY2U6MTUwMDAsIGRpcmVjdGlvbjoiYWxsIn07CiAgICByZW5kZXJTY3JlZW5lcigpOwogIH0p",
  "OwoKICB3aXJlU2NyZWVuZXJBaVF1ZXJ5KCk7CiAgcnVuU2NyZWVuZXIoKTsKfQoKZnVuY3Rpb24gd2lyZVNjcmVlbmVyQWlRdWVyeSgpewogIGNvbnN0IGlucHV0ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpUXVlcnlJbnB1dCIpOwogIGNvbnN0IGJ0biA9",
  "IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVF1ZXJ5QnRuIik7CiAgY29uc3QgYW5zd2VyQm94ID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpUXVlcnlBbnN3ZXIiKTsKICBpZighaW5wdXQgfHwgIWJ0bikgcmV0dXJuOwoKICBhc3luYyBmdW5jdGlvbiBh",
  "c2soKXsKICAgIGNvbnN0IHF1ZXN0aW9uID0gaW5wdXQudmFsdWUudHJpbSgpOwogICAgaWYoIXF1ZXN0aW9uIHx8IGJ0bi5kaXNhYmxlZCkgcmV0dXJuOwogICAgYnRuLmRpc2FibGVkID0gdHJ1ZTsKICAgIGNvbnN0IG9yaWdpbmFsTGFiZWwgPSBidG4udGV4dENv",
  "bnRlbnQ7CiAgICBidG4udGV4dENvbnRlbnQgPSAi4oCmIjsKICAgIGFuc3dlckJveC5zdHlsZS5kaXNwbGF5ID0gImJsb2NrIjsKICAgIGFuc3dlckJveC5pbm5lckhUTUwgPSBza2VsZXRvbkxpbmVzKDIpOwogICAgdHJ5ewogICAgICBpZighbGl2ZUJhY2tlbmRB",
  "dmFpbGFibGUpIGF3YWl0IGNoZWNrTGl2ZUJhY2tlbmQoKTsKICAgICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSB0aHJvdyBuZXcgRXJyb3IoIkJhY2tlbmQgbm90IGNvbm5lY3RlZC4gSWYgaXQgd2FzIGp1c3QgaWRsZSwgdHJ5IGFnYWluIGluIGEgbW9tZW50",
  "LiIpOwoKICAgICAgY29uc3QgY3RybCA9IG5ldyBBYm9ydENvbnRyb2xsZXIoKTsKICAgICAgY29uc3QgaWQgPSBzZXRUaW1lb3V0KCgpPT5jdHJsLmFib3J0KCksIDIwMDAwKTsKICAgICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goQ09ORklHLkFQSV9CQVNFICsg",
  "Ii9jaGF0IiwgewogICAgICAgIG1ldGhvZDogIlBPU1QiLAogICAgICAgIGhlYWRlcnM6IHsiQ29udGVudC1UeXBlIjogImFwcGxpY2F0aW9uL2pzb24ifSwKICAgICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgICBxdWVzdGlvbiwKICAgICAgICAg",
  "IGNvbnRleHQ6IGF3YWl0IGJ1aWxkQWlDb250ZXh0KCksCiAgICAgICAgICBoaXN0b3J5OiBbXSwKICAgICAgICB9KSwKICAgICAgICBzaWduYWw6IGN0cmwuc2lnbmFsLAogICAgICB9KS5maW5hbGx5KCgpPT5jbGVhclRpbWVvdXQoaWQpKTsKCiAgICAgIGNvbnN0",
  "IGpzb24gPSBhd2FpdCByZXMuanNvbigpOwogICAgICBpZighcmVzLm9rIHx8ICFqc29uLnN1Y2Nlc3MpIHRocm93IG5ldyBFcnJvcigoanNvbi5lcnJvciAmJiBqc29uLmVycm9yLm1lc3NhZ2UpIHx8ICgiUmVxdWVzdCBmYWlsZWQgKCIgKyByZXMuc3RhdHVzICsg",
  "IikiKSk7CiAgICAgIGFuc3dlckJveC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iYWktYXZhdGFyIiBzdHlsZT0id2lkdGg6MjJweDtoZWlnaHQ6MjJweDtmb250LXNpemU6MTFweDtmbGV4LXNocmluazowOyI+4pymPC9kaXY+PGRpdj4ke2VzY2FwZUh0bWwoanNv",
  "bi5kYXRhLmFuc3dlcil9PC9kaXY+YDsKICAgIH1jYXRjaChlKXsKICAgICAgYW5zd2VyQm94LmlubmVySFRNTCA9IGA8ZGl2IHN0eWxlPSJjb2xvcjp2YXIoLS1uZWctc29mdCk7Ij5Db3VsZG4ndCBnZXQgYW4gYW5zd2VyOiAke2VzY2FwZUh0bWwoZSAmJiBlLm1l",
  "c3NhZ2UgfHwgU3RyaW5nKGUpKX08L2Rpdj5gOwogICAgfWZpbmFsbHl7CiAgICAgIGJ0bi5kaXNhYmxlZCA9IGZhbHNlOwogICAgICBidG4udGV4dENvbnRlbnQgPSBvcmlnaW5hbExhYmVsOwogICAgfQogIH0KCiAgYnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNr",
  "IiwgYXNrKTsKICBpbnB1dC5hZGRFdmVudExpc3RlbmVyKCJrZXlkb3duIiwgKGUpPT57IGlmKGUua2V5ID09PSAiRW50ZXIiKSBhc2soKTsgfSk7Cn0KCmZ1bmN0aW9uIGRlYm91bmNlKGZuLCBtcyl7CiAgbGV0IGg7CiAgcmV0dXJuICguLi5hcmdzKT0+eyBjbGVh",
  "clRpbWVvdXQoaCk7IGg9c2V0VGltZW91dCgoKT0+Zm4oLi4uYXJncyksIG1zKTsgfTsKfQoKYXN5bmMgZnVuY3Rpb24gcnVuU2NyZWVuZXIoKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInNjcmVlbmVyVGFibGVXcmFwIik7CiAgaWYo",
  "IXdyYXAgfHwgc3RhdGUudmlldyAhPT0gInNjcmVlbmVyIikgcmV0dXJuOyAvLyB2aWV3IG5vdCBhY3RpdmUg4oCUIG5vdGhpbmcgdG8gdXBkYXRlCiAgd3JhcC5zdHlsZS5vcGFjaXR5ID0gIjAuNTUiOwogIHRyeXsKICAgIGNvbnN0IHJlc3VsdHMgPSBhd2FpdCBB",
  "UEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoc3RhdGUuc2NyZWVuZXJGaWx0ZXJzKTsKICAgIGlmKHN0YXRlLnZpZXcgIT09ICJzY3JlZW5lciIpIHJldHVybjsgLy8gbmF2aWdhdGVkIGF3YXkgd2hpbGUgdGhlIGZldGNoIHdhcyBpbiBmbGlnaHQKICAgIHNldFRleHQo",
  "InNjcmVlbmVyQ291bnQiLCBgUmVzdWx0cyAoJHtyZXN1bHRzLmxlbmd0aH0pYCk7CiAgICAvLyBPbmUtdGltZSBkaWFnbm9zdGljOiBpZiBhIHNlY3RvciBmaWx0ZXIgeWllbGRzIHplcm8sIHNob3cgZXhhY3RseSB3aGF0CiAgICAvLyBzZWN0b3IgdmFsdWVzIGFj",
  "dHVhbGx5IGV4aXN0IGluIHRoZSBsb2FkZWQgZGF0YSBzbyBhIG1pc21hdGNoICh0eXBvLAogICAgLy8gY2FzaW5nLCBzdGFsZSBmaWVsZCkgaXMgdmlzaWJsZSBpbnN0ZWFkIG9mIGd1ZXNzZWQgYXQuCiAgICBpZihyZXN1bHRzLmxlbmd0aCA9PT0gMCAmJiBzdGF0",
  "ZS5zY3JlZW5lckZpbHRlcnMuc2VjdG9yICYmIHN0YXRlLnNjcmVlbmVyRmlsdGVycy5zZWN0b3IgIT09ICJBbGwiKXsKICAgICAgdHJ5ewogICAgICAgIGNvbnN0IHVuZmlsdGVyZWQgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoey4uLnN0YXRlLnNj",
  "cmVlbmVyRmlsdGVycywgc2VjdG9yOiJBbGwifSk7CiAgICAgICAgY29uc3Qgc2VlblNlY3RvcnMgPSBBcnJheS5mcm9tKG5ldyBTZXQodW5maWx0ZXJlZC5tYXAocz0+cy5zZWN0b3IpKSk7CiAgICAgICAgc2hvd0Vycm9yQmFubmVyKGBERUJVRzogMCByZXN1bHRz",
  "IGZvciBzZWN0b3IgIiR7c3RhdGUuc2NyZWVuZXJGaWx0ZXJzLnNlY3Rvcn0iLiAke3VuZmlsdGVyZWQubGVuZ3RofSBzdG9ja3MgbG9hZGVkIHRvdGFsLiBTZWN0b3IgdmFsdWVzIGFjdHVhbGx5IHByZXNlbnQ6ICR7SlNPTi5zdHJpbmdpZnkoc2VlblNlY3RvcnMp",
  "fWApOwogICAgICB9Y2F0Y2goZSl7IC8qIGRpYWdub3N0aWMgb25seSwgaWdub3JlIGZhaWx1cmVzIGhlcmUgKi8gfQogICAgfQogICAgcmVuZGVyVGFibGVJbnRvKCJzY3JlZW5lclRhYmxlV3JhcCIsICJzY3JlZW5lckNhcmRzIiwgcmVzdWx0cywgc3RhdGUuc2Ny",
  "ZWVuZXJTb3J0LCB0cnVlKTsKICB9Y2F0Y2goZSl7CiAgICB3cmFwLmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJTY3JlZW5lciBkYXRhIHVuYXZhaWxhYmxlIiwgIldlIGNvdWxkbid0IGxvYWQgbWF0Y2hpbmcgc3RvY2tzIHJpZ2h0IG5vdy4gKCIgKyAoZSAm",
  "JiBlLm1lc3NhZ2UgfHwgZSkgKyAiKSIpOwogICAgc2hvd0Vycm9yQmFubmVyKCJydW5TY3JlZW5lciBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogIH0KICB3cmFwLnN0eWxlLm9wYWNpdHkgPSAiMSI7Cn0KCi8qIC0tLS0tLS0tLS0tLS0tLS0g",
  "TUFSS0VUUyAoZnVsbCB1bml2ZXJzZSB0YWJsZSArIHRyZW5kaW5nIGhpZ2hsaWdodHMpIC0tLS0tLS0tLS0tLS0tLS0gKi8KYXN5bmMgZnVuY3Rpb24gcmVuZGVyTWFya2V0cygpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAg",
  "ICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPk1hcmtldHM8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPkZ1bGwgTlNFIHVuaXZlcnNlIHNuYXBzaG90PC9zcGFuPjwvZGl2PgogICAgICAke3NlYXJjaEJsb2NrKCl9CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0",
  "aW9uLWhlYWQiPjxoMj5UcmVuZGluZyBOb3c8L2gyPjxzcGFuIGNsYXNzPSJzdWIiPlRvZGF5J3MgYmlnZ2VzdCBtb3ZlcnMsIHVwIG9yIGRvd248L3NwYW4+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InRyZW5kaW5nLXJvdyIgaWQ9InRyZW5kaW5nUm93Ij4ke3Nr",
  "ZWxldG9uQ2FyZHMoNCl9PC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJzZWN0aW9uLWhlYWQiIHN0eWxlPSJtYXJnaW4tdG9wOjhweDsiPjxoMj5BbGwgU3RvY2tzPC9oMj48c3BhbiBjbGFzcz0ic3ViIj5Tb3J0ZWQgYnkgbWFya2V0IGNhcDwvc3Bhbj48L2Rpdj4K",
  "ICAgICAgPGRpdiBjbGFzcz0idGFibGUtd3JhcCBnbGFzcyIgaWQ9Im1hcmtldHNUYWJsZVdyYXAiPjxkaXYgc3R5bGU9InBhZGRpbmc6MjBweDsiPiR7c2tlbGV0b25MaW5lcygxMCl9PC9kaXY+PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9InN0b2NrLWNhcmRzIiBp",
  "ZD0ibWFya2V0c0NhcmRzIj48L2Rpdj4KICAgIDwvZGl2PgogIGA7CiAgd2lyZVNlYXJjaCgpOwogIHRyeXsKICAgIGNvbnN0IGxpc3QgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3VsdHMoe30pOwogICAgaWYoc3RhdGUudmlldyAhPT0gIm1hcmtldHMiKSBy",
  "ZXR1cm47IC8vIG5hdmlnYXRlZCBhd2F5IHdoaWxlIHRoaXMgd2FzIGluIGZsaWdodAogICAgcmVuZGVyVHJlbmRpbmcobGlzdCk7CiAgICByZW5kZXJUYWJsZUludG8oIm1hcmtldHNUYWJsZVdyYXAiLCAibWFya2V0c0NhcmRzIiwgbGlzdCwge2tleToibWFya2V0",
  "Q2FwIiwgZGlyOiJkZXNjIn0sIHRydWUpOwogIH1jYXRjaChlKXsKICAgIGlmKHN0YXRlLnZpZXcgIT09ICJtYXJrZXRzIikgcmV0dXJuOwogICAgc2V0SFRNTCgibWFya2V0c1RhYmxlV3JhcCIsIGVycm9yU3RhdGVIVE1MKCJNYXJrZXQgZGF0YSB0ZW1wb3Jhcmls",
  "eSB1bmF2YWlsYWJsZSIsICJQbGVhc2UgdHJ5IGFnYWluIGluIGEgbW9tZW50LiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIikpOwogICAgc2V0SFRNTCgidHJlbmRpbmdSb3ciLCBlcnJvclN0YXRlSFRNTCgiVHJlbmRpbmcgZGF0YSB1bmF2YWlsYWJs",
  "ZSIsICJQbGVhc2UgdHJ5IGFnYWluIGluIGEgbW9tZW50LiIpKTsKICAgIHNob3dFcnJvckJhbm5lcigicmVuZGVyTWFya2V0cyBmYWlsZWQ6ICIgKyAoZSAmJiBlLm1lc3NhZ2UgfHwgZSkpOwogIH0KfQoKZnVuY3Rpb24gcmVuZGVyVHJlbmRpbmcobGlzdCl7CiAg",
  "Y29uc3QgZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgidHJlbmRpbmdSb3ciKTsKICBpZighZWwpIHJldHVybjsKICBpZighbGlzdC5sZW5ndGgpeyBlbC5pbm5lckhUTUwgPSBlbXB0eVN0YXRlSFRNTCgiTm8gdHJlbmRpbmcgZGF0YSIsICJObyBzdG9ja3Mg",
  "d2VyZSByZXR1cm5lZCB0byByYW5rLiIpOyByZXR1cm47IH0KICBjb25zdCBob3QgPSBsaXN0LnNsaWNlKCkuc29ydCgoYSxiKT0+TWF0aC5hYnMoYi5wY3QpLU1hdGguYWJzKGEucGN0KSkuc2xpY2UoMCw2KTsKICBlbC5pbm5lckhUTUwgPSBob3QubWFwKChzLGkp",
  "PT57CiAgICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICAgIHJldHVybiBgCiAgICA8ZGl2IGNsYXNzPSJnbGFzcyB0cmVuZGluZy1jYXJkIiBkYXRhLXRpY2tlcj0iJHtzLnR9IiBzdHlsZT0iYW5pbWF0aW9uLWRlbGF5OiR7aSo0MH1tcyI+CiAgICAgIDxkaXYgY2xh",
  "c3M9InRyZW5kaW5nLXRvcCI+CiAgICAgICAgPGRpdiBjbGFzcz0iY2VsbC10aWNrZXItYmFkZ2UiPiR7cy50LnNsaWNlKDAsMyl9PC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iaW5kZXgtYmFkZ2UgJHtwb3M/J3Bvcyc6J25lZyd9Ij4ke3Bvcz8n4payJzon4pa8",
  "J30gJHtwY3RTdHIocy5wY3QpfTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIiBzdHlsZT0ibWFyZ2luLXRvcDoxMHB4OyI+JHtlc2NhcGVIdG1sKHMubmFtZSl9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImNvbXBhbnkt",
  "c3ViIj4ke3MudH0gwrcgJHtzLmV4Y2h9PC9kaXY+CiAgICAgIDxkaXYgY2xhc3M9ImluZGV4LXZhbHVlIHRhYnVsYXIiIHN0eWxlPSJmb250LXNpemU6MTlweDttYXJnaW4tdG9wOjhweDsiPiR7Zm10SU5SKHMucHJpY2UpfTwvZGl2PgogICAgICA8ZGl2IGNsYXNz",
  "PSJpbmRleC1zcGFyayIgc3R5bGU9ImhlaWdodDoyOHB4O21hcmdpbi10b3A6OHB4OyI+JHtzcGFya2xpbmVTVkcocy5zZXJpZXMsIHBvcyl9PC9kaXY+CiAgICA8L2Rpdj5gOwogIH0pLmpvaW4oIiIpOwogIGVsLnF1ZXJ5U2VsZWN0b3JBbGwoIi50cmVuZGluZy1j",
  "YXJkIikuZm9yRWFjaChjYXJkPT57CiAgICBjYXJkLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PiBuYXZpZ2F0ZSgiZGV0YWlsIiwgY2FyZC5kYXRhc2V0LnRpY2tlcikpOwogIH0pOwp9CgovKiAtLS0tLS0tLS0tLS0tLS0tIFdBVENITElTVCAtLS0tLS0t",
  "LS0tLS0tLS0tICovCmFzeW5jIGZ1bmN0aW9uIHJlbmRlcldhdGNobGlzdCgpewogIHJvb3QuaW5uZXJIVE1MID0gYAogICAgPGRpdiBjbGFzcz0idmlldyI+CiAgICAgIDxkaXYgY2xhc3M9InNlY3Rpb24taGVhZCI+PGgyPldhdGNobGlzdDwvaDI+PHNwYW4gY2xh",
  "c3M9InN1YiI+JHtzdGF0ZS53YXRjaGxpc3QubGVuZ3RofSBzdG9jayR7c3RhdGUud2F0Y2hsaXN0Lmxlbmd0aD09PTE/Jyc6J3MnfSB0cmFja2VkPC9zcGFuPjwvZGl2PgogICAgICA8ZGl2IGNsYXNzPSJ3YXRjaGxpc3QtZ3JpZCIgaWQ9IndhdGNoR3JpZCI+JHtz",
  "a2VsZXRvbkNhcmRzKE1hdGgubWF4KHN0YXRlLndhdGNobGlzdC5sZW5ndGgsMykpfTwvZGl2PgogICAgPC9kaXY+CiAgYDsKICBpZighc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCl7CiAgICBzZXRIVE1MKCJ3YXRjaEdyaWQiLCBgPGRpdiBjbGFzcz0id2F0Y2gtZW1w",
  "dHkgZ2xhc3MiPiR7ZW1wdHlTdGF0ZUlubmVyKCJZb3VyIHdhdGNobGlzdCBpcyBlbXB0eSIsICJTdGFyIGFueSBzdG9jayBmcm9tIHRoZSBkYXNoYm9hcmQsIHNjcmVlbmVyIG9yIG1hcmtldHMgdmlldyB0byB0cmFjayBpdCBoZXJlLiIpfTwvZGl2PmApOwogICAg",
  "cmV0dXJuOwogIH0KICB0cnl7CiAgICBjb25zdCBzdG9ja3MgPSBhd2FpdCBQcm9taXNlLmFsbChzdGF0ZS53YXRjaGxpc3QubWFwKHQ9PkFQSS5mZXRjaFN0b2NrKHQpKSk7CiAgICBpZihzdGF0ZS52aWV3ICE9PSAid2F0Y2hsaXN0IikgcmV0dXJuOyAvLyBuYXZp",
  "Z2F0ZWQgYXdheSB3aGlsZSB0aGlzIHdhcyBpbiBmbGlnaHQKICAgIGNvbnN0IGdyaWQgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgid2F0Y2hHcmlkIik7CiAgICBpZihncmlkKXsKICAgICAgZ3JpZC5pbm5lckhUTUwgPSBzdG9ja3MuZmlsdGVyKEJvb2xlYW4p",
  "Lm1hcCgocyxpKT0+d2F0Y2hDYXJkSFRNTChzLGkpKS5qb2luKCIiKTsKICAgICAgd2lyZVdhdGNoQ2FyZHMoKTsKICAgIH0KICB9Y2F0Y2goZSl7CiAgICBpZihzdGF0ZS52aWV3ICE9PSAid2F0Y2hsaXN0IikgcmV0dXJuOwogICAgc2V0SFRNTCgid2F0Y2hHcmlk",
  "IiwgZXJyb3JTdGF0ZUhUTUwoIlVuYWJsZSB0byBsb2FkIHdhdGNobGlzdCIsICJQbGVhc2UgdHJ5IGFnYWluLiAoIiArIChlICYmIGUubWVzc2FnZSB8fCBlKSArICIpIikpOwogICAgc2hvd0Vycm9yQmFubmVyKCJyZW5kZXJXYXRjaGxpc3QgZmFpbGVkOiAiICsg",
  "KGUgJiYgZS5tZXNzYWdlIHx8IGUpKTsKICB9Cn0KCmZ1bmN0aW9uIHdhdGNoQ2FyZEhUTUwocyxpKXsKICBjb25zdCBwb3MgPSBzLnBjdD49MDsKICByZXR1cm4gYAogIDxkaXYgY2xhc3M9ImdsYXNzIHdhdGNoLWNhcmQgZW50ZXJpbmciIGRhdGEtdGlja2VyPSIk",
  "e3MudH0iIHN0eWxlPSJhbmltYXRpb24tZGVsYXk6JHtpKjQwfW1zIj4KICAgIDxkaXYgY2xhc3M9IndhdGNoLXRvcCI+CiAgICAgIDxkaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY29tcGFueS1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAg",
  "ICA8ZGl2IGNsYXNzPSJjb21wYW55LXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofTwvZGl2PgogICAgICA8L2Rpdj4KICAgICAgPGJ1dHRvbiBjbGFzcz0ic3Rhci1idG4gYWN0aXZlIiBkYXRhLXVuc3Rhcj0iJHtzLnR9IiB0aXRsZT0iUmVtb3ZlIj4KICAgICAgICA8",
  "c3ZnIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0iY3VycmVudENvbG9yIiBzdHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIj48cGF0aCBkPSJNMTIgMTcuM2wtNi4xNiAzLjYgMS42NC02LjlMMiA5LjRsNy4wNi0uNkwxMiAyLjRsMi45NCA2LjQg",
  "Ny4wNi42LTUuNDggNC42IDEuNjQgNi45eiIvPjwvc3ZnPgogICAgICA8L2J1dHRvbj4KICAgIDwvZGl2PgogICAgPGRpdiBjbGFzcz0iaW5kZXgtdmFsdWUgdGFidWxhciIgc3R5bGU9ImZvbnQtc2l6ZToyMnB4OyI+JHtmbXRJTlIocy5wcmljZSl9PC9kaXY+CiAg",
  "ICA8ZGl2IGNsYXNzPSJpbmRleC1jaGFuZ2UgJHtwb3M/J3Bvcyc6J25lZyd9IHRhYnVsYXIiPiR7Y2hnU3RyKHMuY2hhbmdlKX0gKCR7cGN0U3RyKHMucGN0KX0pPC9kaXY+CiAgICA8ZGl2IGNsYXNzPSJpbmRleC1zcGFyayI+JHtzcGFya2xpbmVTVkcocy5zZXJp",
  "ZXMsIHBvcyl9PC9kaXY+CiAgPC9kaXY+YDsKfQoKZnVuY3Rpb24gd2lyZVdhdGNoQ2FyZHMoKXsKICBkb2N1bWVudC5xdWVyeVNlbGVjdG9yQWxsKCIud2F0Y2gtY2FyZCIpLmZvckVhY2goY2FyZD0+ewogICAgY2FyZC5hZGRFdmVudExpc3RlbmVyKCJjbGljayIs",
  "IChlKT0+ewogICAgICBpZihlLnRhcmdldC5jbG9zZXN0KCJbZGF0YS11bnN0YXJdIikpIHJldHVybjsKICAgICAgbmF2aWdhdGUoImRldGFpbCIsIGNhcmQuZGF0YXNldC50aWNrZXIpOwogICAgfSk7CiAgfSk7CiAgZG9jdW1lbnQucXVlcnlTZWxlY3RvckFsbCgi",
  "W2RhdGEtdW5zdGFyXSIpLmZvckVhY2goYnRuPT57CiAgICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgICAgZS5zdG9wUHJvcGFnYXRpb24oKTsKICAgICAgY29uc3QgY2FyZCA9IGJ0bi5jbG9zZXN0KCIud2F0Y2gtY2FyZCIpOwogICAg",
  "ICBjYXJkLmNsYXNzTGlzdC5hZGQoInJlbW92aW5nIik7CiAgICAgIHRvZ2dsZVdhdGNoKGJ0bi5kYXRhc2V0LnVuc3Rhcik7CiAgICAgIHNldFRpbWVvdXQoKCk9PnsKICAgICAgICBpZighc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCkgcmVuZGVyV2F0Y2hsaXN0KCk7",
  "CiAgICAgICAgZWxzZSBjYXJkLnJlbW92ZSgpOwogICAgICAgIGNvbnN0IHN1YkVsID0gZG9jdW1lbnQucXVlcnlTZWxlY3RvcigiLnNlY3Rpb24taGVhZCAuc3ViIik7CiAgICAgICAgaWYoc3ViRWwpIHN1YkVsLnRleHRDb250ZW50ID0gYCR7c3RhdGUud2F0Y2hs",
  "aXN0Lmxlbmd0aH0gc3RvY2ske3N0YXRlLndhdGNobGlzdC5sZW5ndGg9PT0xPycnOidzJ30gdHJhY2tlZGA7CiAgICAgIH0sIDI4MCk7CiAgICB9KTsKICB9KTsKfQoKLyogLS0tLS0tLS0tLS0tLS0tLSBTVE9DSyBERVRBSUwgLS0tLS0tLS0tLS0tLS0tLSAqLwph",
  "c3luYyBmdW5jdGlvbiByZW5kZXJEZXRhaWwoKXsKICByb290LmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ2aWV3IiBpZD0iZGV0YWlsU2tlbGV0b24iPgogICAgPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwiIHN0eWxlPSJoZWlnaHQ6ODhweDttYXJn",
  "aW4tYm90dG9tOjI0cHg7Ij48L2Rpdj4KICAgIDxkaXYgY2xhc3M9Im1ldHJpY3MtZ3JpZCI+JHtza2VsZXRvbkNhcmRzKDYpfTwvZGl2PgogICAgPGRpdiBjbGFzcz0iZ2xhc3Mgc2tlbC1jYXJkIHNrZWwiIHN0eWxlPSJoZWlnaHQ6MzIwcHg7Ij48L2Rpdj4KICA8",
  "L2Rpdj5gOwoKICBjb25zdCByZXF1ZXN0ZWRUaWNrZXIgPSBzdGF0ZS5kZXRhaWxUaWNrZXI7CiAgbGV0IHM7CiAgdHJ5eyBzID0gYXdhaXQgQVBJLmZldGNoU3RvY2socmVxdWVzdGVkVGlja2VyKTsgfWNhdGNoKGUpeyBzID0gbnVsbDsgfQogIC8vIEJhaWwgaWYg",
  "dGhlIHVzZXIgbmF2aWdhdGVkIGF3YXksIG9yIHRvIGEgZGlmZmVyZW50IHN0b2NrLCB3aGlsZSB0aGlzIHdhcyBpbiBmbGlnaHQuCiAgaWYoc3RhdGUudmlldyAhPT0gImRldGFpbCIgfHwgc3RhdGUuZGV0YWlsVGlja2VyICE9PSByZXF1ZXN0ZWRUaWNrZXIpIHJl",
  "dHVybjsKICBpZighcyl7CiAgICByb290LmlubmVySFRNTCA9IGVycm9yU3RhdGVIVE1MKCJVbmFibGUgdG8gcmV0cmlldmUgdGhpcyBzdG9jayIsICJUaGUgdGlja2VyIHlvdSdyZSBsb29raW5nIGZvciBpc24ndCBhdmFpbGFibGUgcmlnaHQgbm93LiIpOwogICAg",
  "cmV0dXJuOwogIH0KICBjb25zdCBwb3MgPSBzLnBjdCA+PSAwOwogIGNvbnN0IGluV2F0Y2ggPSBzdGF0ZS53YXRjaGxpc3QuaW5jbHVkZXMocy50KTsKCiAgcm9vdC5pbm5lckhUTUwgPSBgCiAgICA8ZGl2IGNsYXNzPSJ2aWV3Ij4KICAgICAgPGRpdiBjbGFzcz0i",
  "ZGV0YWlsLWhlYWQiPgogICAgICAgIDxkaXYgY2xhc3M9ImRldGFpbC10aXRsZS1yb3ciPgogICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXRpY2tlci1iYWRnZSI+JHtzLnQuc2xpY2UoMCwzKX08L2Rpdj4KICAgICAgICAgIDxkaXY+CiAgICAgICAgICAgIDxk",
  "aXYgY2xhc3M9ImRldGFpbC1uYW1lIj4ke2VzY2FwZUh0bWwocy5uYW1lKX08L2Rpdj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXN1YiI+JHtzLnR9IMK3ICR7cy5leGNofSDCtyAke3Muc2VjdG9yfTwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAg",
  "ICAgPC9kaXY+CiAgICAgICAgPGRpdiBzdHlsZT0iZGlzcGxheTpmbGV4O2FsaWduLWl0ZW1zOmNlbnRlcjtnYXA6MTRweDsiPgogICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXByaWNlLWJsb2NrIj4KICAgICAgICAgICAgPGRpdiBjbGFzcz0iZGV0YWlsLXBy",
  "aWNlIHRhYnVsYXIiPiR7cy5wcmljZSE9bnVsbCA/IGDigrk8c3BhbiBkYXRhLWNvdW50dXA9IiR7cy5wcmljZX0iIGRhdGEtZGVjaW1hbHM9IjIiPjA8L3NwYW4+YCA6ICLigJQifTwvZGl2PgogICAgICAgICAgICA8ZGl2IGNsYXNzPSJkZXRhaWwtY2hhbmdlICR7",
  "cG9zPydwb3MnOiduZWcnfSB0YWJ1bGFyIj4ke2NoZ1N0cihzLmNoYW5nZSl9ICgke3BjdFN0cihzLnBjdCl9KSB0b2RheTwvZGl2PgogICAgICAgICAgPC9kaXY+CiAgICAgICAgICA8YnV0dG9uIGNsYXNzPSJpY29uLWJ0biIgaWQ9ImRldGFpbFN0YXIiIHN0eWxl",
  "PSJ3aWR0aDo0NHB4O2hlaWdodDo0NHB4O2NvbG9yOiR7aW5XYXRjaD8nI0ZGQzg1Nyc6J3ZhcigtLXRleHQtbWlkKSd9Ij4KICAgICAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9IiR7aW5XYXRjaD8nY3VycmVudENvbG9yJzonbm9uZSd9IiBz",
  "dHJva2U9ImN1cnJlbnRDb2xvciIgc3Ryb2tlLXdpZHRoPSIyIiBzdHlsZT0id2lkdGg6MTlweDtoZWlnaHQ6MTlweDsiPjxwYXRoIGQ9Ik0xMiAxNy4zbC02LjE2IDMuNiAxLjY0LTYuOUwyIDkuNGw3LjA2LS42TDEyIDIuNGwyLjk0IDYuNCA3LjA2LjYtNS40OCA0",
  "LjYgMS42NCA2Ljl6Ii8+PC9zdmc+CiAgICAgICAgICA8L2J1dHRvbj4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IGNsYXNzPSJtZXRyaWNzLWdyaWQiPgogICAgICAgICR7bWV0cmljQ2FyZCgiT3BlbiIsIGZtdElOUihzLm9wZW4pKX0K",
  "ICAgICAgICAke21ldHJpY0NhcmQoIkRheSBIaWdoIiwgZm10SU5SKHMuZGF5SGlnaCkpfQogICAgICAgICR7bWV0cmljQ2FyZCgiRGF5IExvdyIsIGZtdElOUihzLmRheUxvdykpfQogICAgICAgICR7bWV0cmljQ2FyZCgiTWFya2V0IENhcCIsIGZtdENvbXBhY3Qo",
  "cy5tYXJrZXRDYXApKX0KICAgICAgICAke21ldHJpY0NhcmQoIlZvbHVtZSIsIGZtdFZvbChzLnZvbHVtZSkpfQogICAgICAgICR7bWV0cmljQ2FyZCgiNTJXIEhpZ2ggLyBMb3ciLCBmbXRJTlIocy5oaWdoNTIsMCkrIiAvICIrZm10SU5SKHMubG93NTIsMCkpfQog",
  "ICAgICA8L2Rpdj4KCiAgICAgIDxkaXYgY2xhc3M9ImdsYXNzIGNoYXJ0LWNhcmQiPgogICAgICAgIDxkaXYgY2xhc3M9ImNoYXJ0LWhlYWQiPgogICAgICAgICAgPGRpdiBjbGFzcz0ic2VjdGlvbi1oZWFkIiBzdHlsZT0ibWFyZ2luOjA7Ij48aDI+UHJpY2UgQ2hh",
  "cnQ8L2gyPjwvZGl2PgogICAgICAgICAgPGRpdiBjbGFzcz0icmFuZ2UtdGFicyIgaWQ9InJhbmdlVGFicyI+CiAgICAgICAgICAgICR7WyIxRCIsIjFXIiwiMU0iLCIzTSIsIjZNIiwiMVkiXS5tYXAocj0+YDxidXR0b24gZGF0YS1yYW5nZT0iJHtyfSIgY2xhc3M9",
  "IiR7c3RhdGUuZGV0YWlsUmFuZ2U9PT1yPydhY3RpdmUnOicnfSI+JHtyfTwvYnV0dG9uPmApLmpvaW4oIiIpfQogICAgICAgICAgPC9kaXY+CiAgICAgICAgPC9kaXY+CiAgICAgICAgPGRpdiBjbGFzcz0iY2hhcnQtY2FudmFzLXdyYXAiIGlkPSJjaGFydFdyYXAi",
  "PgogICAgICAgICAgPGNhbnZhcyBpZD0icHJpY2VDaGFydCI+PC9jYW52YXM+CiAgICAgICAgICA8ZGl2IGNsYXNzPSJjaGFydC10b29sdGlwIiBpZD0iY2hhcnRUb29sdGlwIj48L2Rpdj4KICAgICAgICA8L2Rpdj4KICAgICAgICA8ZGl2IGNsYXNzPSJ2b2x1bWUt",
  "d3JhcCIgaWQ9InZvbHVtZVdyYXAiPgogICAgICAgICAgPGRpdiBjbGFzcz0idm9sdW1lLWxhYmVsIj5Wb2x1bWUgPHNwYW4gc3R5bGU9ImNvbG9yOnZhcigtLXRleHQtZmFpbnQpO2ZvbnQtd2VpZ2h0OjYwMDsiPihyZWxhdGl2ZSwgZGVyaXZlZCBmcm9tIHByaWNl",
  "IG1vdmVtZW50KTwvc3Bhbj48L2Rpdj4KICAgICAgICAgIDxjYW52YXMgaWQ9InZvbHVtZUNoYXJ0Ij48L2NhbnZhcz4KICAgICAgICA8L2Rpdj4KICAgICAgPC9kaXY+CgogICAgICA8ZGl2IHN0eWxlPSJtYXJnaW4tYm90dG9tOjI4cHg7Ij4KICAgICAgICA8YnV0",
  "dG9uIGNsYXNzPSJleHBsYWluLWJ0biIgaWQ9ImV4cGxhaW5CdG4iPgogICAgICAgICAgPHN2ZyB2aWV3Qm94PSIwIDAgMjQgMjQiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIg",
  "c3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTEyIDhWNEg4Ii8+PHJlY3QgeD0iNCIgeT0iOCIgd2lkdGg9IjE2IiBoZWlnaHQ9IjEyIiByeD0iMiIvPjxwYXRoIGQ9Ik0yIDE0aDJNMjAgMTRoMk05IDEzdjJNMTUgMTN2MiIvPjwvc3ZnPgogICAgICAg",
  "ICAgRXhwbGFpbiB0aGlzIHN0b2NrCiAgICAgICAgPC9idXR0b24+CiAgICAgICAgPGRpdiBjbGFzcz0iZ2xhc3MgZXhwbGFpbi1jYXJkIiBpZD0iZXhwbGFpbkNhcmQiIHN0eWxlPSJkaXNwbGF5Om5vbmU7Ij48L2Rpdj4KICAgICAgPC9kaXY+CiAgICA8L2Rpdj4K",
  "ICBgOwoKICBydW5Db3VudFVwcyhyb290KTsKICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiZGV0YWlsU3RhciIpLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgKCk9PnsKICAgIHRvZ2dsZVdhdGNoKHMudCk7CiAgICByZW5kZXJEZXRhaWwoKTsKICB9KTsKICBk",
  "b2N1bWVudC5nZXRFbGVtZW50QnlJZCgicmFuZ2VUYWJzIikuYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCAoZSk9PnsKICAgIGNvbnN0IGJ0biA9IGUudGFyZ2V0LmNsb3Nlc3QoImJ1dHRvbltkYXRhLXJhbmdlXSIpOwogICAgaWYoIWJ0bikgcmV0dXJuOwogICAg",
  "c3RhdGUuZGV0YWlsUmFuZ2UgPSBidG4uZGF0YXNldC5yYW5nZTsKICAgIGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3JBbGwoIiNyYW5nZVRhYnMgYnV0dG9uIikuZm9yRWFjaChiPT5iLmNsYXNzTGlzdC50b2dnbGUoImFjdGl2ZSIsIGI9PT1idG4pKTsKICAgIGxvYWRD",
  "aGFydChzLnQsIHMucGN0Pj0wKTsKICB9KTsKICB3aXJlRXhwbGFpbkJ1dHRvbihzLnQpOwoKICBsb2FkQ2hhcnQocy50LCBwb3MpOwp9CgpmdW5jdGlvbiBtZXRyaWNDYXJkKGxhYmVsLCB2YWx1ZSl7CiAgcmV0dXJuIGA8ZGl2IGNsYXNzPSJnbGFzcyBtZXRyaWMt",
  "Y2FyZCI+PGRpdiBjbGFzcz0ibWV0cmljLWxhYmVsIj4ke2xhYmVsfTwvZGl2PjxkaXYgY2xhc3M9Im1ldHJpYy12YWx1ZSB0YWJ1bGFyIj4ke3ZhbHVlfTwvZGl2PjwvZGl2PmA7Cn0KCmFzeW5jIGZ1bmN0aW9uIGxvYWRDaGFydCh0aWNrZXIsIHBvc2l0aXZlKXsK",
  "ICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImNoYXJ0V3JhcCIpOwogIGNvbnN0IGNhbnZhcyA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJwcmljZUNoYXJ0Iik7CiAgaWYoIXdyYXAgfHwgIWNhbnZhcykgcmV0dXJuOwogIGNhbnZhcy5z",
  "dHlsZS5vcGFjaXR5ID0gIjAuMjUiOwogIGxldCBzZXJpZXM7CiAgdHJ5ewogICAgc2VyaWVzID0gYXdhaXQgQVBJLmZldGNoU3RvY2tIaXN0b3J5KHRpY2tlciwgc3RhdGUuZGV0YWlsUmFuZ2UpOwogIH1jYXRjaChlKXsKICAgIHdyYXAuaW5uZXJIVE1MID0gZXJy",
  "b3JTdGF0ZUhUTUwoIkNoYXJ0IGRhdGEgdW5hdmFpbGFibGUiLCAiVGhpcyB0aW1lZnJhbWUgY291bGRuJ3QgYmUgbG9hZGVkLiBUcnkgYSBkaWZmZXJlbnQgcmFuZ2UuIik7CiAgICByZXR1cm47CiAgfQogIGNhbnZhcy5zdHlsZS5vcGFjaXR5ID0gIjEiOwogIGRy",
  "YXdDaGFydChjYW52YXMsIHNlcmllcywgcG9zaXRpdmUsIHRpY2tlcik7CiAgZHJhd1ZvbHVtZUNoYXJ0KHNlcmllcywgcG9zaXRpdmUpOwp9CgpmdW5jdGlvbiBkcmF3Vm9sdW1lQ2hhcnQoc2VyaWVzLCBwb3NpdGl2ZSl7CiAgY29uc3QgY2FudmFzID0gZG9jdW1l",
  "bnQuZ2V0RWxlbWVudEJ5SWQoInZvbHVtZUNoYXJ0Iik7CiAgaWYoIWNhbnZhcykgcmV0dXJuOwogIGNvbnN0IHJlY3QgPSBjYW52YXMuZ2V0Qm91bmRpbmdDbGllbnRSZWN0KCk7CiAgY29uc3QgZHByID0gd2luZG93LmRldmljZVBpeGVsUmF0aW8gfHwgMTsKICBj",
  "YW52YXMud2lkdGggPSByZWN0LndpZHRoICogZHByOwogIGNhbnZhcy5oZWlnaHQgPSByZWN0LmhlaWdodCAqIGRwcjsKICBjb25zdCBjdHggPSBjYW52YXMuZ2V0Q29udGV4dCgiMmQiKTsKICBjdHguc2NhbGUoZHByLGRwcik7CiAgY29uc3QgVyA9IHJlY3Qud2lk",
  "dGgsIEggPSByZWN0LmhlaWdodDsKICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwoKICAvLyBEZXJpdmUgYSBwbGF1c2libGUgcmVsYXRpdmUgdm9sdW1lIHByb2ZpbGUgZnJvbSB0aGUgcHJpY2Ugc2VyaWVzJwogIC8vIHBvaW50LXRvLXBvaW50IHZvbGF0aWxpdHkg",
  "KGJpZ2dlciBtb3ZlcyB0ZW5kIHRvIGNvaW5jaWRlIHdpdGggaGlnaGVyCiAgLy8gdm9sdW1lKSDigJQgaWxsdXN0cmF0aXZlIG9ubHk7IHRoZSBiYWNrZW5kIGhhcyBubyBoaXN0b3JpY2FsIHZvbHVtZSBmZWVkLgogIGNvbnN0IGRlbHRhcyA9IHNlcmllcy5tYXAo",
  "KHYsaSk9PiBpPT09MCA/IDAgOiBNYXRoLmFicyh2LXNlcmllc1tpLTFdKSk7CiAgY29uc3QgbWF4RCA9IE1hdGgubWF4KC4uLmRlbHRhcywgMWUtNik7CiAgY29uc3QgYmFyVyA9IFcvc2VyaWVzLmxlbmd0aDsKICBjb25zdCBjb2xvciA9IHBvc2l0aXZlID8gIiMz",
  "M0Q2QTYiIDogIiNGQjZCNkIiOwogIHNlcmllcy5mb3JFYWNoKCh2LGkpPT57CiAgICBjb25zdCBzZWVkID0gdGlja2VyU2VlZChzdGF0ZS5kZXRhaWxUaWNrZXIpK2kqNzsKICAgIGNvbnN0IGggPSBNYXRoLm1heCgzLCAoZGVsdGFzW2ldL21heEQpICogSCAqIDAu",
  "ODUgKiAoMC41NSArIHNlZWRlZFJhbmQoc2VlZCkqMC42KSk7CiAgICBjb25zdCB1cCA9IGk9PT0wID8gdHJ1ZSA6IHNlcmllc1tpXSA+PSBzZXJpZXNbaS0xXTsKICAgIGN0eC5maWxsU3R5bGUgPSB1cCA/ICJyZ2JhKDUxLDIxNCwxNjYsMC41NSkiIDogInJnYmEo",
  "MjUxLDEwNywxMDcsMC41NSkiOwogICAgY3R4LmZpbGxSZWN0KGkqYmFyVytiYXJXKjAuMTUsIEgtaCwgTWF0aC5tYXgoMSxiYXJXKjAuNyksIGgpOwogIH0pOwp9CgpmdW5jdGlvbiBkcmF3Q2hhcnQoY2FudmFzLCBzZXJpZXMsIHBvc2l0aXZlLCB0aWNrZXIpewog",
  "IGNvbnN0IHdyYXAgPSBjYW52YXMucGFyZW50RWxlbWVudDsKICBjb25zdCBkcHIgPSB3aW5kb3cuZGV2aWNlUGl4ZWxSYXRpbyB8fCAxOwogIGNvbnN0IHJlY3QgPSB3cmFwLmdldEJvdW5kaW5nQ2xpZW50UmVjdCgpOwogIGNhbnZhcy53aWR0aCA9IHJlY3Qud2lk",
  "dGggKiBkcHI7CiAgY2FudmFzLmhlaWdodCA9IHJlY3QuaGVpZ2h0ICogZHByOwogIGNhbnZhcy5zdHlsZS53aWR0aCA9IHJlY3Qud2lkdGgrInB4IjsKICBjYW52YXMuc3R5bGUuaGVpZ2h0ID0gcmVjdC5oZWlnaHQrInB4IjsKICBjb25zdCBjdHggPSBjYW52YXMu",
  "Z2V0Q29udGV4dCgiMmQiKTsKICBjdHguc2NhbGUoZHByLGRwcik7CgogIGNvbnN0IFcgPSByZWN0LndpZHRoLCBIID0gcmVjdC5oZWlnaHQ7CiAgY29uc3QgcGFkID0ge3RvcDoxNiwgcmlnaHQ6OCwgYm90dG9tOjI0LCBsZWZ0Ojh9OwogIGNvbnN0IG1pbiA9IE1h",
  "dGgubWluKC4uLnNlcmllcyksIG1heCA9IE1hdGgubWF4KC4uLnNlcmllcyk7CiAgY29uc3QgcmFuZ2VWID0gKG1heC1taW4pIHx8IDE7CiAgY29uc3QgaW5uZXJXID0gVyAtIHBhZC5sZWZ0IC0gcGFkLnJpZ2h0OwogIGNvbnN0IGlubmVySCA9IEggLSBwYWQudG9w",
  "IC0gcGFkLmJvdHRvbTsKICBjb25zdCBzdGVwID0gaW5uZXJXLyhzZXJpZXMubGVuZ3RoLTEpOwoKICBmdW5jdGlvbiB4eShpLHYpewogICAgcmV0dXJuIFtwYWQubGVmdCArIGkqc3RlcCwgcGFkLnRvcCArIGlubmVySCAtICgodi1taW4pL3JhbmdlVikqaW5uZXJI",
  "XTsKICB9CiAgY29uc3QgcHRzID0gc2VyaWVzLm1hcCgodixpKT0+eHkoaSx2KSk7CiAgY29uc3QgY29sb3IgPSBwb3NpdGl2ZSA/ICIjMzNENkE2IiA6ICIjRkI2QjZCIjsKCiAgZnVuY3Rpb24gc21vb3RoUGF0aChwb2ludHMpewogICAgaWYocG9pbnRzLmxlbmd0",
  "aDwzKSByZXR1cm4gYE0ke3BvaW50c1swXVswXX0sJHtwb2ludHNbMF1bMV19IEwke3BvaW50c1sxXVswXX0sJHtwb2ludHNbMV1bMV19YDsKICAgIGxldCBkID0gYE0ke3BvaW50c1swXVswXX0sJHtwb2ludHNbMF1bMV19YDsKICAgIGZvcihsZXQgaT0wO2k8cG9p",
  "bnRzLmxlbmd0aC0xO2krKyl7CiAgICAgIGNvbnN0IHAwID0gcG9pbnRzW2k9PT0wPzA6aS0xXTsKICAgICAgY29uc3QgcDEgPSBwb2ludHNbaV07CiAgICAgIGNvbnN0IHAyID0gcG9pbnRzW2krMV07CiAgICAgIGNvbnN0IHAzID0gcG9pbnRzW2krMjxwb2ludHMu",
  "bGVuZ3RoP2krMjppKzFdOwogICAgICBjb25zdCBjcDF4ID0gcDFbMF0gKyAocDJbMF0tcDBbMF0pLzY7CiAgICAgIGNvbnN0IGNwMXkgPSBwMVsxXSArIChwMlsxXS1wMFsxXSkvNjsKICAgICAgY29uc3QgY3AyeCA9IHAyWzBdIC0gKHAzWzBdLXAxWzBdKS82Owog",
  "ICAgICBjb25zdCBjcDJ5ID0gcDJbMV0gLSAocDNbMV0tcDFbMV0pLzY7CiAgICAgIGQgKz0gYCBDJHtjcDF4fSwke2NwMXl9ICR7Y3AyeH0sJHtjcDJ5fSAke3AyWzBdfSwke3AyWzFdfWA7CiAgICB9CiAgICByZXR1cm4gZDsKICB9CgogIGN0eC5jbGVhclJlY3Qo",
  "MCwwLFcsSCk7CiAgY2FudmFzLl9jaGFydE1ldGEgPSB7cHRzLCBzZXJpZXMsIFcsIEgsIHBhZCwgY29sb3J9OwoKICAvLyBFbnRyYW5jZTogdGhlIGxpbmUgZHJhd3MgaXRzZWxmIGxlZnQtdG8tcmlnaHQgdmlhIGEgZ3Jvd2luZyBjbGlwIHJlY3QsCiAgLy8gcmF0",
  "aGVyIHRoYW4ganVzdCBhcHBlYXJpbmcg4oCUIHRoaXMgaXMgdGhlIGNoYXJ0J3MgIndvdyIgbW9tZW50LgogIGlmKHByZWZlcnNSZWR1Y2VkTW90aW9uKXsKICAgIHJlZHJhdyhjdHgsIGNhbnZhcy5fY2hhcnRNZXRhKTsKICB9ZWxzZXsKICAgIGNvbnN0IHJldmVh",
  "bFN0YXJ0ID0gcGVyZm9ybWFuY2Uubm93KCk7CiAgICBjb25zdCByZXZlYWxEdXJhdGlvbiA9IDcwMDsKICAgIChmdW5jdGlvbiByZXZlYWxUaWNrKG5vdyl7CiAgICAgIGNvbnN0IHQgPSBNYXRoLm1pbigxLCAobm93LXJldmVhbFN0YXJ0KS9yZXZlYWxEdXJhdGlv",
  "bik7CiAgICAgIGNvbnN0IGVhc2VkID0gMSAtIE1hdGgucG93KDEtdCwgMyk7CiAgICAgIGNvbnN0IGNsaXBXID0gcGFkLmxlZnQgKyBpbm5lclcqZWFzZWQ7CiAgICAgIGN0eC5zYXZlKCk7CiAgICAgIGN0eC5iZWdpblBhdGgoKTsKICAgICAgY3R4LnJlY3QoMCwg",
  "MCwgY2xpcFcsIEgpOwogICAgICBjdHguY2xpcCgpOwogICAgICByZWRyYXcoY3R4LCBjYW52YXMuX2NoYXJ0TWV0YSk7CiAgICAgIGN0eC5yZXN0b3JlKCk7CiAgICAgIGlmKHQ8MSkgcmVxdWVzdEFuaW1hdGlvbkZyYW1lKHJldmVhbFRpY2spOwogICAgfSkocGVy",
  "Zm9ybWFuY2Uubm93KCkpOwogIH0KCiAgLy8gY3Jvc3NoYWlyIGludGVyYWN0aXZpdHkKICBjb25zdCB0b29sdGlwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImNoYXJ0VG9vbHRpcCIpOwogIGNhbnZhcy5vbm1vdXNlbW92ZSA9IChlKT0+ewogICAgY29uc3Qg",
  "ciA9IGNhbnZhcy5nZXRCb3VuZGluZ0NsaWVudFJlY3QoKTsKICAgIGNvbnN0IG14ID0gZS5jbGllbnRYIC0gci5sZWZ0OwogICAgbGV0IGlkeCA9IE1hdGgucm91bmQoKG14LXBhZC5sZWZ0KS9zdGVwKTsKICAgIGlkeCA9IE1hdGgubWF4KDAsIE1hdGgubWluKHNl",
  "cmllcy5sZW5ndGgtMSwgaWR4KSk7CiAgICBjb25zdCBbcHgscHldID0gcHRzW2lkeF07CgogICAgcmVkcmF3V2l0aENyb3NzaGFpcihjdHgsIGNhbnZhcy5fY2hhcnRNZXRhLCBweCwgcHkpOwoKICAgIHRvb2x0aXAuc3R5bGUub3BhY2l0eSA9ICIxIjsKICAgIHRv",
  "b2x0aXAuc3R5bGUubGVmdCA9IHB4KyJweCI7CiAgICB0b29sdGlwLnN0eWxlLnRvcCA9IHB5KyJweCI7CiAgICB0b29sdGlwLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJ0dC1wcmljZSI+JHtmbXRJTlIoc2VyaWVzW2lkeF0pfTwvZGl2PjxkaXYgY2xhc3M9InR0",
  "LWRhdGUiPlBvaW50ICR7aWR4KzF9IG9mICR7c2VyaWVzLmxlbmd0aH08L2Rpdj5gOwogIH07CiAgY2FudmFzLm9ubW91c2VsZWF2ZSA9ICgpPT57CiAgICB0b29sdGlwLnN0eWxlLm9wYWNpdHkgPSAiMCI7CiAgICBjdHguY2xlYXJSZWN0KDAsMCxXLEgpOwogICAg",
  "cmVkcmF3KGN0eCwgY2FudmFzLl9jaGFydE1ldGEpOwogIH07CgogIGZ1bmN0aW9uIHJlZHJhdyhjdHgsIG1ldGEpewogICAgY29uc3Qge3B0cywgVywgSCwgcGFkLCBjb2xvcn0gPSBtZXRhOwogICAgY3R4LmNsZWFyUmVjdCgwLDAsVyxIKTsKICAgIGN0eC5zdHJv",
  "a2VTdHlsZSA9ICJyZ2JhKDE1OCwxNzEsMjE0LDAuMDgpIjsKICAgIGN0eC5saW5lV2lkdGggPSAxOwogICAgY29uc3QgaW5uZXJIMiA9IEgtcGFkLnRvcC1wYWQuYm90dG9tOwogICAgZm9yKGxldCBpPTA7aTw9MztpKyspewogICAgICBjb25zdCB5ID0gcGFkLnRv",
  "cCArIChpbm5lckgyLzMpKmk7CiAgICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4Lm1vdmVUbyhwYWQubGVmdCx5KTsgY3R4LmxpbmVUbyhXLXBhZC5yaWdodCx5KTsgY3R4LnN0cm9rZSgpOwogICAgfQogICAgY29uc3QgZ3JhZDIgPSBjdHguY3JlYXRlTGluZWFyR3Jh",
  "ZGllbnQoMCxwYWQudG9wLDAscGFkLnRvcCtpbm5lckgyKTsKICAgIGdyYWQyLmFkZENvbG9yU3RvcCgwLCBjb2xvcisiNTUiKTsgZ3JhZDIuYWRkQ29sb3JTdG9wKDEsIGNvbG9yKyIwMiIpOwogICAgY29uc3QgYXJlYVBhdGgyID0gbmV3IFBhdGgyRChzbW9vdGhQ",
  "YXRoKHB0cykpOwogICAgYXJlYVBhdGgyLmxpbmVUbyhwdHNbcHRzLmxlbmd0aC0xXVswXSwgcGFkLnRvcCtpbm5lckgyKTsKICAgIGFyZWFQYXRoMi5saW5lVG8ocHRzWzBdWzBdLCBwYWQudG9wK2lubmVySDIpOwogICAgYXJlYVBhdGgyLmNsb3NlUGF0aCgpOwog",
  "ICAgY3R4LmZpbGxTdHlsZSA9IGdyYWQyOyBjdHguZmlsbChhcmVhUGF0aDIpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gY29sb3I7IGN0eC5saW5lV2lkdGggPSAyOyBjdHgubGluZUpvaW49InJvdW5kIjsgY3R4LmxpbmVDYXA9InJvdW5kIjsKICAgIGN0eC5zdHJv",
  "a2UobmV3IFBhdGgyRChzbW9vdGhQYXRoKHB0cykpKTsKICB9CiAgZnVuY3Rpb24gcmVkcmF3V2l0aENyb3NzaGFpcihjdHgsIG1ldGEsIHB4LCBweSl7CiAgICByZWRyYXcoY3R4LCBtZXRhKTsKICAgIGNvbnN0IHtILCBwYWQsIGNvbG9yfSA9IG1ldGE7CiAgICBj",
  "dHguc2F2ZSgpOwogICAgY3R4LnN0cm9rZVN0eWxlID0gInJnYmEoMTU4LDE3MSwyMTQsMC4zNSkiOwogICAgY3R4LmxpbmVXaWR0aCA9IDE7CiAgICBjdHguc2V0TGluZURhc2goWzMsM10pOwogICAgY3R4LmJlZ2luUGF0aCgpOyBjdHgubW92ZVRvKHB4LCBwYWQu",
  "dG9wKTsgY3R4LmxpbmVUbyhweCwgSC1wYWQuYm90dG9tKTsgY3R4LnN0cm9rZSgpOwogICAgY3R4LnNldExpbmVEYXNoKFtdKTsKICAgIGN0eC5iZWdpblBhdGgoKTsgY3R4LmFyYyhweCxweSw0LDAsTWF0aC5QSSoyKTsKICAgIGN0eC5maWxsU3R5bGUgPSBjb2xv",
  "cjsgY3R4LmZpbGwoKTsKICAgIGN0eC5zdHJva2VTdHlsZSA9ICIjMDUwNjBCIjsgY3R4LmxpbmVXaWR0aD0yOyBjdHguc3Ryb2tlKCk7CiAgICBjdHgucmVzdG9yZSgpOwogIH0KfQoKd2luZG93LmFkZEV2ZW50TGlzdGVuZXIoInJlc2l6ZSIsIGRlYm91bmNlKCgp",
  "PT57CiAgY29uc3QgY2FudmFzID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoInByaWNlQ2hhcnQiKTsKICBpZihjYW52YXMgJiYgc3RhdGUudmlldz09PSJkZXRhaWwiKSBsb2FkQ2hhcnQoc3RhdGUuZGV0YWlsVGlja2VyLCB0cnVlKTsKfSwgMjAwKSk7CgovKiAt",
  "LS0tLS0tLS0tLS0tLS0tIFNUQVRFIEhFTFBFUlMgLS0tLS0tLS0tLS0tLS0tLSAqLwpmdW5jdGlvbiBlbXB0eVN0YXRlSW5uZXIodGl0bGUsIHN1Yil7CiAgcmV0dXJuIGAKICAgIDxkaXYgY2xhc3M9InN0YXRlLWljb24iPjxzdmcgdmlld0JveD0iMCAwIDI0IDI0",
  "IiB3aWR0aD0iMjIiIGhlaWdodD0iMjIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxjaXJjbGUgY3g9IjExIiBjeT0iMTEiIHI9IjciLz48cGF0aCBkPSJNMjEgMjFsLTQuMy00LjMiLz48L3N2Zz48L2Rpdj4KICAg",
  "IDxkaXYgY2xhc3M9InN0YXRlLXRpdGxlIj4ke3RpdGxlfTwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtc3ViIj4ke3N1Yn08L2Rpdj4KICBgOwp9CmZ1bmN0aW9uIGVtcHR5U3RhdGVIVE1MKHRpdGxlLCBzdWIpewogIHJldHVybiBgPGRpdiBjbGFzcz0ic3Rh",
  "dGUtYm94Ij4ke2VtcHR5U3RhdGVJbm5lcih0aXRsZSwgc3ViKX08L2Rpdj5gOwp9CmZ1bmN0aW9uIGVycm9yU3RhdGVIVE1MKHRpdGxlLCBzdWIpewogIHJldHVybiBgPGRpdiBjbGFzcz0ic3RhdGUtYm94Ij4KICAgIDxkaXYgY2xhc3M9InN0YXRlLWljb24iPjxz",
  "dmcgdmlld0JveD0iMCAwIDI0IDI0IiB3aWR0aD0iMjIiIGhlaWdodD0iMjIiIGZpbGw9Im5vbmUiIHN0cm9rZT0iY3VycmVudENvbG9yIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiA5djRNMTIgMTdoLjAxTTEwLjI5IDMuODZMMS44MiAxOGEyIDIgMCAw",
  "MDEuNzEgM2gxNi45NGEyIDIgMCAwMDEuNzEtM0wxMy43MSAzLjg2YTIgMiAwIDAwLTMuNDIgMHoiLz48L3N2Zz48L2Rpdj4KICAgIDxkaXYgY2xhc3M9InN0YXRlLXRpdGxlIj4ke3RpdGxlfTwvZGl2PgogICAgPGRpdiBjbGFzcz0ic3RhdGUtc3ViIj4ke3N1Yn08",
  "L2Rpdj4KICA8L2Rpdj5gOwp9CgovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEJPT1QKICAgPT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09",
  "PT09PT09PT09PT09PSAqLwovKiA9PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09CiAgIEFJIEFTU0lTVEFOVCDigJQgY2hhdCBwYW5lbCArIHBlci1zdG9jayBleHBsYWluCiAgID09PT09PT09PT09",
  "PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT09PT0gKi8KY29uc3QgYWlTdGF0ZSA9IHsgb3BlbjogZmFsc2UsIGhpc3Rvcnk6IFtdLCBjb25maWd1cmVkOiBudWxsLCBidXN5OiBmYWxzZSB9OwoKZnVuY3Rpb24gYWlTZXRT",
  "dGF0dXNMaW5lKHRleHQpewogIGNvbnN0IGVsID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpU3RhdHVzTGluZSIpOwogIGlmKGVsKSBlbC50ZXh0Q29udGVudCA9IHRleHQ7Cn0KCmFzeW5jIGZ1bmN0aW9uIGNoZWNrQWlTdGF0dXMoKXsKICB0cnl7CiAgICBj",
  "b25zdCByID0gYXdhaXQgZmV0Y2hXaXRoVGltZW91dChDT05GSUcuQVBJX0JBU0UgKyAiL2FpL3N0YXR1cyIsIENPTkZJRy5MSVZFX1RJTUVPVVRfTVMpOwogICAgaWYoIXIub2spIHRocm93IG5ldyBFcnJvcigiYmFkIHN0YXR1cyIpOwogICAgY29uc3QganNvbiA9",
  "IGF3YWl0IHIuanNvbigpOwogICAgYWlTdGF0ZS5jb25maWd1cmVkID0gISFqc29uLmNvbmZpZ3VyZWQ7CiAgICBhaVNldFN0YXR1c0xpbmUoYWlTdGF0ZS5jb25maWd1cmVkID8gIlJlYWR5IiA6ICJOb3QgY29uZmlndXJlZCBvbiBzZXJ2ZXIiKTsKICB9Y2F0Y2go",
  "ZSl7CiAgICBhaVN0YXRlLmNvbmZpZ3VyZWQgPSBmYWxzZTsKICAgIGFpU2V0U3RhdHVzTGluZShsaXZlQmFja2VuZEF2YWlsYWJsZSA/ICJVbmF2YWlsYWJsZSIgOiAiQmFja2VuZCBub3QgY29ubmVjdGVkIik7CiAgfQp9Cgphc3luYyBmdW5jdGlvbiBidWlsZEFp",
  "Q29udGV4dCgpewogIC8vIFJlYWwgbWFya2V0IHNuYXBzaG90IHNvIHRoZSBhc3Npc3RhbnQgY2FuIGFuc3dlciBnZW5lcmFsIHF1ZXN0aW9ucwogIC8vICgid2hvIGFyZSB0aGUgZ2FpbmVycyIsICJob3cncyBteSB3YXRjaGxpc3QgZG9pbmciKSBub3QganVzdCBx",
  "dWVzdGlvbnMKICAvLyBhYm91dCB3aGF0ZXZlciBzaW5nbGUgc3RvY2sgaGFwcGVucyB0byBiZSBvbiBzY3JlZW4uIFJldXNlcyB0aGUgc2FtZQogIC8vIGNhY2hlZC9zaGFyZWQgZmV0Y2ggdGhlIHJlc3Qgb2YgdGhlIGFwcCB1c2VzLCBzbyB0aGlzIGRvZXNuJ3Qg",
  "Y29zdCBhbnkKICAvLyBleHRyYSBOU0UgY2FsbHMgd2hlbiB0aGUgY2FjaGUgaXMgYWxyZWFkeSB3YXJtLgogIGNvbnN0IGN0eCA9IHsgdmlldzogc3RhdGUudmlldyB9OwogIHRyeXsKICAgIGNvbnN0IGxpc3QgPSBhd2FpdCBBUEkuZmV0Y2hTY3JlZW5lclJlc3Vs",
  "dHMoe30pOwogICAgY29uc3QgY29tcGFjdCA9IGxpc3QubWFwKHM9Pih7dGlja2VyOnMudCwgbmFtZTpzLm5hbWUsIHByaWNlOnMucHJpY2UsIGNoYW5nZVBjdDpzLnBjdCwgc2VjdG9yOnMuc2VjdG9yfSkpOwogICAgY29uc3QgYnlTaXplID0gbGlzdC5zbGljZSgp",
  "LnNvcnQoKGEsYik9PmIucGN0LWEucGN0KTsKICAgIGN0eC5tYXJrZXQgPSB7CiAgICAgIGFzT2Y6IG5ldyBEYXRlKCkudG9JU09TdHJpbmcoKSwKICAgICAgc3RvY2tzOiBjb21wYWN0LAogICAgICB0b3BHYWluZXJzOiBieVNpemUuc2xpY2UoMCw1KS5tYXAocz0+",
  "KHt0aWNrZXI6cy50LCBjaGFuZ2VQY3Q6cy5wY3QsIHByaWNlOnMucHJpY2V9KSksCiAgICAgIHRvcExvc2VyczogYnlTaXplLnNsaWNlKC01KS5yZXZlcnNlKCkubWFwKHM9Pih7dGlja2VyOnMudCwgY2hhbmdlUGN0OnMucGN0LCBwcmljZTpzLnByaWNlfSkpLAog",
  "ICAgfTsKICB9Y2F0Y2goZSl7CiAgICBjdHgubWFya2V0RGF0YUVycm9yID0gIkNvdWxkIG5vdCBsb2FkIGN1cnJlbnQgbWFya2V0IGRhdGEuIjsKICB9CiAgaWYoc3RhdGUudmlldyA9PT0gImRldGFpbCIpIGN0eC5jdXJyZW50bHlWaWV3aW5nU3RvY2sgPSBzdGF0",
  "ZS5kZXRhaWxUaWNrZXI7CiAgaWYoc3RhdGUud2F0Y2hsaXN0Lmxlbmd0aCkgY3R4LndhdGNobGlzdFRpY2tlcnMgPSBzdGF0ZS53YXRjaGxpc3Quc2xpY2UoMCwgMTApOwogIHJldHVybiBjdHg7Cn0KCmZ1bmN0aW9uIGFwcGVuZEFpTWVzc2FnZShyb2xlLCB0ZXh0",
  "LCBleHRyYUNsYXNzKXsKICBjb25zdCB3cmFwID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpTWVzc2FnZXMiKTsKICBpZighd3JhcCkgcmV0dXJuIG51bGw7CiAgY29uc3QgZGl2ID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgiZGl2Iik7CiAgZGl2LmNsYXNz",
  "TmFtZSA9ICJhaS1tc2cgIiArIHJvbGUgKyAoZXh0cmFDbGFzcyA/ICIgIiArIGV4dHJhQ2xhc3MgOiAiIik7CiAgZGl2LnRleHRDb250ZW50ID0gdGV4dDsKICB3cmFwLmFwcGVuZENoaWxkKGRpdik7CiAgd3JhcC5zY3JvbGxUb3AgPSB3cmFwLnNjcm9sbEhlaWdo",
  "dDsKICByZXR1cm4gZGl2Owp9Cgphc3luYyBmdW5jdGlvbiBzZW5kQWlNZXNzYWdlKHF1ZXN0aW9uKXsKICBpZighcXVlc3Rpb24udHJpbSgpIHx8IGFpU3RhdGUuYnVzeSkgcmV0dXJuOwogIGFwcGVuZEFpTWVzc2FnZSgidXNlciIsIHF1ZXN0aW9uKTsKICBhaVN0",
  "YXRlLmJ1c3kgPSB0cnVlOwogIGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVNlbmRCdG4iKS5kaXNhYmxlZCA9IHRydWU7CiAgY29uc3QgcGVuZGluZyA9IGFwcGVuZEFpTWVzc2FnZSgiYXNzaXN0YW50IiwgIlRoaW5raW5n4oCmIiwgInBlbmRpbmciKTsKCiAg",
  "dHJ5ewogICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSBhd2FpdCBjaGVja0xpdmVCYWNrZW5kKCk7IC8vIG1heSBqdXN0IGJlIHdha2luZyBmcm9tIGEgY29sZCBzdGFydAogICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSB0aHJvdyBuZXcgRXJyb3IoIkJh",
  "Y2tlbmQgbm90IGNvbm5lY3RlZCDigJQgdGhlIEFJIGFzc2lzdGFudCBuZWVkcyB0aGUgbGl2ZSBiYWNrZW5kIHJ1bm5pbmcuIElmIGl0IHdhcyBqdXN0IGlkbGUsIHRyeSBhZ2FpbiBpbiBhIG1vbWVudC4iKTsKICAgIGNvbnN0IGN0cmwgPSBuZXcgQWJvcnRDb250",
  "cm9sbGVyKCk7CiAgICBjb25zdCBpZCA9IHNldFRpbWVvdXQoKCk9PmN0cmwuYWJvcnQoKSwgMjAwMDApOwogICAgY29uc3QgcmVzID0gYXdhaXQgZmV0Y2goQ09ORklHLkFQSV9CQVNFICsgIi9jaGF0IiwgewogICAgICBtZXRob2Q6ICJQT1NUIiwKICAgICAgaGVh",
  "ZGVyczogeyJDb250ZW50LVR5cGUiOiAiYXBwbGljYXRpb24vanNvbiJ9LAogICAgICBib2R5OiBKU09OLnN0cmluZ2lmeSh7CiAgICAgICAgcXVlc3Rpb246IHF1ZXN0aW9uLnRyaW0oKSwKICAgICAgICBjb250ZXh0OiBhd2FpdCBidWlsZEFpQ29udGV4dCgpLAog",
  "ICAgICAgIGhpc3Rvcnk6IGFpU3RhdGUuaGlzdG9yeS5zbGljZSgtNiksCiAgICAgIH0pLAogICAgICBzaWduYWw6IGN0cmwuc2lnbmFsLAogICAgfSkuZmluYWxseSgoKT0+Y2xlYXJUaW1lb3V0KGlkKSk7CgogICAgY29uc3QganNvbiA9IGF3YWl0IHJlcy5qc29u",
  "KCk7CiAgICBpZighcmVzLm9rIHx8ICFqc29uLnN1Y2Nlc3MpIHRocm93IG5ldyBFcnJvcigoanNvbi5lcnJvciAmJiBqc29uLmVycm9yLm1lc3NhZ2UpIHx8ICgiUmVxdWVzdCBmYWlsZWQgKCIgKyByZXMuc3RhdHVzICsgIikiKSk7CgogICAgcGVuZGluZy5yZW1v",
  "dmUoKTsKICAgIGFwcGVuZEFpTWVzc2FnZSgiYXNzaXN0YW50IiwganNvbi5kYXRhLmFuc3dlcik7CiAgICBhaVN0YXRlLmhpc3RvcnkucHVzaCh7cm9sZToidXNlciIsIGNvbnRlbnQ6IHF1ZXN0aW9uLnRyaW0oKX0pOwogICAgYWlTdGF0ZS5oaXN0b3J5LnB1c2go",
  "e3JvbGU6ImFzc2lzdGFudCIsIGNvbnRlbnQ6IGpzb24uZGF0YS5hbnN3ZXJ9KTsKICB9Y2F0Y2goZSl7CiAgICBwZW5kaW5nLnJlbW92ZSgpOwogICAgYXBwZW5kQWlNZXNzYWdlKCJhc3Npc3RhbnQiLCAiQ291bGRuJ3QgZ2V0IGEgcmVzcG9uc2U6ICIgKyAoZSAm",
  "JiBlLm1lc3NhZ2UgfHwgZSksICJlcnJvciIpOwogIH1maW5hbGx5ewogICAgYWlTdGF0ZS5idXN5ID0gZmFsc2U7CiAgICBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlTZW5kQnRuIikuZGlzYWJsZWQgPSBmYWxzZTsKICB9Cn0KCmZ1bmN0aW9uIHdpcmVBaVBh",
  "bmVsKCl7CiAgY29uc3QgZmFiID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQoImFpRmFiIik7CiAgY29uc3QgcGFuZWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCgiYWlQYW5lbCIpOwogIGNvbnN0IGNsb3NlQnRuID0gZG9jdW1lbnQuZ2V0RWxlbWVudEJ5SWQo",
  "ImFpQ2xvc2VCdG4iKTsKICBjb25zdCBpbnB1dCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaUlucHV0Iik7CiAgY29uc3Qgc2VuZEJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJhaVNlbmRCdG4iKTsKCiAgcGFuZWwuY2xhc3NMaXN0LmFkZCgiaGlk",
  "ZGVuIik7CgogIGZhYi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICBhaVN0YXRlLm9wZW4gPSAhYWlTdGF0ZS5vcGVuOwogICAgcGFuZWwuY2xhc3NMaXN0LnRvZ2dsZSgiaGlkZGVuIiwgIWFpU3RhdGUub3Blbik7CiAgICBpZihhaVN0YXRlLm9w",
  "ZW4peyBjaGVja0FpU3RhdHVzKCk7IGlucHV0LmZvY3VzKCk7IH0KICB9KTsKICBjbG9zZUJ0bi5hZGRFdmVudExpc3RlbmVyKCJjbGljayIsICgpPT57CiAgICBhaVN0YXRlLm9wZW4gPSBmYWxzZTsKICAgIHBhbmVsLmNsYXNzTGlzdC5hZGQoImhpZGRlbiIpOwog",
  "IH0pOwogIGNvbnN0IHNlbmQgPSAoKT0+ewogICAgY29uc3QgcSA9IGlucHV0LnZhbHVlOwogICAgaW5wdXQudmFsdWUgPSAiIjsKICAgIHNlbmRBaU1lc3NhZ2UocSk7CiAgfTsKICBzZW5kQnRuLmFkZEV2ZW50TGlzdGVuZXIoImNsaWNrIiwgc2VuZCk7CiAgaW5w",
  "dXQuYWRkRXZlbnRMaXN0ZW5lcigia2V5ZG93biIsIChlKT0+eyBpZihlLmtleSA9PT0gIkVudGVyIikgc2VuZCgpOyB9KTsKfQoKLy8gIkV4cGxhaW4gdGhpcyBzdG9jayIg4oCUIGNhbGxlZCBmcm9tIHJlbmRlckRldGFpbCBvbmNlIHN0b2NrIGRhdGEgaXMgbG9h",
  "ZGVkLgphc3luYyBmdW5jdGlvbiB3aXJlRXhwbGFpbkJ1dHRvbih0aWNrZXIpewogIGNvbnN0IGJ0biA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJleHBsYWluQnRuIik7CiAgY29uc3QgY2FyZCA9IGRvY3VtZW50LmdldEVsZW1lbnRCeUlkKCJleHBsYWluQ2Fy",
  "ZCIpOwogIGlmKCFidG4pIHJldHVybjsKICBidG4uYWRkRXZlbnRMaXN0ZW5lcigiY2xpY2siLCBhc3luYyAoKT0+ewogICAgYnRuLmRpc2FibGVkID0gdHJ1ZTsKICAgIGJ0bi50ZXh0Q29udGVudCA9ICJUaGlua2luZ+KApiI7CiAgICBjYXJkLnN0eWxlLmRpc3Bs",
  "YXkgPSAiYmxvY2siOwogICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0iZXhwbGFpbi1oZWFkIj48ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTNweDsiPkFJIEV4cGxhbmF0",
  "aW9uPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iZXhwbGFpbi10ZXh0Ij4ke3NrZWxldG9uTGluZXMoMyl9PC9kaXY+YDsKICAgIHRyeXsKICAgICAgaWYoIWxpdmVCYWNrZW5kQXZhaWxhYmxlKSBhd2FpdCBjaGVja0xpdmVCYWNrZW5kKCk7IC8vIG1heSBqdXN0IGJl",
  "IHdha2luZyBmcm9tIGEgY29sZCBzdGFydAogICAgICBpZighbGl2ZUJhY2tlbmRBdmFpbGFibGUpIHRocm93IG5ldyBFcnJvcigiQmFja2VuZCBub3QgY29ubmVjdGVkLiBJZiBpdCB3YXMganVzdCBpZGxlLCB0cnkgYWdhaW4gaW4gYSBtb21lbnQuIik7CiAgICAg",
  "IGNvbnN0IHIgPSBhd2FpdCBmZXRjaFdpdGhUaW1lb3V0KGAke0NPTkZJRy5BUElfQkFTRX0vZXhwbGFpbi8ke2VuY29kZVVSSUNvbXBvbmVudCh0aWNrZXIpfWAsIDIwMDAwKTsKICAgICAgY29uc3QganNvbiA9IGF3YWl0IHIuanNvbigpOwogICAgICBpZighci5v",
  "ayB8fCAhanNvbi5zdWNjZXNzKSB0aHJvdyBuZXcgRXJyb3IoKGpzb24uZXJyb3IgJiYganNvbi5lcnJvci5tZXNzYWdlKSB8fCAoIlJlcXVlc3QgZmFpbGVkICgiICsgci5zdGF0dXMgKyAiKSIpKTsKICAgICAgY2FyZC5pbm5lckhUTUwgPSBgPGRpdiBjbGFzcz0i",
  "ZXhwbGFpbi1oZWFkIj48ZGl2IGNsYXNzPSJhaS1hdmF0YXIiPuKcpjwvZGl2PjxkaXYgc3R5bGU9ImZvbnQtd2VpZ2h0OjcwMDtmb250LXNpemU6MTNweDsiPkFJIEV4cGxhbmF0aW9uPC9kaXY+PC9kaXY+PGRpdiBjbGFzcz0iZXhwbGFpbi10ZXh0Ij4ke2VzY2Fw",
  "ZUh0bWwoanNvbi5kYXRhLmV4cGxhbmF0aW9uKX08L2Rpdj5gOwogICAgfWNhdGNoKGUpewogICAgICBjYXJkLmlubmVySFRNTCA9IGA8ZGl2IGNsYXNzPSJleHBsYWluLWhlYWQiPjxkaXYgY2xhc3M9ImFpLWF2YXRhciI+4pymPC9kaXY+PGRpdiBzdHlsZT0iZm9u",
  "dC13ZWlnaHQ6NzAwO2ZvbnQtc2l6ZToxM3B4OyI+QUkgRXhwbGFuYXRpb248L2Rpdj48L2Rpdj48ZGl2IGNsYXNzPSJleHBsYWluLXRleHQiIHN0eWxlPSJjb2xvcjp2YXIoLS1uZWctc29mdCk7Ij5Db3VsZG4ndCBnZW5lcmF0ZSBhbiBleHBsYW5hdGlvbjogJHtl",
  "c2NhcGVIdG1sKGUgJiYgZS5tZXNzYWdlIHx8IFN0cmluZyhlKSl9PC9kaXY+YDsKICAgIH1maW5hbGx5ewogICAgICBidG4uZGlzYWJsZWQgPSBmYWxzZTsKICAgICAgYnRuLnRleHRDb250ZW50ID0gIuKcpiBFeHBsYWluIHRoaXMgc3RvY2siOwogICAgfQogIH0p",
  "Owp9CgpzZXRBY3RpdmVOYXYoImRhc2hib2FyZCIpOwp3aXJlQWlQYW5lbCgpOwpjaGVja0xpdmVCYWNrZW5kKCkuZmluYWxseShyZW5kZXIpOwpzZXRJbnRlcnZhbChjaGVja0xpdmVCYWNrZW5kLCA0NTAwMCk7Cjwvc2NyaXB0Pgo8L2JvZHk+CjwvaHRtbD4K"
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
