/**
 * One-shot source patch for the RER site.
 * Doubles euro prices (display and the cents checkout reads).
 * Leaves hours, deliverable counts, revision rounds, and percentage
 * fees or discounts unchanged.
 *
 * Run from the project root, before `next build`:
 *   node p.mjs
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "out",
  "dist",
  "coverage",
  ".vercel",
]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const TEXT_EXT = new Set([...CODE_EXT, ".json", ".md", ".mdx", ".html"]);
const NUM = String.raw`(\d+(?:_\d+)*(?:\.\d+)?(?:[eE][+-]?\d+)?)`;
const VALUE_RE = new RegExp(
  String.raw`((?:["'][^"'\n]+["'])|(?:[A-Za-z_$][\w$]*))\s*:\s*${NUM}(?=\s*(?:[,}\n]|as\b|//))`,
  "g",
);

function parseNum(raw) {
  return Number(String(raw).replace(/_/g, ""));
}

function formatNum(value) {
  if (Number.isInteger(value)) return String(value);
  const rounded = Math.round(value * 100) / 100;
  return String(rounded);
}

function shouldSkipKey(raw) {
  const key = String(raw).replace(/^['"]|['"]$/g, "").toLowerCase();
  if (key.includes("percent")) return true;
  if (key.includes("hours")) return true;
  if (key.includes("minute")) return true;
  if (key.includes("months")) return true;
  if (key.includes("limit") && key !== "unlimited") return true;
  if (key.includes("count")) return true;
  if (
    ["bpm", "duration", "plays", "seed", "vat", "buffer", "priority", "tracks", "photos", "clips"].includes(
      key,
    )
  ) {
    return true;
  }
  if (key.includes("revision") && key !== "extrarevision") return true;
  return false;
}

function matchBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    if (c === "/" && n === "/") {
      i = text.indexOf("\n", i + 2);
      if (i < 0) return -1;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end < 0) return -1;
      i = end + 1;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipQuoted(text, start, quote) {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return text.length - 1;
}

function skipTemplate(text, start) {
  let depth = 0;
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
      continue;
    }
    if (text[i] === "`" && depth === 0) return i;
    if (text[i] === "$" && text[i + 1] === "{") {
      depth++;
      i++;
      continue;
    }
    if (text[i] === "}" && depth > 0) depth--;
  }
  return text.length - 1;
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (TEXT_EXT.has(path.extname(name)) && !name.endsWith(".min.js")) out.push(full);
  }
  return out;
}

function findNamedObjects(text) {
  const re =
    /\b(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*(?:Euros|PriceCents))\b(?:\s*:[^=]{0,240})?\s*=\s*(?:Object\.freeze\s*\(\s*)?\{/g;
  const ranges = [];
  let match;
  while ((match = re.exec(text))) {
    const open = match.index + match[0].length - 1;
    const close = matchBrace(text, open);
    if (close > open) ranges.push({ name: match[1], start: open, end: close });
  }
  return ranges;
}

function replaceNumber(match, num, rendered) {
  const idx = match.lastIndexOf(num);
  return match.slice(0, idx) + rendered + match.slice(idx + num.length);
}

function doubleObjectValues(body, stats) {
  const valueRe = new RegExp(VALUE_RE.source, "g");
  return body.replace(valueRe, (match, key, num) => {
    if (shouldSkipKey(key)) {
      stats.skippedKeys++;
      return match;
    }
    const value = parseNum(num);
    if (!Number.isFinite(value) || value === 0) return match;
    const rendered = formatNum(value * 2);
    stats.objectValues.push(`${key}: ${num} -> ${rendered}`);
    return replaceNumber(match, num, rendered);
  });
}

function doubleEurCalls(text, stats) {
  return text.replace(/\beur\s*\(\s*(\d+(?:_\d+)*(?:\.\d+)?)\s*\)/g, (match, num) => {
    const value = parseNum(num);
    if (!Number.isFinite(value) || value === 0) return match;
    const rendered = formatNum(value * 2);
    stats.eur.push(`${num} -> ${rendered}`);
    return `eur(${rendered})`;
  });
}

function doubleEuroStrings(text, stats) {
  return text.replace(/€[\u00a0\u202f ]*(\d{1,5}(?:[.,]\d{1,2})?)/g, (match, num, offset) => {
    if (offset > 0 && text[offset - 1] === "€") return match;
    const value = Number(num.replace(",", "."));
    if (!Number.isFinite(value) || value === 0) return match;
    const doubled = value * 2;
    const rendered = Number.isInteger(doubled)
      ? String(doubled)
      : num.includes(",")
        ? doubled.toFixed(2).replace(".", ",")
        : formatNum(doubled);
    stats.strings.push(`${num} -> ${rendered}`);
    return match.slice(0, match.length - num.length) + rendered;
  });
}

function isMoneyKey(raw, includeBarePrice = true) {
  const key = String(raw).replace(/^['"]|['"]$/g, "");
  if (shouldSkipKey(key)) return false;
  if (/^price$/i.test(key)) return includeBarePrice;
  return /(?:Price|Euros|Cents|From)$/.test(key) || /^(?:lease|unlimited|exclusive)$/i.test(key);
}

function doubleMoneyKeys(text, protectedRanges, stats) {
  const re = new RegExp(
    String.raw`((?:["'][^"'\n]+["'])|(?:[A-Za-z_$][\w$]*))\s*:\s*${NUM}(?=\s*(?:[,}\n]|as\b|//))`,
    "g",
  );
  const found = [];
  let match;
  while ((match = re.exec(text))) {
    const key = String(match[1]).replace(/^['"]|['"]$/g, "");
    if (/Cents$/.test(key) || !isMoneyKey(match[1], false) || inRange(match.index, protectedRanges)) continue;
    found.push({ index: match.index, full: match[0], num: match[2], key: match[1] });
  }
  let out = text;
  for (const item of found.reverse()) {
    const value = parseNum(item.num);
    if (!Number.isFinite(value) || value === 0) continue;
    const rendered = formatNum(value * 2);
    out = out.slice(0, item.index) + replaceNumber(item.full, item.num, rendered) + out.slice(item.index + item.full.length);
    stats.objectValues.push(`${item.key}: ${item.num} -> ${rendered}`);
  }
  return out;
}

function doubleMoneyCalls(text, stats) {
  return text.replace(
    /\b(formatMoneyFromEuros|formatMoney)\s*\(\s*(\d+(?:_\d+)*(?:\.\d+)?)(?=\s*[,)])/g,
    (match, name, num) => {
      const value = parseNum(num);
      if (!Number.isFinite(value) || value === 0) return match;
      if (name === "formatMoney" && value < 100) return match;
      const rendered = formatNum(value * 2);
      stats.prices.push(`${name}(${num}) -> ${rendered}`);
      return replaceNumber(match, num, rendered);
    },
  );
}

function doubleMoneyConsts(text, stats) {
  return text.replace(
    /\b(?:const|let)\s+([A-Za-z_$][\w$]*(?:Price|Euros|From|Cents))\b(?:\s*:[^=]{0,160})?\s*=\s*(\d+(?:_\d+)*)(?=\s*[;,\n])/g,
    (match, name, num) => {
      if (shouldSkipKey(name)) return match;
      const value = parseNum(num);
      if (!Number.isFinite(value) || value === 0) return match;
      const rendered = formatNum(value * 2);
      stats.objectValues.push(`${name} = ${num} -> ${rendered}`);
      return replaceNumber(match, num, rendered);
    },
  );
}

function doubleJsonMoney(text, stats) {
  return text.replace(
    /("(?:[^"\\\n]+)")\s*:\s*(\d+(?:_\d+)*(?:\.\d+)?)(?=\s*[,}\n])/g,
    (match, key, num) => {
      if (!isMoneyKey(key)) return match;
      const value = parseNum(num);
      if (!Number.isFinite(value) || value === 0) return match;
      const rendered = formatNum(value * 2);
      stats.json.push(`${key}: ${num} -> ${rendered}`);
      return replaceNumber(match, num, rendered);
    },
  );
}

function collectPrices(text) {
  const found = [];
  const braces = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    if (c === "/" && n === "/") {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "{") {
      braces.push(i);
      continue;
    }
    if (c === "}") {
      braces.pop();
      continue;
    }
    if (c !== "p" || !text.startsWith("price", i)) continue;
    const before = i === 0 ? "" : text[i - 1];
    if (/[\w$]/.test(before)) continue;
    const m = /^price(?![\w$])\s*:\s*(\d+(?:_\d+)*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if (!m) continue;
    const after = text.slice(i + m[0].length, i + m[0].length + 24);
    if (!/^\s*(?:[,}\n]|as\b|\/\/)/.test(after)) continue;
    found.push({ index: i, raw: m[1], full: m[0], open: braces.at(-1) ?? -1 });
  }
  return found;
}

function skipsPrice(obj) {
  if (/pricingModel\s*:\s*[^,}\n]*(?:percent|quote)/i.test(obj)) return true;
  if (/\bkind\s*:\s*[^,}\n]*percent/i.test(obj)) return true;
  return false;
}

function doubleBareCents(text, protectedRanges, stats) {
  const re = /\b(priceCents|monthlyPriceCents)\s*:\s*(\d+(?:_\d+)*)(?=\s*[,}\n])/g;
  const found = [];
  let match;
  while ((match = re.exec(text))) {
    if (!inRange(match.index, protectedRanges)) found.push({ index: match.index, full: match[0], num: match[2] });
  }
  let out = text;
  for (const item of found.reverse()) {
    const value = parseNum(item.num);
    if (!Number.isFinite(value) || value === 0) continue;
    const rendered = formatNum(value * 2);
    out = out.slice(0, item.index) + replaceNumber(item.full, item.num, rendered) + out.slice(item.index + item.full.length);
    stats.objectValues.push(`${item.full.split(":")[0].trim()}: ${item.num} -> ${rendered}`);
  }
  return out;
}

function doublePriceFallbacks(text, protectedRanges, stats) {
  const re = /\bprice(?![\w$])\s*:\s*[A-Za-z_$][\w$]*\(\s*["'][^"'\n]+["']\s*,\s*(\d+(?:_\d+)*(?:\.\d+)?)(?=\s*\))/g;
  const found = [];
  let match;
  while ((match = re.exec(text))) {
    if (!inRange(match.index, protectedRanges)) found.push({ index: match.index, full: match[0], num: match[1] });
  }
  let out = text;
  for (const item of found.reverse()) {
    const open = enclosingOpen(out, item.index);
    if (open >= 0) {
      const close = matchBrace(out, open);
      if (close > open && skipsPrice(out.slice(open, close + 1))) {
        stats.skippedPercent++;
        continue;
      }
    }
    const value = parseNum(item.num);
    if (!Number.isFinite(value) || value === 0) continue;
    const rendered = formatNum(value * 2);
    out = out.slice(0, item.index) + replaceNumber(item.full, item.num, rendered) + out.slice(item.index + item.full.length);
    stats.prices.push(`fallback ${item.num} -> ${rendered}`);
  }
  return out;
}

function enclosingOpen(text, index) {
  const braces = [];
  for (let i = 0; i < index; i++) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "'" || c === '"') {
      i = skipQuoted(text, i, c);
      continue;
    }
    if (c === "`") {
      i = skipTemplate(text, i);
      continue;
    }
    if (c === "/" && n === "/") {
      const nl = text.indexOf("\n", i + 2);
      i = nl < 0 ? text.length : nl;
      continue;
    }
    if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (c === "{") braces.push(i);
    else if (c === "}") braces.pop();
  }
  return braces.at(-1) ?? -1;
}

function inRange(index, ranges) {
  return ranges.some((range) => index >= range.start && index <= range.end);
}

function doubleLoosePrices(text, protectedRanges, stats) {
  const found = collectPrices(text).filter((item) => !inRange(item.index, protectedRanges));
  let out = text;
  for (const item of found.reverse()) {
    if (item.open < 0) continue;
    const close = matchBrace(out, item.open);
    if (close < 0) continue;
    const obj = out.slice(item.open, close + 1);
    if (skipsPrice(obj)) {
      stats.skippedPercent++;
      continue;
    }
    const value = parseNum(item.raw);
    if (!Number.isFinite(value) || value === 0) continue;
    const rendered = formatNum(value * 2);
    out = out.slice(0, item.index) + replaceNumber(item.full, item.raw, rendered) + out.slice(item.index + item.full.length);
    stats.prices.push(`${item.raw} -> ${rendered}`);
  }
  return out;
}

function patchCode(text, stats) {
  let next = doubleEurCalls(text, stats);
  const ranges = findNamedObjects(next).sort((a, b) => b.start - a.start);
  for (const range of ranges) {
    const body = next.slice(range.start, range.end + 1);
    const doubled = doubleObjectValues(body, stats);
    next = next.slice(0, range.start) + doubled + next.slice(range.end + 1);
    stats.objects.push(range.name);
  }
  next = doubleBareCents(next, findNamedObjects(next), stats);
  next = doubleLoosePrices(next, findNamedObjects(next), stats);
  next = doublePriceFallbacks(next, findNamedObjects(next), stats);
  next = doubleMoneyKeys(next, findNamedObjects(next), stats);
  next = doubleMoneyCalls(next, stats);
  next = doubleMoneyConsts(next, stats);
  return doubleEuroStrings(next, stats);
}

function patchFile(file, stats) {
  const original = fs.readFileSync(file, "utf8");
  const ext = path.extname(file);
  let next = original;
  if (ext === ".json") next = doubleJsonMoney(next, stats);
  else if (CODE_EXT.has(ext)) next = patchCode(next, stats);
  else next = doubleEuroStrings(next, stats);
  if (next !== original) {
    fs.writeFileSync(file, next);
    stats.files.push(path.relative(stats.root, file));
  }
}

function probeCheckout(files) {
  const needles = ["stripePriceEnv", "unit_amount", "price_data", "checkout.sessions", "line_items"];
  const lines = [];
  let usesPriceId = false;
  let usesUnitAmount = false;
  for (const file of files) {
    if (!CODE_EXT.has(path.extname(file))) continue;
    const text = fs.readFileSync(file, "utf8");
    if (text.includes("stripePriceEnv") && /checkout\.sessions|line_items|price:\s*process\.env/.test(text)) {
      usesPriceId = true;
    }
    if (text.includes("unit_amount")) usesUnitAmount = true;
    const rows = text.split("\n");
    rows.forEach((row, index) => {
      if (needles.some((needle) => row.includes(needle))) {
        lines.push(`${path.basename(file)}:${index + 1}: ${row.trim().slice(0, 220)}`);
      }
    });
  }
  return { lines: lines.slice(0, 80), usesPriceId, usesUnitAmount };
}

export function patchDir(root) {
  const stats = {
    root,
    files: [],
    eur: [],
    objectValues: [],
    prices: [],
    strings: [],
    json: [],
    objects: [],
    skippedKeys: 0,
    skippedPercent: 0,
  };
  const files = walk(root).filter((file) => path.basename(file) !== "p.mjs");
  const probe = probeCheckout(files);
  for (const file of files) {
    if (path.basename(file).includes("lock")) continue;
    patchFile(file, stats);
  }
  stats.probe = probe;
  return stats;
}

function printStats(stats) {
  const probe = stats.probe;
  console.log("--- CHECKOUT ---");
  console.log(`CHECKOUT_USES_STRIPE_PRICE_IDS=${probe.usesPriceId ? "yes" : "no"}`);
  console.log(`CHECKOUT_USES_UNIT_AMOUNT=${probe.usesUnitAmount ? "yes" : "no"}`);
  for (const line of probe.lines) console.log(line);
  const groups = [
    ["eur()", stats.eur],
    ["object", stats.objectValues],
    ["price", stats.prices],
    ["string", stats.strings],
    ["json", stats.json],
  ];
  for (const [label, items] of groups) {
    console.log(`--- ${label} ${items.length} ---`);
    for (const item of items.slice(0, 12)) console.log(item);
  }
  console.log(
    `PRICE_PATCH_SUMMARY eur=${stats.eur.length} object=${stats.objectValues.length} price=${stats.prices.length} string=${stats.strings.length} json=${stats.json.length} skippedKeys=${stats.skippedKeys} skippedPercent=${stats.skippedPercent} files=${stats.files.length}`,
  );
  console.log(`OBJECTS ${stats.objects.join(",")}`);
}

function assertIncludes(text, needle, label) {
  if (!text.includes(needle)) throw new Error(`${label}: missing ${needle}`);
}

function assertExcludes(text, needle, label) {
  if (text.includes(needle)) throw new Error(`${label}: still has ${needle}`);
}

function runTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rer-prices-"));
  fs.mkdirSync(path.join(dir, "src", "data"), { recursive: true });
  const pricing = `export function eur(euros: number) {
  return Math.round(euros * 100);
}
export const bookingPriceCents = {
  studioWithoutEngineerHourly: 1500,
  studioWithEngineerHourly: 4_000,
  customBeatExclusive: 30000,
  artistDay: 44900,
  artistDayIncludedHours: 8,
  extraRevision: 2500,
  addEngineerHour: 2500,
};
export const mixMasterEuros = { "basis-mix": 50, mastering: 25 };
export const studioHourlyEuros = {
  rental: { "1h": hourly, "2h": 2 * hourly, "8h": 8 * hourly },
  budget: { "30m": 15, "1h-budget": 25, walkin: 30 },
};
export const studioPackageEuros = { starter: 75, release: 150, "artist-day": eurosFromCents(bookingPriceCents.artistDay) };
export const labelExtrasEuros = { spotifyCheck: 35, strategySession: 49, rushPercent: 50, coverFrom: entry.coverArtFrom };
export const entryPricesEuros = { studioFrom: 15, mixMasterFrom: 70, artistDevelopmentFrom: 199 };
const products = [
  { id: "rental-1h", priceCents: eur(15), durationMinutes: 60 },
  { id: "intro", priceCents: eur(0), durationMinutes: 20 },
];
const addons = [
  { id: "extra-30", price: 15, pricingModel: "per_half_hour", addsMinutes: 30 },
  { id: "beat-rush", description: "+50% op het pakket", price: 50, pricingModel: "percent_of_base" },
  { id: "many-stems", price: 0, pricingModel: "quote" },
  { id: "rush", price: 50, pricingModel: "fixed" },
  { id: "enum-rush", price: 50, pricingModel: AddonPricing.PercentOfBase },
  { id: "mini", minutes: 60, label: "Content Mini", price: 150 },
  { id: "extra-revision", price: coverExtra("extra-revision", 15) },
];
const raw = { id: "legacy", priceCents: 1000, durationMinutes: 30 };
export const MEMBER = { monthlyPriceCents: eur(59), minMonths: 1, studioHours: 4, engineerHoursMax: 2, discountPercent: 10 };
export const contentPlans = [
  { id: "content-start", monthlyPrice: 249, monthlyPriceCents: eur(249), hoursPerMonth: 1, discountPercent: 5 },
];
const coverFrom = 35;
const recordingCard = { fixedPrice: 75, unit: "from (studio rental)" };
const shown = formatMoneyFromEuros(15);
const shownCents = formatMoney(1500);
export const COPY = "Standard (€100), Unlimited (€200). Extra hour €40 per uur. Cost €450. Licentie (€150) of exclusief (€500).";
export const TERMS = { freeCancelHours: 24, lateCancelPercent: 50, noShowPercent: 100, bufferMinutes: 15, holdMinutes: 10 };
const note = "priceRange \\"€€\\"";
`;
  fs.writeFileSync(path.join(dir, "src", "data", "pricing.ts"), pricing);
  fs.writeFileSync(
    path.join(dir, "src", "data", "beats.json"),
    JSON.stringify({ id: "sk", prices: { lease: 50, unlimited: 150, exclusive: 250 }, plays: 0, bpm: 140, seed: 12 }),
  );
  fs.writeFileSync(
    path.join(dir, "src", "checkout.ts"),
    `export function pay(plan) {
  return stripe.checkout.sessions.create({
    line_items: [{ price: process.env[plan.stripePriceEnv], quantity: 1 }],
  });
}
`,
  );
  const stats = patchDir(dir);
  const out = fs.readFileSync(path.join(dir, "src", "data", "pricing.ts"), "utf8");
  const beats = fs.readFileSync(path.join(dir, "src", "data", "beats.json"), "utf8");
  assertIncludes(out, "return Math.round(euros * 100)", "eur body");
  assertIncludes(out, "studioWithoutEngineerHourly: 3000", "hourly cents");
  assertIncludes(out, "studioWithEngineerHourly: 8000", "engineer cents");
  assertIncludes(out, "customBeatExclusive: 60000", "exclusive cents");
  assertIncludes(out, "artistDay: 89800", "artist day cents");
  assertIncludes(out, "artistDayIncludedHours: 8", "included hours");
  assertIncludes(out, "extraRevision: 5000", "extra revision cents");
  assertIncludes(out, '"basis-mix": 100', "mix");
  assertIncludes(out, "mastering: 50", "master");
  assertIncludes(out, '"2h": 2 * hourly', "derived hours");
  assertIncludes(out, '"8h": 8 * hourly', "derived day");
  assertIncludes(out, '"30m": 30', "budget 30m");
  assertIncludes(out, '"1h-budget": 50', "budget hour");
  assertIncludes(out, "walkin: 60", "walkin");
  assertIncludes(out, "starter: 150", "starter");
  assertIncludes(out, "release: 300", "release package");
  assertIncludes(out, "eurosFromCents(bookingPriceCents.artistDay)", "derived artist day");
  assertIncludes(out, "spotifyCheck: 70", "spotify check");
  assertIncludes(out, "strategySession: 98", "strategy");
  assertIncludes(out, "rushPercent: 50", "rush percent");
  assertIncludes(out, "coverFrom: entry.coverArtFrom", "derived cover");
  assertIncludes(out, "studioFrom: 30", "entry studio");
  assertIncludes(out, "mixMasterFrom: 140", "entry mix");
  assertIncludes(out, "artistDevelopmentFrom: 398", "entry development");
  assertIncludes(out, "priceCents: eur(30)", "product");
  assertIncludes(out, "priceCents: eur(0)", "free intro");
  assertIncludes(out, "durationMinutes: 60", "duration");
  assertIncludes(out, 'id: "extra-30", price: 30, pricingModel: "per_half_hour", addsMinutes: 30', "half hour addon");
  assertIncludes(out, 'price: 50, pricingModel: "percent_of_base"', "percent addon");
  assertIncludes(out, 'price: 0, pricingModel: "quote"', "quote addon");
  assertIncludes(out, 'price: 100, pricingModel: "fixed"', "fixed rush");
  assertIncludes(out, "price: 50, pricingModel: AddonPricing.PercentOfBase", "enum percent");
  assertIncludes(out, 'price: coverExtra("extra-revision", 30)', "fallback");
  assertIncludes(out, "priceCents: 2000", "raw cents");
  assertIncludes(out, "durationMinutes: 30", "legacy duration");
  assertIncludes(out, "minutes: 60, label: \"Content Mini\", price: 300", "package card");
  assertIncludes(out, "monthlyPriceCents: eur(118)", "membership");
  assertIncludes(out, "monthlyPrice: 498", "content monthly");
  assertIncludes(out, "monthlyPriceCents: eur(498)", "content cents");
  assertIncludes(out, "hoursPerMonth: 1", "content hours");
  assertIncludes(out, "const coverFrom = 70", "cover const");
  assertIncludes(out, "fixedPrice: 150", "fixed price");
  assertIncludes(out, "formatMoneyFromEuros(30)", "format euros");
  assertIncludes(out, "formatMoney(3000)", "format cents");
  assertIncludes(out, "minMonths: 1", "min months");
  assertIncludes(out, "studioHours: 4", "studio hours");
  assertIncludes(out, "engineerHoursMax: 2", "engineer hours");
  assertIncludes(out, "discountPercent: 10", "discount");
  assertIncludes(out, "(€200)", "string 100");
  assertIncludes(out, "(€400)", "string 200");
  assertIncludes(out, "€80 per uur", "string 40");
  assertIncludes(out, "€900", "string 450");
  assertIncludes(out, "(€300)", "string 150");
  assertIncludes(out, "(€1000)", "string 500");
  assertIncludes(out, "+50%", "percent copy");
  assertIncludes(out, "freeCancelHours: 24", "cancel hours");
  assertIncludes(out, "lateCancelPercent: 50", "late percent");
  assertIncludes(out, "noShowPercent: 100", "no show");
  assertIncludes(out, "bufferMinutes: 15", "buffer");
  assertIncludes(out, "holdMinutes: 10", "hold");
  assertIncludes(out, "€€", "schema price range");
  assertExcludes(out, "eur(15)", "old product price");
  assertExcludes(out, "studioWithoutEngineerHourly: 1500", "old hourly");
  assertIncludes(beats, '"lease":100', "lease");
  assertIncludes(beats, '"unlimited":300', "unlimited");
  assertIncludes(beats, '"exclusive":500', "exclusive");
  assertIncludes(beats, '"plays":0', "plays");
  assertIncludes(beats, '"bpm":140', "bpm");
  assertIncludes(beats, '"seed":12', "seed");
  if (!stats.probe.usesPriceId) throw new Error("expected stripe price id detection");
  if (stats.eur.length < 2) throw new Error("eur count");
  console.log("TESTS_OK");
  console.log(dir);
}

if (process.argv.includes("--test")) {
  runTests();
} else if (process.argv[1] && process.argv[1].endsWith("p.mjs")) {
  const stats = patchDir(process.cwd());
  printStats(stats);
  const changed = stats.eur.length + stats.objectValues.length + stats.prices.length + stats.json.length;
  if (changed < 40) {
    console.error(`PRICE_PATCH_TOO_SMALL changed=${changed}`);
    process.exit(1);
  }
  console.log("PRICE_PATCH_OK");
}
