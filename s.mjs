/**
 * One-shot source patch for the RER site.
 * Removes SuTopia ticket sales from the public site before `next build`.
 *
 * The homepage block, the nav and footer links, and /events/sutopia go away.
 * Checkout cannot start a new order. Existing ticket PDFs, order pages, and
 * the door scanner stay in place.
 *
 * Run from the project root, before `next build`:
 *   node s.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "out",
  "dist",
  "coverage",
  ".vercel",
]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs"]);
const CLOSED = "SuTopia ticket sales are closed.";
const SALES_PAGE = /\/events\/sutopia\/page\.(tsx|jsx|ts|js)$/;

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (CODE_EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

function isIdentChar(ch) {
  return /[A-Za-z0-9_$]/.test(ch);
}

function skipLineComment(text, i) {
  const end = text.indexOf("\n", i + 2);
  return end < 0 ? text.length : end;
}

function skipBlockComment(text, i) {
  const end = text.indexOf("*/", i + 2);
  return end < 0 ? text.length : end + 2;
}

function skipQuoted(text, i) {
  const quote = text[i];
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === quote) return j + 1;
  }
  return text.length;
}

function skipTemplate(text, i) {
  let depth = 0;
  for (let j = i + 1; j < text.length; j++) {
    if (text[j] === "\\") {
      j++;
      continue;
    }
    if (text[j] === "`" && depth === 0) return j + 1;
    if (text[j] === "$" && text[j + 1] === "{") {
      depth++;
      j++;
      continue;
    }
    if (text[j] === "}" && depth > 0) depth--;
  }
  return text.length;
}

function skipTriviaAndStrings(text, i) {
  const ch = text[i];
  const next = text[i + 1];
  if (ch === "/" && next === "/") return skipLineComment(text, i);
  if (ch === "/" && next === "*") return skipBlockComment(text, i);
  if (ch === "'" || ch === '"') return skipQuoted(text, i);
  if (ch === "`") return skipTemplate(text, i);
  return -1;
}

function readTagName(text, i) {
  if (text[i] !== "<") return null;
  let j = i + 1;
  if (text[j] === "/" || text[j] === "!" || text[j] === ">") return null;
  if (!/[A-Za-z]/.test(text[j])) return null;
  const start = j;
  while (j < text.length && isIdentChar(text[j])) j++;
  if (text[j] === ".") {
    j++;
    while (j < text.length && isIdentChar(text[j])) j++;
  }
  return { name: text.slice(start, j), nameEnd: j };
}

function endOfOpeningTag(text, i) {
  let brace = 0;
  for (let j = i; j < text.length; j++) {
    const skipped = skipTriviaAndStrings(text, j);
    if (skipped >= 0) {
      j = skipped - 1;
      continue;
    }
    const ch = text[j];
    if (ch === "{") brace++;
    else if (ch === "}" && brace > 0) brace--;
    else if (ch === ">" && brace === 0) {
      const selfClosing = text[j - 1] === "/";
      return { end: j + 1, selfClosing };
    }
  }
  return null;
}

function elementEnd(text, openAt) {
  const tag = readTagName(text, openAt);
  if (!tag) return null;
  const opened = endOfOpeningTag(text, tag.nameEnd);
  if (!opened) return null;
  if (opened.selfClosing) return opened.end;
  let depth = 1;
  for (let j = opened.end; j < text.length; j++) {
    const skipped = skipTriviaAndStrings(text, j);
    if (skipped >= 0) {
      j = skipped - 1;
      continue;
    }
    if (text[j] !== "<") continue;
    if (text.startsWith(`</${tag.name}`, j)) {
      const after = j + 2 + tag.name.length;
      if (text[after] === ">" || /\s/.test(text[after])) {
        const close = text.indexOf(">", after);
        if (close < 0) return null;
        depth--;
        if (depth === 0) return close + 1;
        j = close;
        continue;
      }
    }
    const nested = readTagName(text, j);
    if (!nested || nested.name !== tag.name) continue;
    const nestedOpen = endOfOpeningTag(text, nested.nameEnd);
    if (!nestedOpen) return null;
    if (!nestedOpen.selfClosing) depth++;
    j = nestedOpen.end - 1;
  }
  return null;
}

function openingTagHasSutopiaId(text, openAt, openEnd) {
  const tag = text.slice(openAt, openEnd);
  return (
    /(?:^|\s)id\s*=\s*["']sutopia["']/.test(tag) ||
    /(?:^|\s)id\s*=\s*\{\s*["']sutopia["']\s*\}/.test(tag) ||
    /(?:^|\s)id\s*=\s*\{\s*`sutopia`\s*\}/.test(tag)
  );
}

function openingTagIsSalesLink(text, openAt, openEnd) {
  const tag = text.slice(openAt, openEnd);
  return /(?:^|\s)href\s*=\s*(?:\{\s*)?["']\/(?:#sutopia|events\/sutopia)["']/.test(tag);
}

function removeMarkedElements(text, matches) {
  const ranges = [];
  for (let i = 0; i < text.length; i++) {
    const skipped = skipTriviaAndStrings(text, i);
    if (skipped >= 0) {
      i = skipped - 1;
      continue;
    }
    if (text[i] !== "<") continue;
    const tag = readTagName(text, i);
    if (!tag) continue;
    const opened = endOfOpeningTag(text, tag.nameEnd);
    if (!opened) continue;
    if (!matches(text, i, opened.end)) continue;
    const end = opened.selfClosing ? opened.end : elementEnd(text, i);
    if (end == null) continue;
    ranges.push([i, end]);
    i = end - 1;
  }
  if (ranges.length === 0) return { text, count: 0 };
  let next = text;
  for (let n = ranges.length - 1; n >= 0; n--) {
    const [start, end] = ranges[n];
    next = `${next.slice(0, start)}null${next.slice(end)}`;
  }
  return { text: next, count: ranges.length };
}

function removeSutopiaSections(text) {
  return removeMarkedElements(text, openingTagHasSutopiaId);
}

function removeSalesAnchors(text) {
  return removeMarkedElements(text, openingTagIsSalesLink);
}

function matchBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const skipped = skipTriviaAndStrings(text, i);
    if (skipped >= 0) {
      i = skipped - 1;
      continue;
    }
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function directSalesKey(objectText) {
  let depth = 0;
  for (let i = 0; i < objectText.length; i++) {
    const skipped = skipTriviaAndStrings(objectText, i);
    if (skipped >= 0) {
      i = skipped - 1;
      continue;
    }
    if (objectText[i] === "{") depth++;
    else if (objectText[i] === "}") depth--;
    else if (depth === 1) {
      const rest = objectText.slice(i);
      if (
        /^(?:href|path)\s*:\s*["']\/(?:#sutopia|events\/sutopia)["']/.test(rest)
      ) {
        return true;
      }
    }
  }
  return false;
}

function removeSalesObjects(text) {
  const ranges = [];
  for (let i = 0; i < text.length; i++) {
    const skipped = skipTriviaAndStrings(text, i);
    if (skipped >= 0) {
      i = skipped - 1;
      continue;
    }
    if (text[i] !== "{") continue;
    const close = matchBrace(text, i);
    if (close < 0) continue;
    const object = text.slice(i, close + 1);
    if (object.length <= 4000 && directSalesKey(object)) ranges.push([i, close + 1]);
  }
  const kept = ranges.filter(
    (range) => !ranges.some((other) => other[0] < range[0] && other[1] > range[1]),
  );
  if (kept.length === 0) return { text, count: 0 };
  let next = text;
  for (let n = kept.length - 1; n >= 0; n--) {
    const [start, end] = kept[n];
    next = `${next.slice(0, start)}${next.slice(end)}`;
  }
  return { text: cleanupCommas(next), count: kept.length };
}

function cleanupCommas(text) {
  return text
    .replace(/,\s*,/g, ",")
    .replace(/\[\s*,/g, "[")
    .replace(/,\s*\]/g, "]")
    .replace(/\{\s*,/g, "{")
    .replace(/,\s*\}/g, "}");
}

function matchParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const skipped = skipTriviaAndStrings(text, i);
    if (skipped >= 0) {
      i = skipped - 1;
      continue;
    }
    if (text[i] === "(") depth++;
    else if (text[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function functionBodyOpen(text, nameIndex) {
  const paren = text.indexOf("(", nameIndex);
  if (paren < 0) return -1;
  const closeParen = matchParen(text, paren);
  if (closeParen < 0) return -1;
  let depth = 0;
  for (let i = closeParen + 1; i < text.length; i++) {
    const skipped = skipTriviaAndStrings(text, i);
    if (skipped >= 0) {
      i = skipped - 1;
      continue;
    }
    if (text[i] === "<" || text[i] === "(" || text[i] === "[") depth++;
    else if (text[i] === ">" || text[i] === ")" || text[i] === "]") depth = Math.max(0, depth - 1);
    else if (text[i] === "{" && depth === 0) return i;
  }
  return -1;
}

function patchCheckout(text) {
  if (text.includes(CLOSED)) return { text, count: 0 };
  const name = text.search(/(?:function|const)\s+startSutopiaCheckout\b/);
  if (name < 0) return { text, count: 0 };
  const open = functionBodyOpen(text, name);
  if (open < 0) return { text, count: 0 };
  const close = matchBrace(text, open);
  if (close < 0) return { text, count: 0 };
  const next = `${text.slice(0, open + 1)}\n  throw new Error(${JSON.stringify(CLOSED)});\n${text.slice(close)}`;
  return { text: next, count: 1 };
}

function salesPageSource() {
  return `import { notFound } from "next/navigation";

export default function Page() {
  notFound();
}
`;
}

function isSalesPage(file) {
  return SALES_PAGE.test(file.split(path.sep).join("/"));
}

function patchFile(file, text) {
  const stats = { sections: 0, links: 0, checkout: 0, page: 0 };
  if (isSalesPage(file)) {
    if (!text.includes('notFound();') || text.includes("SutopiaCheckoutForm") || text.includes('id="sutopia"')) {
      stats.page = 1;
      return { text: salesPageSource(), stats };
    }
    return { text, stats };
  }

  const sections = removeSutopiaSections(text);
  text = sections.text;
  stats.sections = sections.count;

  const anchors = removeSalesAnchors(text);
  text = anchors.text;
  stats.sections += anchors.count;

  const links = removeSalesObjects(text);
  text = links.text;
  stats.links = links.count;

  const checkout = patchCheckout(text);
  text = checkout.text;
  stats.checkout = checkout.count;

  return { text, stats };
}

function remainingSales(files) {
  const problems = [];
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    const rel = file.split(path.sep).join("/");
    if (isSalesPage(file)) {
      if (!text.includes("notFound()")) problems.push(`${rel} still sells`);
      continue;
    }
    if (/(?:^|\s)id\s*=\s*["']sutopia["']/.test(text)) problems.push(`${rel} still has the ticket section`);
    if (text.includes("<SutopiaCheckoutForm")) problems.push(`${rel} still renders the checkout form`);
    if (/(?:href|path)\s*[:=]\s*(?:\{\s*)?["']\/(?:#sutopia|events\/sutopia)["']/.test(text)) {
      problems.push(`${rel} still links to ticket sales`);
    }
    if (text.includes("function startSutopiaCheckout") && !text.includes(CLOSED)) {
      problems.push(`${rel} can still start checkout`);
    }
  }
  return problems;
}

const root = process.cwd();
const selfPath = fileURLToPath(import.meta.url);
const files = walk(root).filter((file) => path.resolve(file) !== selfPath);
let changed = 0;
const totals = { sections: 0, links: 0, checkout: 0, page: 0 };

for (const file of files) {
  const before = fs.readFileSync(file, "utf8");
  const { text, stats } = patchFile(file, before);
  if (text !== before) {
    fs.writeFileSync(file, text);
    changed++;
    for (const key of Object.keys(totals)) totals[key] += stats[key];
    console.log(`patched ${path.relative(root, file)}`);
  }
}

const after = walk(root).filter((file) => path.resolve(file) !== selfPath);
const problems = remainingSales(after);
const sutopiaFiles = after.filter((file) => file.split(path.sep).join("/").includes("/sutopia"));
fs.mkdirSync(path.join(root, "public"), { recursive: true });
fs.writeFileSync(
  path.join(root, "public", "sutopia-files.txt"),
  sutopiaFiles.map((file) => path.relative(root, file)).sort().join("\n") + "\n",
);
const alreadyClosed = after.some((file) => fs.readFileSync(file, "utf8").includes(CLOSED));
console.log(
  `SuTopia sales patch: ${changed} file(s); sections ${totals.sections}, links ${totals.links}, checkout ${totals.checkout}, page ${totals.page}`,
);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  process.exit(1);
}
if (changed === 0 && !alreadyClosed) {
  console.error("No SuTopia ticket sales were found to remove.");
  process.exit(1);
}
