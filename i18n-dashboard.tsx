#!/usr/bin/env bun
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, mkdirSync } from "fs";
import { join, resolve, dirname, basename } from "path";
import { homedir } from "os";
// @ts-expect-error Bun resolves HTML imports as fullstack routes
import dashboardPage from "./dashboard.html";

// ---------- Configuration: i18n-dash.config.json in the target project root + auto-discovery ----------
// The tool reads the config of whichever project it points at; without a config it finds common
// locale directories on its own. The project can be given on the CLI (`bun i18n-dashboard.tsx
// <project-root>`), defaults to the cwd, and can be switched at runtime from the dashboard UI —
// all project-derived state below is mutable and rebuilt by applyProject().

const DEFAULT_CONFIG = {
  localesDir: "", // empty = auto-discover (LOCALE_DIR_CANDIDATES below + limited scan)
  srcDir: "", // empty = "src" if present, else project root
  sourceLocale: "en",
  ollamaUrl: "http://localhost:11434/api/generate",
  model: "gemma4:12b", // translation workhorse — high volume, schema-constrained, a fast model does fine
  judgeModel: "gemma4:26b", // judgment calls (cognate vs forgotten translation) — worth the smarter, slower model
  port: 5960,
  autoFixPollMs: 15000,
  autoVerify: true, // background judging of "same" cells: confirm real cognates, flag suspicious ones
  appContext: "You are translating the UI strings of an application.", // app description injected into prompts — customize per project
  ignoreSameKeyPrefixes: [] as string[], // keys exempt from the "same" check (e.g. language names: settings.english)
  ignoreSameValues: ["OK", "AI", "API"] as string[], // values expected to stay identical in every language (brands/abbreviations)
  dynamicPrefixes: [] as string[], // key prefixes called via t(variable) that the regex scan cannot see
};
type Config = typeof DEFAULT_CONFIG;

// ---------- Mutable project-derived runtime state (rebuilt by applyProject) ----------
let PROJECT_ROOT = "";
let CONFIG_PATH = "";
let CONFIG: Config = { ...DEFAULT_CONFIG };
let PROJECT_ERROR: string | null = null; // human-readable reason when the project has no usable locales
let OLLAMA_URL = DEFAULT_CONFIG.ollamaUrl;
let MODEL = DEFAULT_CONFIG.model;
let JUDGE_MODEL = DEFAULT_CONFIG.judgeModel;
let SOURCE_LOCALE = DEFAULT_CONFIG.sourceLocale;
let AUTO_FIX_POLL_MS = DEFAULT_CONFIG.autoFixPollMs;
let LOCALES_DIR: string | null = null;
let SRC_DIR = "";
let STATE_DIR = "";
let CONFIRMED_SAME_PATH = "";
let TRANSLATION_CACHE_PATH = "";
let FLAGGED_SUSPICIOUS_PATH = "";
let LEGACY_STATE_PATHS: Record<string, string[]> = {};
let IGNORE_SAME_KEY_PREFIXES: string[] = [];
let IGNORE_SAME_VALUES = new Set<string>();
let KNOWN_DYNAMIC_PREFIXES: string[] = [];
let TRANSLATOR_SYSTEM = "";

// Directories skipped during code scans and locale discovery
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".expo", "coverage",
  ".i18n-dash", "ios", "android", "vendor", "target",
]);

// Locale file names like pt.json, en-US.json, fil.json
const LOCALE_FILE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]+)?\.json$/;

const LOCALE_DIR_CANDIDATES = [
  "src/i18n/locales", "src/i18n", "src/locales", "src/translations",
  "i18n/locales", "i18n", "locales", "translations", "public/locales",
  "app/i18n/locales", "app/i18n", "assets/i18n", "assets/locales",
];

// Does the directory contain the source-locale file plus at least one target-locale file?
function isLocaleDir(dir: string, sourceLocale: string): boolean {
  if (!existsSync(join(dir, `${sourceLocale}.json`))) return false;
  try {
    return readdirSync(dir).filter((f) => LOCALE_FILE_RE.test(f)).length >= 2;
  } catch {
    return false;
  }
}

function discoverLocalesDir(root: string, sourceLocale: string): string | null {
  for (const rel of LOCALE_DIR_CANDIDATES) {
    const full = join(root, rel);
    if (isLocaleDir(full, sourceLocale)) return full;
  }
  // Not in the common spots: limited-depth breadth-first scan
  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length) {
    const { dir, depth } = queue.shift()!;
    if (isLocaleDir(dir, sourceLocale)) return dir;
    if (depth >= 4) continue;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const full = join(dir, e);
      try {
        if (statSync(full).isDirectory()) queue.push({ dir: full, depth: depth + 1 });
      } catch {}
    }
  }
  return null;
}

// ---------- Recent projects (user-level, for the UI picker) ----------
const RECENTS_PATH = join(homedir(), ".i18n-dash-recents.json");

function loadRecents(): string[] {
  try {
    const r = JSON.parse(readFileSync(RECENTS_PATH, "utf-8"));
    return Array.isArray(r) ? r.filter((p) => typeof p === "string") : [];
  } catch {
    return [];
  }
}

function rememberRecent(root: string) {
  const list = [root, ...loadRecents().filter((p) => p !== root)].slice(0, 8);
  try {
    writeFileSync(RECENTS_PATH, JSON.stringify(list, null, 2) + "\n", "utf-8");
  } catch {}
}

// ---------- applyProject: point the whole tool at a project root ----------
// Rebuilds every piece of project-derived state. Never exits the process: on failure the
// dashboard stays up with PROJECT_ERROR set so the UI can show the picker instead.
function applyProject(root: string): { ok: boolean; error: string | null } {
  PROJECT_ROOT = resolve(root);
  CONFIG_PATH = join(PROJECT_ROOT, "i18n-dash.config.json");
  PROJECT_ERROR = null;

  CONFIG = { ...DEFAULT_CONFIG };
  if (existsSync(CONFIG_PATH)) {
    try {
      CONFIG = { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) };
    } catch (err) {
      PROJECT_ERROR = `i18n-dash.config.json is not valid JSON: ${err}`;
    }
  }

  OLLAMA_URL = CONFIG.ollamaUrl;
  MODEL = CONFIG.model;
  JUDGE_MODEL = CONFIG.judgeModel;
  SOURCE_LOCALE = CONFIG.sourceLocale;
  AUTO_FIX_POLL_MS = CONFIG.autoFixPollMs;
  IGNORE_SAME_KEY_PREFIXES = CONFIG.ignoreSameKeyPrefixes;
  IGNORE_SAME_VALUES = new Set(CONFIG.ignoreSameValues);
  KNOWN_DYNAMIC_PREFIXES = CONFIG.dynamicPrefixes;
  TRANSLATOR_SYSTEM = buildTranslatorSystem();

  LOCALES_DIR = null;
  if (!PROJECT_ERROR) {
    if (CONFIG.localesDir) {
      const full = resolve(PROJECT_ROOT, CONFIG.localesDir);
      if (isLocaleDir(full, SOURCE_LOCALE)) LOCALES_DIR = full;
      else PROJECT_ERROR = `localesDir from config is invalid: ${full} (must contain ${SOURCE_LOCALE}.json plus at least one target-language .json file)`;
    } else {
      LOCALES_DIR = discoverLocalesDir(PROJECT_ROOT, SOURCE_LOCALE);
      if (!LOCALES_DIR) {
        PROJECT_ERROR = `No locales directory found under ${PROJECT_ROOT} (looked for a folder with ${SOURCE_LOCALE}.json plus other language .json files). Set "localesDir" in the settings.`;
      }
    }
  }

  SRC_DIR = CONFIG.srcDir
    ? resolve(PROJECT_ROOT, CONFIG.srcDir)
    : existsSync(join(PROJECT_ROOT, "src"))
      ? join(PROJECT_ROOT, "src")
      : PROJECT_ROOT;

  // Persistent state lives in .i18n-dash/ inside the target repo (self-gitignored).
  // Older versions wrote under scripts/ (with a dot/no-dot name mismatch) — both are still read.
  STATE_DIR = join(PROJECT_ROOT, ".i18n-dash");
  CONFIRMED_SAME_PATH = join(STATE_DIR, "confirmed-same.json");
  TRANSLATION_CACHE_PATH = join(STATE_DIR, "translation-cache.json");
  FLAGGED_SUSPICIOUS_PATH = join(STATE_DIR, "flagged-suspicious.json");
  LEGACY_STATE_PATHS = {
    [CONFIRMED_SAME_PATH]: [
      join(PROJECT_ROOT, "scripts", ".i18n-confirmed-same.json"),
      join(PROJECT_ROOT, "scripts", "i18n-confirmed-same.json"),
    ],
    [TRANSLATION_CACHE_PATH]: [
      join(PROJECT_ROOT, "scripts", ".i18n-translation-cache.json"),
      join(PROJECT_ROOT, "scripts", "i18n-translation-cache.json"),
    ],
  };

  if (LOCALES_DIR) {
    rememberRecent(PROJECT_ROOT);
    console.log(`📂 Project applied: ${PROJECT_ROOT} → ${LOCALES_DIR}`);
  } else {
    console.error(`❌ ${PROJECT_ERROR}`);
  }
  return { ok: !!LOCALES_DIR, error: PROJECT_ERROR };
}

function ensureStateDir() {
  if (!existsSync(STATE_DIR)) {
    mkdirSync(STATE_DIR, { recursive: true });
    // the .gitignore inside keeps the whole directory out of git; the target repo's .gitignore is untouched
    writeFileSync(join(STATE_DIR, ".gitignore"), "*\n", "utf-8");
  }
}

function loadStateFile(path: string): any | null {
  for (const p of [path, ...(LEGACY_STATE_PATHS[path] ?? [])]) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {}
  }
  return null;
}

process.on("uncaughtException", (err) => console.error("❌ Uncaught exception (process keeps running):", err));
process.on("unhandledRejection", (err) => console.error("❌ Unhandled promise rejection (process keeps running):", err));

const LANGUAGE_NAMES: Record<string, { native: string; english: string }> = {
  tr: { native: "Türkçe", english: "Turkish" },
  en: { native: "English", english: "English" },
  de: { native: "Deutsch", english: "German" },
  fr: { native: "Français", english: "French" },
  es: { native: "Español", english: "Spanish" },
  pt: { native: "Português", english: "Portuguese" },
  it: { native: "Italiano", english: "Italian" },
  nl: { native: "Nederlands", english: "Dutch" },
  pl: { native: "Polski", english: "Polish" },
  sv: { native: "Svenska", english: "Swedish" },
  da: { native: "Dansk", english: "Danish" },
  no: { native: "Norsk", english: "Norwegian" },
  fi: { native: "Suomi", english: "Finnish" },
  cs: { native: "Čeština", english: "Czech" },
  ro: { native: "Română", english: "Romanian" },
  hu: { native: "Magyar", english: "Hungarian" },
  uk: { native: "Українська", english: "Ukrainian" },
  ru: { native: "Русский", english: "Russian" },
  el: { native: "Ελληνικά", english: "Greek" },
  he: { native: "עברית", english: "Hebrew" },
  ar: { native: "العربية", english: "Arabic" },
  fa: { native: "فارسی", english: "Persian" },
  hi: { native: "हिन्दी", english: "Hindi" },
  bn: { native: "বাংলা", english: "Bengali" },
  th: { native: "ไทย", english: "Thai" },
  vi: { native: "Tiếng Việt", english: "Vietnamese" },
  id: { native: "Bahasa Indonesia", english: "Indonesian" },
  zh: { native: "中文", english: "Chinese" },
  ja: { native: "日本語", english: "Japanese" },
  ko: { native: "한국어", english: "Korean" },
};

// IGNORE_SAME_* come from config (set in applyProject): these look "same" but are intentional —
// language names (e.g. the German file correctly says "English" for English), brand/product
// names, and terms that normally stay as loanwords. A human already decided; the AI judge skips them.
function isIgnoredSame(keyPath: string, enValue: string): boolean {
  if (IGNORE_SAME_VALUES.has(enValue)) return true;
  return IGNORE_SAME_KEY_PREFIXES.some((p) => keyPath === p || keyPath.startsWith(p + "."));
}

// ---------- Locale files: read/write ----------
// To keep git diffs clean, every file is written back in its own existing format (CRLF/LF,
// trailing newline or not); the format is detected from the file, never assumed.
function listLocaleCodes(): string[] {
  return readdirSync(LOCALES_DIR!)
    .filter((f) => LOCALE_FILE_RE.test(f))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

function loadLocale(code: string): any {
  return JSON.parse(readFileSync(join(LOCALES_DIR!, `${code}.json`), "utf-8"));
}

function saveLocale(code: string, data: any) {
  const path = join(LOCALES_DIR!, `${code}.json`);
  let eol = "\n";
  let trailing = "\n";
  try {
    const existing = readFileSync(path, "utf-8");
    eol = existing.includes("\r\n") ? "\r\n" : "\n";
    trailing = /\r?\n$/.test(existing) ? eol : "";
  } catch {}
  const json = JSON.stringify(data, null, 2).replace(/\n/g, eol) + trailing;
  writeFileSync(path, json, "utf-8");
}

function getPath(obj: any, path: string): any {
  return path.split(".").reduce((cur, key) => (cur == null ? undefined : cur[key]), obj);
}

function setPath(obj: any, path: string, value: any) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

function flattenKeys(obj: any, prefix = ""): string[] {
  let out: string[] = [];
  for (const k of Object.keys(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out = out.concat(flattenKeys(v, path));
    } else {
      out.push(path);
    }
  }
  return out;
}

// ---------- Code usage audit: do t('key') calls actually exist in the source locale file? ----------
// No AST machinery here — a simple regex is enough to find the t(...) calls themselves; an AST
// would only add value by expanding dynamic template-literal keys (like settings.themeName_${id})
// into concrete values, which is a separate and much larger job.
function walkSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry) || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx|js|jsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

// In some codebases a template literal is first assigned to a variable and then called as
// t(variable) — a single-line regex cannot catch that, so known exceptions are supplied
// manually via config (KNOWN_DYNAMIC_PREFIXES, set in applyProject).

function extractDynamicPrefixes(patterns: string[]): string[] {
  const prefixes = new Set<string>(KNOWN_DYNAMIC_PREFIXES);
  for (const p of patterns) {
    const idx = p.indexOf("${");
    if (idx > 0) prefixes.add(p.slice(0, idx));
  }
  return Array.from(prefixes);
}

function scanCodeUsage(): {
  usedKeysCount: number;
  missingInEn: string[];
  dynamicPatterns: string[];
  unusedKeys: string[];
} {
  const files = walkSourceFiles(SRC_DIR);
  const staticRe = /\b(?:i18n\.)?t\(\s*['"]([a-zA-Z0-9_.]+)['"]/g;
  const dynamicRe = /t\(\s*`([^`]+)`/g;
  const falsePositives = new Set(["screen", "window"]);
  const used = new Set<string>();
  const dynamic = new Set<string>();

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    staticRe.lastIndex = 0;
    while ((m = staticRe.exec(content))) {
      if (!falsePositives.has(m[1])) used.add(m[1]);
    }
    dynamicRe.lastIndex = 0;
    while ((m = dynamicRe.exec(content))) {
      dynamic.add(m[1]);
    }
  }

  const en = loadLocale(SOURCE_LOCALE);
  const enKeyList = flattenKeys(en);
  const enKeys = new Set(enKeyList);
  const missingInEn = Array.from(used)
    .filter((k) => !enKeys.has(k))
    .sort();

  const dynamicPatterns = Array.from(dynamic).sort();
  const dynamicPrefixes = extractDynamicPrefixes(dynamicPatterns);
  const unusedKeys = enKeyList
    .filter((k) => !used.has(k) && !dynamicPrefixes.some((p) => k.startsWith(p)))
    .sort();

  return { usedKeysCount: used.size, missingInEn, dynamicPatterns, unusedKeys };
}

// Finds the first line of code where a key is used (including its i18next defaultValue, if any) —
// we feed the AI real code context instead of making it guess what the key means.
function findKeyContext(key: string): string | null {
  const files = walkSourceFiles(SRC_DIR);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`t\\(\\s*['"]${escaped}['"][^)]*\\)`);
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    for (const line of content.split("\n")) {
      if (re.test(line)) return line.trim();
    }
  }
  return null;
}

const MISSING_KEY_SCHEMA = { type: "object", properties: { value: { type: "string" } }, required: ["value"] };

async function generateMissingKeyValue(key: string, context: string | null): Promise<string | null> {
  try {
    const contextText = context || "(no context found in code; infer from the key name alone)";
    const prompt = `An app's i18n source file (${SOURCE_LOCALE}.json) is missing this key: "${key}"
App context: ${CONFIG.appContext}

The key is used in code like this:
"""${contextText}"""

Based on the code context above (especially the defaultValue, if present), produce the CORRECT text to write into ${SOURCE_LOCALE}.json, in the source language (${LANGUAGE_NAMES[SOURCE_LOCALE]?.english ?? SOURCE_LOCALE}). If the defaultValue is in another language, translate it while preserving its meaning. Keep it a short, natural UI string; add no explanations.`;

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        prompt,
        format: MISSING_KEY_SCHEMA,
        stream: false,
        think: false,
        options: { temperature: 0.3 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.response !== "string") return null;
    const parsed = JSON.parse(data.response);
    return typeof parsed.value === "string" && parsed.value.trim() ? parsed.value.trim() : null;
  } catch {
    return null;
  }
}

function wordCount(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

// ---------- Helpers that treat string and string[] keys uniformly ----------
// Some source keys (e.g. reportBug.tips, privacyPolicy.sections.*.bullets) are string lists;
// unlike older code that assumed a single string, both shapes are supported here.
function isTranslatableSource(v: any): v is string | string[] {
  return typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
}

function isGap(sourceValue: string | string[], targetValue: any): boolean {
  if (Array.isArray(sourceValue)) {
    if (!Array.isArray(targetValue) || targetValue.length !== sourceValue.length) return true;
    return targetValue.some((x: any) => typeof x !== "string" || x.trim() === "");
  }
  return targetValue === undefined || (typeof targetValue === "string" && targetValue.trim() === "");
}

// Checks whether one language's value in a translation result is acceptable; returns it if so
function acceptTranslatedValue(sourceValue: string | string[], val: any): string | string[] | undefined {
  if (Array.isArray(sourceValue)) {
    if (!Array.isArray(val) || val.length !== sourceValue.length) return undefined;
    if (val.some((x: any) => typeof x !== "string" || !x.trim())) return undefined;
    return val;
  }
  if (typeof val !== "string" || !val.trim()) return undefined;
  return val;
}

// ---------- AI-approved cognate/term list for the "same" (identical to source) flag ----------
// key -> locale codes where being identical to the source was approved by the AI
function loadConfirmedSame(): Record<string, string[]> {
  return loadStateFile(CONFIRMED_SAME_PATH) ?? {};
}

function saveConfirmedSame(data: Record<string, string[]>) {
  ensureStateDir();
  writeFileSync(CONFIRMED_SAME_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function isConfirmedSame(store: Record<string, string[]>, key: string, locale: string): boolean {
  return !!store[key] && store[key].includes(locale);
}

function markConfirmedSame(key: string, locale: string) {
  const store = loadConfirmedSame();
  if (!store[key]) store[key] = [];
  if (!store[key].includes(locale)) store[key].push(locale);
  saveConfirmedSame(store);
  unflagSuspicious(key, locale); // a confirmation overrides an earlier "suspicious" verdict
}

// ---------- AI-flagged suspicious "same" cells (judged as probably-forgotten translations) ----------
// key -> locale -> the judge's one-sentence reason. Persisted so a judged pair is never re-judged;
// the flag only applies while the cell still equals the source text (stale flags are ignored on read).
function loadFlaggedSuspicious(): Record<string, Record<string, string>> {
  return loadStateFile(FLAGGED_SUSPICIOUS_PATH) ?? {};
}

function saveFlaggedSuspicious(data: Record<string, Record<string, string>>) {
  ensureStateDir();
  writeFileSync(FLAGGED_SUSPICIOUS_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function markFlaggedSuspicious(key: string, locale: string, reason: string) {
  const store = loadFlaggedSuspicious();
  if (!store[key]) store[key] = {};
  store[key][locale] = reason;
  saveFlaggedSuspicious(store);
}

function unflagSuspicious(key: string, locale: string) {
  const store = loadFlaggedSuspicious();
  if (store[key] && locale in store[key]) {
    delete store[key][locale];
    if (Object.keys(store[key]).length === 0) delete store[key];
    saveFlaggedSuspicious(store);
  }
}

// ---------- Translation cache for keys sharing the same source text ----------
// Strings like "Close" or "Settings" repeat across keys — a (source text, locale) pair is
// served locally instead of asking Ollama again. Plain strings only; array-valued keys have
// practically no chance of repeating with identical content, so they are not cached.
function loadTranslationCache(): Record<string, Record<string, string>> {
  return loadStateFile(TRANSLATION_CACHE_PATH) ?? {};
}

function saveTranslationCache(data: Record<string, Record<string, string>>) {
  ensureStateDir();
  writeFileSync(TRANSLATION_CACHE_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------- Dashboard data: canonical key set from the source locale, per-key status for every target language ----------
function buildData() {
  if (!LOCALES_DIR) {
    return { sections: [], languages: [], sourceLocale: SOURCE_LOCALE, targetLocales: [], projectError: PROJECT_ERROR };
  }
  const codes = listLocaleCodes();
  const localeData: Record<string, any> = {};
  for (const c of codes) localeData[c] = loadLocale(c);

  const en = localeData[SOURCE_LOCALE];
  const enKeys = flattenKeys(en);
  const sectionsMap = new Map<string, any[]>();
  const confirmedSame = loadConfirmedSame();
  const flaggedSuspicious = loadFlaggedSuspicious();

  for (const keyPath of enKeys) {
    const section = keyPath.split(".")[0];
    const enValue = getPath(en, keyPath);
    if (!isTranslatableSource(enValue)) continue; // keys that are not string/string[] (e.g. numbers) are hidden from the dashboard
    const isArrayValue = Array.isArray(enValue);
    const values: Record<string, { value: any; status: string; confidence?: string; reason?: string }> = {};
    for (const c of codes) {
      if (c === SOURCE_LOCALE) continue;
      const v = getPath(localeData[c], keyPath);
      let status = "ok";
      let confidence: string | undefined;
      let reason: string | undefined;
      if (isGap(enValue, v)) {
        status = v === undefined ? "missing" : "empty";
      } else if (isArrayValue ? JSON.stringify(v) === JSON.stringify(enValue) : v === enValue) {
        if (isConfirmedSame(confirmedSame, keyPath, c) || (!isArrayValue && isIgnoredSame(keyPath, enValue as string))) {
          status = "ok";
        } else if (flaggedSuspicious[keyPath]?.[c] !== undefined) {
          status = "suspicious";
          reason = flaggedSuspicious[keyPath][c];
        } else {
          status = "same";
          confidence = !isArrayValue && wordCount(enValue as string) >= 3 ? "high" : isArrayValue ? "high" : "low";
        }
      }
      values[c] = { value: v ?? null, status, confidence, reason };
    }
    if (!sectionsMap.has(section)) sectionsMap.set(section, []);
    sectionsMap.get(section)!.push({ key: keyPath, en: enValue, values });
  }

  const sections = Array.from(sectionsMap.entries()).map(([name, keys]) => {
    const missingCount = keys.reduce(
      (sum, k) => sum + Object.values(k.values).filter((v: any) => v.status !== "ok").length,
      0
    );
    return { name, keyCount: keys.length, missingCount, keys };
  });

  const targetLocales = codes.filter((c) => c !== SOURCE_LOCALE);
  const languages = codes.map((c) => ({ code: c, ...(LANGUAGE_NAMES[c] || { native: c, english: c }) }));

  return { sections, languages, sourceLocale: SOURCE_LOCALE, targetLocales };
}

// ---------- Ollama: translate one key into ALL requested languages in a single call (JSON schema constrained) ----------
// A custom Ollama model used to be built from a Modelfile; the same SYSTEM prompt is now sent
// with every request — identical output, no setup step, app description comes from config.
function buildTranslatorSystem(): string {
  return `You are a translation engine that ONLY translates user-interface text. ${CONFIG.appContext}

Strict rules:
- Keep {{variable}} placeholders (e.g. {{count}}, {{subject}}) EXACTLY as they are: never translate, drop, or rename them.
- Produce short, natural UI translations that follow the target language's UI conventions.
- Preserve the source's casing and punctuation tone (a title stays a title, a short warning stays a short warning).
- Do NOT add explanations, quotes, markdown, or introductions — return only the translated text(s).
- Do nothing besides translating: no comments, no questions, no chit-chat, no extra info, no topic changes.
- Respond ONLY according to the requested JSON schema: one field per language code, its value the translation in that language.`;
}

function buildSchema(codes: string[], arrayLength?: number) {
  const properties: Record<string, any> = {};
  for (const c of codes) {
    properties[c] =
      arrayLength !== undefined
        ? { type: "array", items: { type: "string" }, minItems: arrayLength, maxItems: arrayLength }
        : { type: "string" };
  }
  return { type: "object", properties, required: codes };
}

async function translateKeyViaOllama(
  sourceValue: string | string[],
  keyPath: string,
  codes: string[]
): Promise<Record<string, string | string[]> | null> {
  if (codes.length === 0) return {};
  try {
    const targetList = codes.map((c) => `${c} = ${LANGUAGE_NAMES[c]?.english ?? c}`).join(", ");
    const isArray = Array.isArray(sourceValue);
    // Translation rules travel with the request via TRANSLATOR_SYSTEM (they used to live in a
    // custom Ollama model's Modelfile — no `ollama create` step anymore, the base model is enough).
    // Only request-specific variables remain here.
    const srcLang = LANGUAGE_NAMES[SOURCE_LOCALE]?.english ?? SOURCE_LOCALE;
    const prompt = isArray
      ? `Source text list (${srcLang}, key: "${keyPath}", ${sourceValue.length} items, in order):
${sourceValue.map((s, i) => `${i + 1}. """${s}"""`).join("\n")}

Translate EVERY item of this list separately, preserving the order and the total item count (${sourceValue.length}), into EACH of the following languages: ${targetList}`
      : `Source text (${srcLang}, key: "${keyPath}"):
"""${sourceValue}"""

Translate this text into EACH of the following languages: ${targetList}`;

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        system: TRANSLATOR_SYSTEM,
        prompt,
        format: buildSchema(codes, isArray ? sourceValue.length : undefined),
        stream: false,
        think: false,
        options: { temperature: 0.2, repeat_penalty: 1.1 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.response !== "string") return null;
    return JSON.parse(data.response);
  } catch {
    return null;
  }
}

async function translateKey(
  sourceValue: string | string[],
  keyPath: string,
  codes: string[]
): Promise<Record<string, string | string[]> | null> {
  if (codes.length === 0) return {};

  // Array sources are not cached (the same list has practically no chance of repeating)
  if (Array.isArray(sourceValue)) {
    return translateKeyViaOllama(sourceValue, keyPath, codes);
  }

  const cache = loadTranslationCache();
  const cachedForSource = cache[sourceValue] || {};
  const uncachedCodes = codes.filter((c) => typeof cachedForSource[c] !== "string");

  if (uncachedCodes.length === 0) {
    const result: Record<string, string> = {};
    for (const c of codes) result[c] = cachedForSource[c];
    return result;
  }

  const fetched = await translateKeyViaOllama(sourceValue, keyPath, uncachedCodes);
  if (!fetched) {
    // Ollama failed, but at least return whatever was already in the cache
    if (uncachedCodes.length < codes.length) {
      const partial: Record<string, string> = {};
      for (const c of codes) if (typeof cachedForSource[c] === "string") partial[c] = cachedForSource[c];
      return partial;
    }
    return null;
  }

  const merged = { ...cachedForSource };
  for (const c of uncachedCodes) {
    const val = fetched[c];
    if (typeof val === "string" && val.trim()) merged[c] = val;
  }
  cache[sourceValue] = merged;
  saveTranslationCache(cache);

  const result: Record<string, string> = {};
  for (const c of codes) if (typeof merged[c] === "string") result[c] = merged[c];
  return result;
}

// ---------- Judge the "same" flag with AI: real cognate/term, or a forgotten translation? ----------
// No maxLength on reason: Ollama's schema grammar hard-truncates strings mid-word (sometimes
// after a few characters) when a length cap is present — brevity is asked for in the prompt
// and enforced by clamping server-side instead.
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    plausible: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["plausible", "reason"],
};

async function judgeSameTranslation(
  sourceText: string,
  locale: string,
  keyPath: string
): Promise<{ plausible: boolean; reason: string } | null> {
  try {
    const lang = LANGUAGE_NAMES[locale]?.english ?? locale;
    const srcLang = LANGUAGE_NAMES[SOURCE_LOCALE]?.english ?? SOURCE_LOCALE;
    const prompt = `An app's user interface has a string with the key: "${keyPath}"
App context: ${CONFIG.appContext}
Source (${srcLang}): """${sourceText}"""
The value stored as its ${lang} (${locale}) translation is LITERALLY IDENTICAL: """${sourceText}"""

Is this REALLY a correct/expected translation in ${lang} (e.g. a shared-root word/cognate, brand name, technical term, number, abbreviation)? Or is it most likely a forgotten translation left in the source language (${srcLang})?

If plausible=true, give a short justification (e.g. which cognate/term); if false, explain in one sentence why it is suspicious.
The reason must be ONE short sentence on a single line — no line breaks, no lists, no markdown (the schema grammar cuts the string at the first line break).`;

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        prompt,
        format: JUDGE_SCHEMA,
        stream: false,
        think: false,
        options: { temperature: 0.1 },
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (typeof data.response !== "string") return null;
    const parsed = JSON.parse(data.response);
    const reason = String(parsed.reason ?? "");
    return { plausible: !!parsed.plausible, reason: reason.length > 240 ? reason.slice(0, 237) + "..." : reason };
  } catch {
    return null;
  }
}

// ---------- Background loop: fills "missing"/"empty" cells, then judges "same" cells — no clicks needed ----------
// Two sequential phases per pass (never concurrent, to keep the local GPU sane):
//   translating — gap cells are translated by the fast workhorse model
//   verifying   — unjudged "same" cells go to the judge model; real cognates are confirmed (green),
//                 probable forgotten translations are flagged "suspicious" for a human to resolve
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const autoFixStatus = {
  enabled: true, // gap translation phase
  verifyEnabled: CONFIG.autoVerify, // "same"-cell judging phase
  phase: "idle" as "idle" | "translating" | "verifying",
  currentKey: null as string | null,
  fixedThisPass: 0,
  remainingKeys: 0,
  verifiedThisPass: 0,
  confirmedThisPass: 0,
  flaggedThisPass: 0,
  remainingPairs: 0,
  lastScanAt: null as string | null,
};

const autoFixListeners = new Set<(data: string) => void>();
function broadcastAutoFix() {
  const payload = `data: ${JSON.stringify(autoFixStatus)}\n\n`;
  for (const send of autoFixListeners) send(payload);
}

async function autoFixTranslatePass() {
  const en = loadLocale(SOURCE_LOCALE);
  const enKeys = flattenKeys(en);
  const allCodes = listLocaleCodes().filter((c) => c !== SOURCE_LOCALE);

  const gaps: string[] = [];
  for (const key of enKeys) {
    const sourceValue = getPath(en, key);
    if (!isTranslatableSource(sourceValue)) continue;
    const hasGap = allCodes.some((c) => isGap(sourceValue, getPath(loadLocale(c), key)));
    if (hasGap) gaps.push(key);
  }

  autoFixStatus.remainingKeys = gaps.length;
  autoFixStatus.fixedThisPass = 0;
  broadcastAutoFix();

  for (const key of gaps) {
    if (!autoFixStatus.enabled) break; // let the user stop mid-pass

    const sourceValue = getPath(en, key);
    if (!isTranslatableSource(sourceValue)) continue;
    const localeCache: Record<string, any> = {};
    const targets: string[] = [];
    for (const c of allCodes) {
      localeCache[c] = loadLocale(c);
      const v = getPath(localeCache[c], key);
      if (isGap(sourceValue, v)) targets.push(c);
    }
    if (targets.length === 0) continue;

    autoFixStatus.phase = "translating";
    autoFixStatus.currentKey = key;
    broadcastAutoFix();

    const translations = await translateKey(sourceValue, key, targets);
    if (translations) {
      for (const c of targets) {
        const accepted = acceptTranslatedValue(sourceValue, translations[c]);
        if (accepted === undefined) continue;
        setPath(localeCache[c], key, accepted);
        saveLocale(c, localeCache[c]);
      }
    }
    autoFixStatus.fixedThisPass++;
    autoFixStatus.remainingKeys--;
    broadcastAutoFix();
  }
}

async function autoVerifyPass() {
  const en = loadLocale(SOURCE_LOCALE);
  const enKeys = flattenKeys(en);
  const allCodes = listLocaleCodes().filter((c) => c !== SOURCE_LOCALE);
  const confirmedSame = loadConfirmedSame();
  const flagged = loadFlaggedSuspicious();

  // Unjudged "same" pairs: identical to source, not confirmed, not ignored, not already flagged
  const pairs: { key: string; locale: string; sourceText: string }[] = [];
  for (const key of enKeys) {
    const sourceText = getPath(en, key);
    if (typeof sourceText !== "string") continue;
    if (isIgnoredSame(key, sourceText)) continue;
    for (const c of allCodes) {
      if (isConfirmedSame(confirmedSame, key, c)) continue;
      if (flagged[key]?.[c] !== undefined) continue;
      if (getPath(loadLocale(c), key) === sourceText) pairs.push({ key, locale: c, sourceText });
    }
  }

  autoFixStatus.remainingPairs = pairs.length;
  autoFixStatus.verifiedThisPass = 0;
  autoFixStatus.confirmedThisPass = 0;
  autoFixStatus.flaggedThisPass = 0;
  broadcastAutoFix();

  for (const p of pairs) {
    if (!autoFixStatus.verifyEnabled) break; // let the user stop mid-pass

    autoFixStatus.phase = "verifying";
    autoFixStatus.currentKey = `${p.key} → ${p.locale}`;
    broadcastAutoFix();

    const verdict = await judgeSameTranslation(p.sourceText, p.locale, p.key);
    if (verdict) {
      if (verdict.plausible) {
        markConfirmedSame(p.key, p.locale);
        autoFixStatus.confirmedThisPass++;
      } else {
        markFlaggedSuspicious(p.key, p.locale, verdict.reason);
        autoFixStatus.flaggedThisPass++;
      }
    }
    // verdict === null (Ollama unreachable): skip silently, the next pass retries
    autoFixStatus.verifiedThisPass++;
    autoFixStatus.remainingPairs--;
    broadcastAutoFix();
  }
}

async function autoFixLoop() {
  while (true) {
    try {
      if (!LOCALES_DIR) {
        await sleep(AUTO_FIX_POLL_MS);
        continue;
      }
      if (autoFixStatus.enabled) await autoFixTranslatePass();
      if (autoFixStatus.verifyEnabled) await autoVerifyPass();
      autoFixStatus.phase = "idle";
      autoFixStatus.currentKey = null;
      autoFixStatus.lastScanAt = new Date().toISOString();
      broadcastAutoFix();
    } catch (err) {
      console.error("❌ Background pass failed (continuing):", err);
    }
    await sleep(AUTO_FIX_POLL_MS);
  }
}

// ---------- API handler'lar ----------
async function handleTranslate(req: Request): Promise<Response> {
  const body = await req.json();
  const key: string = body.key;
  const overwrite: boolean = !!body.overwrite;
  const requestedLocales: string[] | undefined = Array.isArray(body.locales) ? body.locales : undefined;

  if (!key) return Response.json({ error: "key is required" }, { status: 400 });

  const en = loadLocale(SOURCE_LOCALE);
  const sourceValue = getPath(en, key);
  if (!isTranslatableSource(sourceValue)) {
    return Response.json({ error: "Key not found in the source locale" }, { status: 400 });
  }

  const allCodes = listLocaleCodes().filter((c) => c !== SOURCE_LOCALE);
  const candidateCodes = requestedLocales ? allCodes.filter((c) => requestedLocales.includes(c)) : allCodes;

  const localeCache: Record<string, any> = {};
  const targets: string[] = [];
  for (const c of candidateCodes) {
    localeCache[c] = loadLocale(c);
    const v = getPath(localeCache[c], key);
    if (overwrite || isGap(sourceValue, v)) targets.push(c);
  }

  if (targets.length === 0) return Response.json({ translations: {}, skipped: true });

  const translations = await translateKey(sourceValue, key, targets);
  if (!translations) return Response.json({ error: "Ollama translation failed (is the model running?)" }, { status: 502 });

  const result: Record<string, string | string[]> = {};
  const unfilled: string[] = [];
  for (const c of targets) {
    const accepted = acceptTranslatedValue(sourceValue, translations[c]);
    if (accepted === undefined) {
      unfilled.push(c);
      continue;
    }
    setPath(localeCache[c], key, accepted);
    saveLocale(c, localeCache[c]);
    result[c] = accepted;
  }
  return Response.json({ translations: result, unfilled });
}

function streamTranslateSection(section: string, overwrite: boolean): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const en = loadLocale(SOURCE_LOCALE);
        const keys = flattenKeys(en).filter((k) => k.split(".")[0] === section);
        const allCodes = listLocaleCodes().filter((c) => c !== SOURCE_LOCALE);
        send({ type: "start", total: keys.length });

        let skippedCount = 0;
        let translatedCount = 0;
        let cellsApplied = 0;

        for (const key of keys) {
          const sourceValue = getPath(en, key);
          if (!isTranslatableSource(sourceValue)) continue;
          const localeCache: Record<string, any> = {};
          const targets: string[] = [];
          for (const c of allCodes) {
            localeCache[c] = loadLocale(c);
            const v = getPath(localeCache[c], key);
            if (overwrite || isGap(sourceValue, v)) targets.push(c);
          }

          if (targets.length === 0) {
            skippedCount++;
            send({ type: "key", key, translations: {}, skipped: true });
            continue;
          }

          const translations = await translateKey(sourceValue, key, targets);
          const applied: Record<string, string | string[]> = {};
          if (translations) {
            for (const c of targets) {
              const accepted = acceptTranslatedValue(sourceValue, translations[c]);
              if (accepted === undefined) continue;
              setPath(localeCache[c], key, accepted);
              saveLocale(c, localeCache[c]);
              applied[c] = accepted;
              cellsApplied++;
            }
          }
          translatedCount++;
          send({ type: "key", key, translations: applied, skipped: false });
        }
        send({ type: "done", translatedCount, skippedCount, cellsApplied });
      } catch (err: any) {
        send({ type: "error", message: String(err?.message ?? err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

async function handleSave(req: Request): Promise<Response> {
  const { key, locale, value } = await req.json();
  if (!key || !locale || typeof value !== "string") {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const codes = listLocaleCodes();
  if (!codes.includes(locale)) return Response.json({ error: "unknown locale" }, { status: 400 });
  const data = loadLocale(locale);
  setPath(data, key, value);
  saveLocale(locale, data);
  return Response.json({ ok: true });
}

async function handleAddKey(req: Request): Promise<Response> {
  const { key, value } = await req.json();
  if (!key || typeof value !== "string" || !value.trim()) {
    return Response.json({ error: "invalid request" }, { status: 400 });
  }
  const en = loadLocale(SOURCE_LOCALE);
  if (getPath(en, key) !== undefined) {
    return Response.json({ error: "Key already exists" }, { status: 409 });
  }
  setPath(en, key, value);
  saveLocale(SOURCE_LOCALE, en);
  return Response.json({ ok: true });
}

async function handleAddMissingKey(req: Request): Promise<Response> {
  const { key } = await req.json();
  if (!key) return Response.json({ error: "key is required" }, { status: 400 });

  const en = loadLocale(SOURCE_LOCALE);
  if (getPath(en, key) !== undefined) {
    return Response.json({ error: "Key already exists" }, { status: 409 });
  }

  const context = findKeyContext(key);
  const value = await generateMissingKeyValue(key, context);
  if (!value) return Response.json({ error: "AI could not generate text (is the model running?)" }, { status: 502 });

  setPath(en, key, value);
  saveLocale(SOURCE_LOCALE, en);
  return Response.json({ ok: true, value, context });
}

async function handleVerifySame(req: Request): Promise<Response> {
  const { key, locale } = await req.json();
  if (!key || !locale) return Response.json({ error: "invalid request" }, { status: 400 });
  const en = loadLocale(SOURCE_LOCALE);
  const sourceText = getPath(en, key);
  if (typeof sourceText !== "string") return Response.json({ error: "Key not found in the source locale" }, { status: 400 });

  const verdict = await judgeSameTranslation(sourceText, locale, key);
  if (!verdict) return Response.json({ error: "AI verification failed (is the model running?)" }, { status: 502 });
  if (verdict.plausible) markConfirmedSame(key, locale);
  else markFlaggedSuspicious(key, locale, verdict.reason);
  return Response.json(verdict);
}

// If the user knows an identical pair is intentional/correct despite the AI calling it
// "suspicious" (e.g. a deliberately kept term like "Flashcards"), approve it without asking the AI.
async function handleConfirmSame(req: Request): Promise<Response> {
  const { key, locale } = await req.json();
  if (!key || !locale) return Response.json({ error: "invalid request" }, { status: 400 });
  markConfirmedSame(key, locale);
  return Response.json({ ok: true });
}

function streamVerifySection(section: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const en = loadLocale(SOURCE_LOCALE);
        const keys = flattenKeys(en).filter((k) => k.split(".")[0] === section);
        const allCodes = listLocaleCodes().filter((c) => c !== SOURCE_LOCALE);
        const confirmedSame = loadConfirmedSame();
        const alreadyFlagged = loadFlaggedSuspicious();

        const pairs: { key: string; locale: string; sourceText: string }[] = [];
        for (const key of keys) {
          const sourceText = getPath(en, key);
          if (typeof sourceText !== "string") continue;
          if (isIgnoredSame(key, sourceText)) continue;
          for (const c of allCodes) {
            if (isConfirmedSame(confirmedSame, key, c)) continue;
            if (alreadyFlagged[key]?.[c] !== undefined) continue;
            const v = getPath(loadLocale(c), key);
            if (v === sourceText) pairs.push({ key, locale: c, sourceText });
          }
        }
        send({ type: "start", total: pairs.length });

        let confirmed = 0;
        let flagged = 0;
        for (const p of pairs) {
          const verdict = await judgeSameTranslation(p.sourceText, p.locale, p.key);
          if (verdict?.plausible) {
            markConfirmedSame(p.key, p.locale);
            confirmed++;
          } else {
            if (verdict) markFlaggedSuspicious(p.key, p.locale, verdict.reason);
            flagged++;
          }
          send({ type: "pair", key: p.key, locale: p.locale, verdict });
        }
        send({ type: "done", confirmed, flagged });
      } catch (err: any) {
        send({ type: "error", message: String(err?.message ?? err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

// ---------- Sweep suspicious cells: translate everything the judge flagged, in one click ----------
// The judge (smart model) said these are forgotten translations; the workhorse (fast model)
// overwrites them with real translations. One Ollama call per key covers all its flagged locales.
// A successfully translated cell loses its flag; a cell the model keeps identical to the source
// stays flagged (nothing changed, so the verdict still stands).
function streamTranslateSuspicious(): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: any) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      try {
        const en = loadLocale(SOURCE_LOCALE);
        const flagged = loadFlaggedSuspicious();

        const work: { key: string; sourceValue: string; locales: string[] }[] = [];
        for (const [key, locs] of Object.entries(flagged)) {
          const sourceValue = getPath(en, key);
          if (typeof sourceValue !== "string") continue;
          // stale flags (cell no longer identical to the source) are skipped
          const locales = Object.keys(locs).filter((c) => getPath(loadLocale(c), key) === sourceValue);
          if (locales.length > 0) work.push({ key, sourceValue, locales });
        }
        const totalCells = work.reduce((sum, w) => sum + w.locales.length, 0);
        send({ type: "start", total: work.length, totalCells });

        let cellsApplied = 0;
        let cellsUnchanged = 0;
        let cellsFailed = 0;
        for (const w of work) {
          const translations = await translateKey(w.sourceValue, w.key, w.locales);
          const applied: Record<string, string | string[]> = {};
          for (const c of w.locales) {
            const accepted = translations ? acceptTranslatedValue(w.sourceValue, translations[c]) : undefined;
            if (accepted === undefined) {
              cellsFailed++;
              continue;
            }
            if (accepted === w.sourceValue) {
              cellsUnchanged++;
              continue;
            }
            const data = loadLocale(c);
            setPath(data, w.key, accepted);
            saveLocale(c, data);
            unflagSuspicious(w.key, c);
            applied[c] = accepted;
            cellsApplied++;
          }
          send({ type: "key", key: w.key, attempted: w.locales.length, translations: applied });
        }
        send({ type: "done", cellsApplied, cellsUnchanged, cellsFailed });
      } catch (err: any) {
        send({ type: "error", message: String(err?.message ?? err) });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

// ---------- Project & config management (backs the UI picker and settings) ----------
function projectInfo() {
  return {
    projectRoot: PROJECT_ROOT,
    projectName: basename(PROJECT_ROOT),
    localesDir: LOCALES_DIR,
    error: PROJECT_ERROR,
    configPath: CONFIG_PATH,
    configExists: existsSync(CONFIG_PATH),
    config: CONFIG,
    port: DASHBOARD_PORT,
    recents: loadRecents(),
  };
}

function resetPassCounters() {
  autoFixStatus.phase = "idle";
  autoFixStatus.currentKey = null;
  autoFixStatus.fixedThisPass = 0;
  autoFixStatus.remainingKeys = 0;
  autoFixStatus.verifiedThisPass = 0;
  autoFixStatus.confirmedThisPass = 0;
  autoFixStatus.flaggedThisPass = 0;
  autoFixStatus.remainingPairs = 0;
  broadcastAutoFix();
}

async function handleSetProject(req: Request): Promise<Response> {
  const { path } = await req.json();
  if (!path || typeof path !== "string") return Response.json({ error: "path is required" }, { status: 400 });
  if (!existsSync(path)) return Response.json({ error: "Folder does not exist" }, { status: 400 });
  applyProject(path);
  resetPassCounters();
  return Response.json(projectInfo());
}

const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG) as (keyof Config)[];

// Writes UI-edited settings into the project's i18n-dash.config.json (preserving any extra
// fields the user keeps there) and re-applies the project so changes take effect immediately.
async function handleSaveConfig(req: Request): Promise<Response> {
  const body = await req.json();
  let onDisk: any = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      onDisk = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
    } catch {}
  }
  for (const k of CONFIG_KEYS) {
    if (k in body) onDisk[k] = body[k];
  }
  writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2) + "\n", "utf-8");
  applyProject(PROJECT_ROOT);
  resetPassCounters();
  const restartRequired = typeof onDisk.port === "number" && onDisk.port !== DASHBOARD_PORT;
  return Response.json({ ...projectInfo(), restartRequired });
}

// Folder listing for the project picker. Root level = home dir + drive roots (Windows).
function handleBrowse(url: URL): Response {
  const raw = url.searchParams.get("path") || "";
  if (!raw) {
    const dirs = [{ name: "Home", path: homedir(), isProject: false }];
    for (const letter of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${letter}:\\`;
      if (existsSync(drive)) dirs.push({ name: drive, path: drive, isProject: false });
    }
    return Response.json({ path: "", parent: null, dirs });
  }
  const p = resolve(raw);
  let entries: string[];
  try {
    entries = readdirSync(p);
  } catch (err) {
    return Response.json({ error: `Cannot read folder: ${err}` }, { status: 400 });
  }
  const dirs: { name: string; path: string; isProject: boolean }[] = [];
  for (const e of entries) {
    if (e.startsWith(".") || SKIP_DIRS.has(e)) continue;
    const full = join(p, e);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    dirs.push({ name: e, path: full, isProject: existsSync(join(full, "package.json")) });
  }
  dirs.sort((a, b) => (b.isProject ? 1 : 0) - (a.isProject ? 1 : 0) || a.name.localeCompare(b.name));
  const parent = dirname(p);
  return Response.json({ path: p, parent: parent === p ? "" : parent, dirs });
}

// Installed Ollama models, so the settings UI can offer dropdowns instead of free text
async function handleOllamaModels(): Promise<Response> {
  try {
    const res = await fetch(OLLAMA_URL.replace(/\/api\/generate\/?$/, "/api/tags"));
    const data = await res.json();
    const models = Array.isArray(data.models) ? data.models.map((m: any) => m.name) : [];
    return Response.json({ models });
  } catch {
    return Response.json({ models: [], error: "Ollama unreachable" });
  }
}

// Endpoints that cannot work without a valid locales directory
const NEEDS_PROJECT = new Set([
  "/api/translate", "/api/translate-section", "/api/save", "/api/add-key",
  "/api/verify-same", "/api/confirm-same", "/api/verify-section",
  "/api/translate-suspicious", "/api/code-usage", "/api/add-missing-key",
]);

// ---------- Startup & server ----------
// The frontend lives in dashboard.html + dashboard-client.tsx (React). Bun's fullstack server
// bundles and serves them on the fly — no build step; React comes from this repo's node_modules.
applyProject(resolve(process.argv[2] || process.cwd()));
const DASHBOARD_PORT = CONFIG.port; // fixed for the process lifetime — changing it in settings requires a restart

Bun.serve({
  port: DASHBOARD_PORT,
  idleTimeout: 0, // the /events SSE stream is idle between auto-fix updates; the default 10s timeout would sever it
  routes: { "/": dashboardPage },
  async fetch(req) {
    const url = new URL(req.url);

    try {
      if (NEEDS_PROJECT.has(url.pathname) && !LOCALES_DIR) {
        return Response.json({ error: PROJECT_ERROR ?? "No project selected" }, { status: 400 });
      }
      if (req.method === "GET" && url.pathname === "/api/project") {
        return Response.json(projectInfo());
      }
      if (req.method === "POST" && url.pathname === "/api/project") {
        return await handleSetProject(req);
      }
      if (req.method === "POST" && url.pathname === "/api/config") {
        return await handleSaveConfig(req);
      }
      if (req.method === "GET" && url.pathname === "/api/browse") {
        return handleBrowse(url);
      }
      if (req.method === "GET" && url.pathname === "/api/ollama-models") {
        return await handleOllamaModels();
      }
      if (req.method === "GET" && url.pathname === "/api/data") {
        return Response.json(buildData());
      }
      if (req.method === "POST" && url.pathname === "/api/translate") {
        return await handleTranslate(req);
      }
      if (req.method === "POST" && url.pathname === "/api/translate-section") {
        const body = await req.json();
        return streamTranslateSection(body.section, !!body.overwrite);
      }
      if (req.method === "POST" && url.pathname === "/api/save") {
        return await handleSave(req);
      }
      if (req.method === "POST" && url.pathname === "/api/add-key") {
        return await handleAddKey(req);
      }
      if (req.method === "POST" && url.pathname === "/api/verify-same") {
        return await handleVerifySame(req);
      }
      if (req.method === "POST" && url.pathname === "/api/confirm-same") {
        return await handleConfirmSame(req);
      }
      if (req.method === "POST" && url.pathname === "/api/verify-section") {
        const body = await req.json();
        return streamVerifySection(body.section);
      }
      if (req.method === "POST" && url.pathname === "/api/translate-suspicious") {
        return streamTranslateSuspicious();
      }
      if (req.method === "GET" && url.pathname === "/api/auto-fix") {
        return Response.json(autoFixStatus);
      }
      if (req.method === "POST" && url.pathname === "/api/auto-fix") {
        const body = await req.json();
        if ("enabled" in body) autoFixStatus.enabled = !!body.enabled;
        if ("verifyEnabled" in body) autoFixStatus.verifyEnabled = !!body.verifyEnabled;
        broadcastAutoFix();
        return Response.json(autoFixStatus);
      }
      if (req.method === "GET" && url.pathname === "/api/code-usage") {
        return Response.json(scanCodeUsage());
      }
      if (req.method === "POST" && url.pathname === "/api/add-missing-key") {
        return await handleAddMissingKey(req);
      }
      if (req.method === "GET" && url.pathname === "/events") {
        let send: (data: string) => void;
        const stream = new ReadableStream({
          start(controller) {
            send = (data: string) => controller.enqueue(new TextEncoder().encode(data));
            autoFixListeners.add(send);
            send(`data: ${JSON.stringify(autoFixStatus)}\n\n`);
          },
          cancel() {
            autoFixListeners.delete(send);
          },
        });
        return new Response(stream, {
          headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" },
        });
      }
    } catch (err: any) {
      return Response.json({ error: String(err?.message ?? err) }, { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`\n🌍 i18n Dashboard: http://localhost:${DASHBOARD_PORT}`);
if (LOCALES_DIR) {
  console.log(`📁 Project root: ${PROJECT_ROOT}${existsSync(CONFIG_PATH) ? " (i18n-dash.config.json loaded)" : " (no config — defaults + auto-discovery)"}`);
  console.log(`📂 Locales dir: ${LOCALES_DIR} — ${listLocaleCodes().length} languages, source: ${SOURCE_LOCALE}`);
} else {
  console.log(`📁 No usable project yet — open the dashboard and pick one from the UI.`);
}
console.log(`🤖 Ollama: ${OLLAMA_URL} | translator: ${MODEL} | judge: ${JUDGE_MODEL}\n`);
autoFixLoop();

// Lets wrappers (e.g. a desktop shell) import this module and learn where the server landed
export { DASHBOARD_PORT };
