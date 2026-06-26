const fs = require('fs');
const path = require('path');

const TRACKER_FILE = path.join(__dirname, 'spend_data.json');
const SPEND_LIMIT = 2.00;

// Claude Sonnet 4.6 pricing (per million tokens)
const PRICE_INPUT_PER_M = 3.00;
const PRICE_OUTPUT_PER_M = 15.00;

function load() {
  try {
    return JSON.parse(fs.readFileSync(TRACKER_FILE, 'utf8'));
  } catch {
    return { totalSpend: 0, callCount: 0, locked: false, history: [] };
  }
}

function save(data) {
  fs.writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
}

function isLocked() {
  return load().locked;
}

function getStatus() {
  const data = load();
  return {
    totalSpend: data.totalSpend,
    remaining: Math.max(0, SPEND_LIMIT - data.totalSpend),
    limit: SPEND_LIMIT,
    locked: data.locked,
    callCount: data.callCount,
    percentUsed: Math.min(100, (data.totalSpend / SPEND_LIMIT) * 100).toFixed(1)
  };
}

function recordUsage(inputTokens, outputTokens) {
  const cost = (inputTokens / 1_000_000) * PRICE_INPUT_PER_M +
               (outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M;

  const data = load();
  data.totalSpend = +(data.totalSpend + cost).toFixed(6);
  data.callCount += 1;
  data.history.push({
    at: new Date().toISOString(),
    inputTokens,
    outputTokens,
    cost: +cost.toFixed(6),
    runningTotal: data.totalSpend
  });

  if (data.totalSpend >= SPEND_LIMIT) {
    data.locked = true;
    console.warn(`⚠️  Claude spend limit $${SPEND_LIMIT} reached — locked until approved`);
  }

  save(data);
  return { cost, locked: data.locked, total: data.totalSpend };
}

function approve() {
  const data = load();
  data.locked = false;
  save(data);
  return getStatus();
}

module.exports = { isLocked, getStatus, recordUsage, approve, SPEND_LIMIT };
