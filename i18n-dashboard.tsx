import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "fs";
import { join } from "path";

const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = "i18n-translator"; // gemma4:26b üstüne scripts/i18n-translator.Modelfile ile kurulan çeviriye özelleşmiş model
const JUDGE_MODEL = "gemma4:26b"; // "aynı" flag'inin gerçek bir kognat mı yoksa unutulmuş çeviri mi olduğuna karar veren genel model
const LOCALES_DIR = join(process.cwd(), "src", "i18n", "locales");
const SRC_DIR = join(process.cwd(), "src");
const CONFIRMED_SAME_PATH = join(process.cwd(), "scripts", ".i18n-confirmed-same.json");
const TRANSLATION_CACHE_PATH = join(process.cwd(), "scripts", ".i18n-translation-cache.json");
const SOURCE_LOCALE = "en";
const DASHBOARD_PORT = 5960;
const AUTO_FIX_POLL_MS = 15000;

process.on("uncaughtException", (err) => console.error("❌ Yakalanmamış hata (süreç devam ediyor):", err));
process.on("unhandledRejection", (err) => console.error("❌ Yakalanmamış promise reddi (süreç devam ediyor):", err));

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

// scripts/audit_i18n.py'den taşındı: bunlar "aynı" gibi görünse de kasıtlı — dil adları
// (örn. Almanca dosyasında "İngilizce" için "English" yazması doğrudur), marka/ürün adları,
// ve "Flashcards" gibi birçok dilde ödünç kelime olarak kalması normal olan terimler.
// AI Doğrula bunları bağlamsız yargılayıp "şüpheli" diyebiliyor — insan zaten karar vermiş.
const IGNORE_SAME_KEY_PREFIXES = [
  "settings.turkish", "settings.english", "settings.german", "settings.french", "settings.spanish",
  "settings.portuguese", "settings.italian", "settings.dutch", "settings.polish", "settings.swedish",
  "settings.danish", "settings.norwegian", "settings.finnish", "settings.czech", "settings.romanian",
  "settings.hungarian", "settings.ukrainian", "settings.russian", "settings.greek", "settings.hebrew",
  "settings.arabic", "settings.persian", "settings.hindi", "settings.bengali", "settings.thai",
  "settings.vietnamese", "settings.indonesian", "settings.chinese", "settings.japanese", "settings.korean",
  "home.appName", "flashcards.title",
];
const IGNORE_SAME_VALUES = new Set(["AI", "API", "LMS", "OK", "Mindhouse Panel", "Flashcards", "Gemini", "Groq", "Ollama"]);

function isIgnoredSame(keyPath: string, enValue: string): boolean {
  if (IGNORE_SAME_VALUES.has(enValue)) return true;
  return IGNORE_SAME_KEY_PREFIXES.some((p) => keyPath === p || keyPath.startsWith(p + "."));
}

// ---------- Locale dosyaları: okuma/yazma ----------
// Kaynak dosyalar CRLF + trailing-newline'sız; git diff'i temiz tutmak için aynı formatta geri yazıyoruz.
function listLocaleCodes(): string[] {
  return readdirSync(LOCALES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""))
    .sort();
}

function loadLocale(code: string): any {
  return JSON.parse(readFileSync(join(LOCALES_DIR, `${code}.json`), "utf-8"));
}

function saveLocale(code: string, data: any) {
  const json = JSON.stringify(data, null, 2).replace(/\n/g, "\r\n");
  writeFileSync(join(LOCALES_DIR, `${code}.json`), json, "utf-8");
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

// ---------- Kod kullanımı denetimi: t('key') çağrıları en.json'da gerçekten var mı? ----------
// analysis.tsx'in AST altyapısını burada tekrarlamıyoruz — t(...) çağrısının kendisini bulmak
// için basit regex yeterli (scripts/audit_i18n.py'deki yaklaşımın aynısı); AST'nin katkısı ancak
// dinamik template-literal key'lerini (settings.themeName_${id} gibi) somut değerlere açmakta
// olurdu, o da ayrı ve daha büyük bir iş.
function walkSourceFiles(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
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

// explore.tsx gibi bazı yerlerde template-literal önce bir değişkene atanıp t(değişken) olarak
// çağrılıyor — tek satırlık regex bunu yakalayamıyor, o yüzden bilinen istisnaları elle ekliyoruz.
const KNOWN_DYNAMIC_PREFIXES = ["explore.steps."];

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

// Bir key'in kodda geçtiği ilk satırı (varsa i18next defaultValue'su dahil) bulur —
// AI'ya "bu key ne anlama geliyor" diye tahmin ettirmek yerine gerçek kod bağlamı veriyoruz.
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
    const contextText = context || "(kod içinde context bulunamadı, sadece key adına bak)";
    const prompt = `Bir React Native (Expo) eğitim uygulamasının i18n dosyasında (en.json) şu key eksik: "${key}"

Kodda bu key şöyle kullanılıyor:
"""${contextText}"""

Yukarıdaki kod bağlamına (özellikle varsa defaultValue) bakarak, bu key için en.json'a yazılacak DOĞRU İNGİLİZCE metni üret. Eğer defaultValue İngilizce değilse, anlamını koruyarak İngilizce'ye çevir. Kısa ve doğal bir UI metni olsun, açıklama ekleme.`;

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

// ---------- string ve string[] tipindeki key'leri tek tip ele alan yardımcılar ----------
// en.json'da bazı key'ler (reportBug.tips, privacyPolicy.sections.*.bullets) string listesi;
// tek string varsayan eski koddan farklı olarak burada ikisi de destekleniyor.
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

// Çeviri sonucundaki bir dilin değerini kabul edilebilir mi diye kontrol eder; kabul edilirse değeri döndürür
function acceptTranslatedValue(sourceValue: string | string[], val: any): string | string[] | undefined {
  if (Array.isArray(sourceValue)) {
    if (!Array.isArray(val) || val.length !== sourceValue.length) return undefined;
    if (val.some((x: any) => typeof x !== "string" || !x.trim())) return undefined;
    return val;
  }
  if (typeof val !== "string" || !val.trim()) return undefined;
  return val;
}

// ---------- "Aynı" (en ile birebir eşit) flag'i için AI ile onaylanmış kognat/terim listesi ----------
// key -> o key'de İngilizce ile aynı olması AI tarafından onaylanmış locale kodları
function loadConfirmedSame(): Record<string, string[]> {
  if (!existsSync(CONFIRMED_SAME_PATH)) return {};
  try {
    return JSON.parse(readFileSync(CONFIRMED_SAME_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveConfirmedSame(data: Record<string, string[]>) {
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
}

// ---------- Aynı İngilizce kaynak metne sahip key'ler için çeviri cache'i ----------
// en.json'da "Close", "Settings" gibi ~540 key'in %10'u birebir tekrar ediyor — kaynak metin
// (locale) çiftini bir daha Ollama'ya sormadan lokalden döndürür. Sadece düz string'ler için;
// dizi (array) değerli key'lerin aynı içerikle tekrar etme ihtimali pratikte yok, cache'lenmiyor.
function loadTranslationCache(): Record<string, Record<string, string>> {
  if (!existsSync(TRANSLATION_CACHE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(TRANSLATION_CACHE_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveTranslationCache(data: Record<string, Record<string, string>>) {
  writeFileSync(TRANSLATION_CACHE_PATH, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------- Dashboard verisi: en.json canonical key seti, her key için 29 hedef dilin durumu ----------
function buildData() {
  const codes = listLocaleCodes();
  const localeData: Record<string, any> = {};
  for (const c of codes) localeData[c] = loadLocale(c);

  const en = localeData[SOURCE_LOCALE];
  const enKeys = flattenKeys(en);
  const sectionsMap = new Map<string, any[]>();
  const confirmedSame = loadConfirmedSame();

  for (const keyPath of enKeys) {
    const section = keyPath.split(".")[0];
    const enValue = getPath(en, keyPath);
    if (!isTranslatableSource(enValue)) continue; // string/string[] dışındaki (örn. sayı) key'ler dashboard'da gösterilmiyor
    const isArrayValue = Array.isArray(enValue);
    const values: Record<string, { value: any; status: string; confidence?: string }> = {};
    for (const c of codes) {
      if (c === SOURCE_LOCALE) continue;
      const v = getPath(localeData[c], keyPath);
      let status = "ok";
      let confidence: string | undefined;
      if (isGap(enValue, v)) {
        status = v === undefined ? "missing" : "empty";
      } else if (isArrayValue ? JSON.stringify(v) === JSON.stringify(enValue) : v === enValue) {
        if (isConfirmedSame(confirmedSame, keyPath, c) || (!isArrayValue && isIgnoredSame(keyPath, enValue as string))) {
          status = "ok";
        } else {
          status = "same";
          confidence = !isArrayValue && wordCount(enValue as string) >= 3 ? "high" : isArrayValue ? "high" : "low";
        }
      }
      values[c] = { value: v ?? null, status, confidence };
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

// ---------- Ollama: tek key'i istenen dillerin HEPSİNE tek çağrıda çevir (JSON schema constrained) ----------
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
    // Çeviri kuralları artık i18n-translator modelinin SYSTEM prompt'unda (bkz. scripts/i18n-translator.Modelfile),
    // burada sadece istek bazlı değişkenler kalıyor.
    const prompt = isArray
      ? `Kaynak metin listesi (İngilizce, key: "${keyPath}", ${sourceValue.length} madde, sırayla):
${sourceValue.map((s, i) => `${i + 1}. """${s}"""`).join("\n")}

Bu listedeki HER MADDEYİ ayrı ayrı, sırasını ve toplam madde sayısını (${sourceValue.length}) koruyarak aşağıdaki dillerin HER BİRİNE çevir: ${targetList}`
      : `Kaynak metin (İngilizce, key: "${keyPath}"):
"""${sourceValue}"""

Bu metni aşağıdaki dillerin HER BİRİNE çevir: ${targetList}`;

    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        prompt,
        format: buildSchema(codes, isArray ? sourceValue.length : undefined),
        stream: false,
        think: false,
        options: { temperature: 0.2 },
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

  // Dizi kaynaklar cache'lenmiyor (aynı listenin tekrar etme ihtimali pratikte yok)
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
    // Ollama başarısız oldu ama cache'de zaten olanlar varsa onları en azından döndür
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

// ---------- "Aynı" flag'ini AI ile yargıla: gerçek kognat/terim mi, yoksa unutulmuş çeviri mi ----------
const JUDGE_SCHEMA = {
  type: "object",
  properties: {
    plausible: { type: "boolean" },
    reason: { type: "string", maxLength: 120 },
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
    const prompt = `Bir mobil uygulamanın arayüz metni için şu key var: "${keyPath}"
Kaynak (İngilizce): """${sourceText}"""
${lang} (${locale}) çevirisi olarak kayıtlı değer HARFİYEN AYNI: """${sourceText}"""

Bu, ${lang} dilinde GERÇEKTEN doğru/beklenen bir çeviri mi (örn. ortak köklü kelime/kognat, marka adı, teknik terim, sayı, kısaltma)? Yoksa muhtemelen çevrilmesi unutulmuş, İngilizce kalmış bir metin mi?

plausible=true ise kısa bir gerekçe (ör. hangi kognat/terim), false ise neden şüpheli olduğunu tek cümlede yaz.`;

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
    return { plausible: !!parsed.plausible, reason: String(parsed.reason ?? "") };
  } catch {
    return null;
  }
}

// ---------- Arka planda otomatik onarım: "missing"/"empty" hücreleri kullanıcı hiçbir şeye tıklamadan doldurur ----------
function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const autoFixStatus = {
  enabled: true,
  running: false,
  currentKey: null as string | null,
  fixedThisPass: 0,
  remainingKeys: 0,
  lastScanAt: null as string | null,
};

const autoFixListeners = new Set<(data: string) => void>();
function broadcastAutoFix() {
  const payload = `data: ${JSON.stringify(autoFixStatus)}\n\n`;
  for (const send of autoFixListeners) send(payload);
}

async function autoFixLoop() {
  while (true) {
    if (!autoFixStatus.enabled) {
      await sleep(AUTO_FIX_POLL_MS);
      continue;
    }
    try {
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
        if (!autoFixStatus.enabled) break; // kullanıcı ortasında durdurabilsin

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

        autoFixStatus.running = true;
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

      autoFixStatus.running = false;
      autoFixStatus.currentKey = null;
      autoFixStatus.lastScanAt = new Date().toISOString();
      broadcastAutoFix();
    } catch (err) {
      console.error("❌ Otomatik onarım turu hata verdi (devam ediyor):", err);
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

  if (!key) return Response.json({ error: "key gerekli" }, { status: 400 });

  const en = loadLocale(SOURCE_LOCALE);
  const sourceValue = getPath(en, key);
  if (!isTranslatableSource(sourceValue)) {
    return Response.json({ error: "Bu key kaynak (en) dilde bulunamadı" }, { status: 400 });
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
  if (!translations) return Response.json({ error: "Ollama çeviri başarısız (model çalışıyor mu?)" }, { status: 502 });

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
    return Response.json({ error: "geçersiz istek" }, { status: 400 });
  }
  const codes = listLocaleCodes();
  if (!codes.includes(locale)) return Response.json({ error: "bilinmeyen dil" }, { status: 400 });
  const data = loadLocale(locale);
  setPath(data, key, value);
  saveLocale(locale, data);
  return Response.json({ ok: true });
}

async function handleAddKey(req: Request): Promise<Response> {
  const { key, value } = await req.json();
  if (!key || typeof value !== "string" || !value.trim()) {
    return Response.json({ error: "geçersiz istek" }, { status: 400 });
  }
  const en = loadLocale(SOURCE_LOCALE);
  if (getPath(en, key) !== undefined) {
    return Response.json({ error: "Bu key zaten var" }, { status: 409 });
  }
  setPath(en, key, value);
  saveLocale(SOURCE_LOCALE, en);
  return Response.json({ ok: true });
}

async function handleAddMissingKey(req: Request): Promise<Response> {
  const { key } = await req.json();
  if (!key) return Response.json({ error: "key gerekli" }, { status: 400 });

  const en = loadLocale(SOURCE_LOCALE);
  if (getPath(en, key) !== undefined) {
    return Response.json({ error: "Bu key zaten var" }, { status: 409 });
  }

  const context = findKeyContext(key);
  const value = await generateMissingKeyValue(key, context);
  if (!value) return Response.json({ error: "AI metin üretemedi (model çalışıyor mu?)" }, { status: 502 });

  setPath(en, key, value);
  saveLocale(SOURCE_LOCALE, en);
  return Response.json({ ok: true, value, context });
}

async function handleVerifySame(req: Request): Promise<Response> {
  const { key, locale } = await req.json();
  if (!key || !locale) return Response.json({ error: "geçersiz istek" }, { status: 400 });
  const en = loadLocale(SOURCE_LOCALE);
  const sourceText = getPath(en, key);
  if (typeof sourceText !== "string") return Response.json({ error: "key kaynak dilde bulunamadı" }, { status: 400 });

  const verdict = await judgeSameTranslation(sourceText, locale, key);
  if (!verdict) return Response.json({ error: "AI doğrulama başarısız (model çalışıyor mu?)" }, { status: 502 });
  if (verdict.plausible) markConfirmedSame(key, locale);
  return Response.json(verdict);
}

// AI'nın "şüpheli" demesine rağmen kullanıcı bu eşitliğin kasıtlı/doğru olduğunu biliyorsa
// (örn. "Flashcards" gibi bilinçli bırakılan bir terim) AI'ya sormadan direkt onaylar.
async function handleConfirmSame(req: Request): Promise<Response> {
  const { key, locale } = await req.json();
  if (!key || !locale) return Response.json({ error: "geçersiz istek" }, { status: 400 });
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

        const pairs: { key: string; locale: string; sourceText: string }[] = [];
        for (const key of keys) {
          const sourceText = getPath(en, key);
          if (typeof sourceText !== "string") continue;
          for (const c of allCodes) {
            if (isConfirmedSame(confirmedSame, key, c)) continue;
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

// ---------- Frontend (tek dosya, framework yok) ----------
const DASHBOARD_HTML = `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>i18n Dashboard</title>
<style>
  :root {
    --bg: #09090b; --panel: #0f0f12; --panel2: #18181b; --panel3: #202024; --border: #27272a; --border-hover: #3f3f46;
    --text: #fafafa; --muted: #a1a1aa; --muted-2: #71717a; --accent: #6366f1; --accent-fg: #ffffff;
    --ok: #22c55e; --warn: #eab308; --bad: #f43f5e;
    --radius: 8px; --radius-sm: 6px; --radius-full: 999px;
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.4);
    --shadow-md: 0 4px 16px rgba(0,0,0,0.35);
  }
  * { box-sizing: border-box; }
  ::selection { background: rgba(99,102,241,0.35); }
  ::-webkit-scrollbar { width: 10px; height: 10px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-hover); border-radius: var(--radius-full); border: 2px solid var(--panel); }
  ::-webkit-scrollbar-thumb:hover { background: var(--muted-2); }

  body {
    margin: 0; color: var(--text);
    background: radial-gradient(circle at 15% 0%, #131318 0%, var(--bg) 45%);
    background-attachment: fixed;
    font: 13px/1.55 "Inter", -apple-system, "Segoe UI", system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
  }

  #topbar {
    display: flex; align-items: center; gap: 14px; padding: 12px 20px;
    background: color-mix(in srgb, var(--panel) 92%, transparent);
    backdrop-filter: blur(8px);
    border-bottom: 1px solid var(--border);
  }
  #topbar h1 { font-size: 14px; margin: 0; font-weight: 600; letter-spacing: -0.01em; }
  #stats { color: var(--muted); font-size: 12px; }

  .autofix-pill {
    font-size: 11px; font-weight: 500; padding: 5px 12px; border-radius: var(--radius-full);
    background: var(--panel2); color: var(--muted); border: 1px solid var(--border); white-space: nowrap;
    transition: color 150ms ease, border-color 150ms ease;
  }
  .autofix-pill.active { color: var(--ok); border-color: color-mix(in srgb, var(--ok) 40%, var(--border)); background: color-mix(in srgb, var(--ok) 10%, var(--panel2)); }
  .autofix-pill.paused { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 40%, var(--border)); background: color-mix(in srgb, var(--warn) 10%, var(--panel2)); }

  #topbar .spacer { flex: 1; }

  .search-wrap { position: relative; display: flex; align-items: center; }
  .search-icon { position: absolute; left: 11px; color: var(--muted-2); pointer-events: none; }
  #search {
    background: var(--panel2); border: 1px solid var(--border); color: var(--text);
    padding: 7px 12px 7px 32px; border-radius: var(--radius-sm); width: 260px; font: inherit;
    transition: border-color 150ms ease, box-shadow 150ms ease, background 150ms ease;
  }
  #search:focus { outline: none; border-color: var(--accent); background: var(--panel3); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent); }
  #search::placeholder { color: var(--muted-2); }

  .btn-icon { display: inline-flex; align-items: center; gap: 7px; }
  .btn-icon svg { flex-shrink: 0; }

  label.chk { color: var(--muted); font-size: 12.5px; display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
  label.chk input { accent-color: var(--accent); width: 14px; height: 14px; }

  #layout { display: flex; height: calc(100vh - 49px); gap: 12px; padding: 12px; }

  #sidebar, #keylist, #detail {
    border-radius: var(--radius); border: 1px solid var(--border); background: var(--panel);
    box-shadow: var(--shadow-sm);
  }
  #sidebar { width: 224px; overflow-y: auto; flex-shrink: 0; padding: 8px; }
  #keylist { width: 320px; overflow-y: auto; flex-shrink: 0; display: flex; flex-direction: column; }
  #detail { flex: 1; overflow-y: auto; padding: 24px 28px; animation: fadeIn 180ms ease; }

  @keyframes fadeIn { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .pulse-dot {
    display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor;
    margin-right: 6px; animation: pulse 1.4s ease-in-out infinite;
  }

  .sec-item {
    padding: 8px 12px; margin-bottom: 2px; display: flex; justify-content: space-between; align-items: center;
    cursor: pointer; border-radius: var(--radius-sm); font-size: 12.5px;
    transition: background 120ms ease;
  }
  .sec-item:hover { background: var(--panel2); }
  .sec-item.active { background: var(--panel3); }
  .sec-item.active .sec-name { color: var(--text); font-weight: 500; }
  .sec-name { color: var(--muted); }

  .sec-badge { font-size: 10.5px; font-weight: 500; padding: 2px 8px; border-radius: var(--radius-full); background: var(--panel3); color: var(--muted-2); }
  .sec-badge.bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 14%, var(--panel3)); }
  .sec-badge.good { color: var(--ok); background: color-mix(in srgb, var(--ok) 14%, var(--panel3)); }

  .kl-header {
    padding: 12px 16px; color: var(--muted); font-size: 12px; font-weight: 500;
    border-bottom: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center;
    gap: 8px; flex-wrap: wrap;
  }
  .kl-header button { font-size: 11px; padding: 5px 10px; }

  .key-item {
    padding: 9px 16px; cursor: pointer; border-bottom: 1px solid var(--border);
    display: flex; align-items: center; gap: 10px; transition: background 120ms ease;
  }
  .key-item:hover { background: var(--panel2); }
  .key-item.active { background: var(--panel2); box-shadow: inset 2px 0 0 var(--accent); }

  .dot { width: 6px; height: 6px; border-radius: 50%; flex-shrink: 0; }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); } .dot.bad { background: var(--bad); }

  .key-item .kname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12.5px; }
  .key-item .ksection { color: var(--muted-2); font-size: 10.5px; margin-top: 1px; }

  button {
    background: var(--panel2); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 7px 13px; cursor: pointer; font: inherit; font-size: 12.5px; font-weight: 500;
    transition: background 120ms ease, border-color 120ms ease, opacity 120ms ease;
  }
  button:hover { background: var(--panel3); border-color: var(--border-hover); }
  button:focus-visible { outline: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 30%, transparent); }
  button:disabled { opacity: 0.45; cursor: default; }
  button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
  button.primary:hover { background: color-mix(in srgb, var(--accent) 88%, black); border-color: color-mix(in srgb, var(--accent) 88%, black); }

  textarea, input[type=text] {
    background: var(--panel2); color: var(--text); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 8px 10px; font: inherit; width: 100%; resize: vertical;
    transition: border-color 150ms ease, box-shadow 150ms ease;
  }
  textarea:focus, input[type=text]:focus {
    outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 22%, transparent);
  }

  .detail-header { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; }
  .detail-key { font-size: 16px; font-weight: 600; letter-spacing: -0.01em; }

  .detail-actions { display: flex; gap: 10px; margin: 0 0 22px; align-items: center; flex-wrap: wrap; }

  .src-box {
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px; margin-bottom: 20px; box-shadow: var(--shadow-sm);
  }
  .src-box .lbl { color: var(--muted); font-size: 11px; font-weight: 500; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.02em; }

  .lang-row {
    display: grid; grid-template-columns: 140px 1fr 110px 64px 76px; gap: 10px; align-items: start;
    padding: 12px 0; border-bottom: 1px solid var(--border);
  }
  .lang-row:last-child { border-bottom: none; }
  .lang-name { font-size: 12.5px; padding-top: 8px; font-weight: 500; }
  .lang-name .code { color: var(--muted-2); font-size: 10px; text-transform: uppercase; font-weight: 400; letter-spacing: 0.03em; }

  .status-pill {
    font-size: 10.5px; font-weight: 500; padding: 4px 8px; border-radius: var(--radius-full);
    text-align: center; height: fit-content; margin-top: 5px;
  }
  .status-pill.missing { background: color-mix(in srgb, var(--bad) 15%, transparent); color: var(--bad); }
  .status-pill.empty { background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
  .status-pill.same { background: color-mix(in srgb, var(--warn) 15%, transparent); color: var(--warn); }
  .status-pill.same.low-conf { background: color-mix(in srgb, var(--muted-2) 15%, transparent); color: var(--muted); }
  .status-pill.ok { background: color-mix(in srgb, var(--ok) 15%, transparent); color: var(--ok); }

  .verify-one-btn { font-size: 10.5px; padding: 5px 8px; }
  .lang-actions { display: flex; flex-direction: column; gap: 4px; }
  .confirm-same-btn { font-size: 10.5px; padding: 5px 8px; }

  .progress-wrap { display: none; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); }
  .progress-bar { width: 140px; height: 6px; background: var(--panel3); border-radius: var(--radius-full); overflow: hidden; }
  .progress-bar > div { height: 100%; background: var(--accent); width: 0%; transition: width 200ms ease; }

  #addkey-form {
    display: none; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 14px; margin: 0 16px 12px; box-shadow: var(--shadow-sm);
  }
  #addkey-form .row { margin-bottom: 10px; }
  #addkey-form .row label { display: block; color: var(--muted); font-size: 11px; font-weight: 500; margin-bottom: 5px; }

  .empty-hint { color: var(--muted-2); padding: 40px; text-align: center; font-size: 13px; }

  .modal-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6);
    align-items: center; justify-content: center; z-index: 50; backdrop-filter: blur(2px);
  }
  .modal-overlay.open { display: flex; }
  .modal-card {
    width: min(640px, 92vw); max-height: 82vh; display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    box-shadow: var(--shadow-md); animation: fadeIn 160ms ease;
  }
  .modal-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 14px 18px; border-bottom: 1px solid var(--border);
  }
  .modal-header h2 { margin: 0; font-size: 14px; font-weight: 600; letter-spacing: -0.01em; }
  .modal-close {
    background: transparent; border: none; color: var(--muted); font-size: 14px; padding: 4px 8px;
  }
  .modal-close:hover { color: var(--text); background: var(--panel2); }
  .modal-body { padding: 16px 18px; overflow-y: auto; }

  .cu-summary { color: var(--muted); font-size: 12.5px; margin-bottom: 18px; }
  .cu-section-title { font-size: 12px; font-weight: 600; color: var(--text); margin: 0 0 8px; }
  .cu-hint { font-size: 11px; color: var(--muted-2); margin: -4px 0 8px; }
  .cu-list { margin-bottom: 20px; border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .cu-row { padding: 7px 10px; font-size: 12px; font-family: ui-monospace, monospace; border-bottom: 1px solid var(--border); word-break: break-all; }
  .cu-row:last-child { border-bottom: none; }
  .cu-row.cu-bad { color: var(--bad); background: color-mix(in srgb, var(--bad) 8%, transparent); }
  .cu-row-flex { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .cu-key { overflow: hidden; text-overflow: ellipsis; }
  .add-missing-btn { font-size: 10.5px; padding: 4px 9px; flex-shrink: 0; }
  .empty-hint.cu-ok { color: var(--ok); padding: 10px; text-align: left; }
</style>
</head>
<body>

<div id="topbar">
  <h1>i18n Dashboard</h1>
  <div id="stats"></div>
  <div id="autoFixStatus" class="autofix-pill">Otomatik onarım: yükleniyor...</div>
  <div class="spacer"></div>
  <div class="search-wrap">
    <svg class="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
    <input id="search" type="text" placeholder="Key veya metin ara..." />
  </div>
  <label class="chk"><input id="overwriteToggle" type="checkbox" /> Var olanların üzerine de yaz</label>
  <label class="chk"><input id="autoFixToggle" type="checkbox" checked /> Otomatik onarım</label>
  <button id="codeUsageBtn" class="btn-icon">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m18 16 4-4-4-4"/><path d="m6 8-4 4 4 4"/><path d="m14.5 4-5 16"/></svg>
    Kod Kullanımı
  </button>
  <button id="refreshBtn" class="btn-icon">
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/></svg>
    Yenile
  </button>
</div>

<div id="codeUsageOverlay" class="modal-overlay">
  <div class="modal-card">
    <div class="modal-header">
      <h2>Kod Kullanımı Denetimi</h2>
      <button id="closeCodeUsage" class="modal-close">✕</button>
    </div>
    <div id="codeUsageBody" class="modal-body"></div>
  </div>
</div>

<div id="layout">
  <div id="sidebar"></div>
  <div id="keylist"></div>
  <div id="detail"><div class="empty-hint">Soldan bir bölüm, ortadan bir key seçin.</div></div>
</div>

<script>
var DATA = null;
var currentSection = null;
var currentKey = null;

function el(tag, className, text) {
  var e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined && text !== null) e.textContent = text;
  return e;
}

function overallStatus(keyRow) {
  var vals = Object.values(keyRow.values);
  if (vals.some(function (v) { return v.status === "missing" || v.status === "empty"; })) return "bad";
  if (vals.some(function (v) { return v.status === "same"; })) return "warn";
  return "ok";
}

function findKeyRow(keyPath) {
  for (var i = 0; i < DATA.sections.length; i++) {
    var sec = DATA.sections[i];
    for (var j = 0; j < sec.keys.length; j++) {
      if (sec.keys[j].key === keyPath) return sec.keys[j];
    }
  }
  return null;
}

async function loadData() {
  var res = await fetch("/api/data");
  DATA = await res.json();
  renderStats();
  renderSidebar();
  renderKeyList();
  renderDetail();
}

function renderStats() {
  var totalKeys = 0, totalCells = 0, okCells = 0;
  DATA.sections.forEach(function (sec) {
    totalKeys += sec.keyCount;
    sec.keys.forEach(function (k) {
      Object.values(k.values).forEach(function (v) {
        totalCells++;
        if (v.status === "ok") okCells++;
      });
    });
  });
  var pct = totalCells ? Math.round((okCells / totalCells) * 1000) / 10 : 100;
  document.getElementById("stats").textContent = totalKeys + " key · " + okCells + "/" + totalCells + " çeviri tamam (%" + pct + ")";
}

function renderSidebar() {
  var container = document.getElementById("sidebar");
  container.innerHTML = "";
  DATA.sections.forEach(function (sec) {
    var item = el("div", "sec-item" + (sec.name === currentSection ? " active" : ""));
    item.dataset.section = sec.name;
    item.appendChild(el("span", "sec-name", sec.name));
    item.appendChild(el("span", "sec-badge " + (sec.missingCount > 0 ? "bad" : "good"), sec.missingCount + "/" + (sec.keyCount * DATA.targetLocales.length)));
    container.appendChild(item);
  });
}

function currentSectionData() {
  return DATA.sections.find(function (s) { return s.name === currentSection; });
}

function renderKeyList() {
  var container = document.getElementById("keylist");
  container.innerHTML = "";
  var term = document.getElementById("search").value.trim().toLowerCase();

  var header = el("div", "kl-header");
  var rows = [];

  if (term) {
    DATA.sections.forEach(function (sec) {
      sec.keys.forEach(function (k) {
        if (k.key.toLowerCase().indexOf(term) >= 0 || String(k.en).toLowerCase().indexOf(term) >= 0) rows.push(k);
      });
    });
    header.appendChild(el("span", null, "Arama: " + rows.length + " sonuç"));
  } else if (currentSection) {
    var sec = currentSectionData();
    rows = sec ? sec.keys : [];
    header.appendChild(el("span", null, currentSection + " (" + rows.length + ")"));

    var translateSecBtn = el("button", null, "Bölümü Çevir");
    translateSecBtn.id = "translateSectionBtn";
    header.appendChild(translateSecBtn);

    var verifySecBtn = el("button", null, "Aynı Olanları Doğrula");
    verifySecBtn.id = "verifySectionBtn";
    header.appendChild(verifySecBtn);

    var progress = el("span", "progress-wrap");
    progress.id = "sectionProgress";
    var bar = el("div", "progress-bar");
    var fill = el("div");
    bar.appendChild(fill);
    progress.appendChild(bar);
    var progressText = el("span");
    progressText.id = "sectionProgressText";
    progress.appendChild(progressText);
    header.appendChild(progress);
  } else {
    header.appendChild(el("span", null, "Bir bölüm seçin"));
  }
  container.appendChild(header);

  if (currentSection && !term) {
    var form = buildAddKeyForm();
    container.appendChild(form);
  }

  rows.forEach(function (k) {
    var item = el("div", "key-item" + (k.key === currentKey ? " active" : ""));
    item.dataset.key = k.key;
    item.appendChild(el("span", "dot " + overallStatus(k)));
    var mid = el("div", null);
    mid.style.overflow = "hidden";
    mid.appendChild(el("div", "kname", k.key.split(".").slice(1).join(".") || k.key));
    if (term) mid.appendChild(el("div", "ksection", k.key.split(".")[0]));
    item.appendChild(mid);
    container.appendChild(item);
  });
}

function buildAddKeyForm() {
  var wrap = el("div", null);
  var toggle = el("button", null, "+ Yeni Key Ekle");
  toggle.id = "addKeyToggleBtn";
  var form = el("div");
  form.id = "addkey-form";

  var row1 = el("div", "row");
  row1.appendChild(el("label", null, "Key adı (bölüm hariç, ör. newLabel ya da group.sub)"));
  var keyInput = el("input"); keyInput.type = "text"; keyInput.id = "newKeyName";
  row1.appendChild(keyInput);

  var row2 = el("div", "row");
  row2.appendChild(el("label", null, "İngilizce metin (kaynak)"));
  var valInput = el("textarea"); valInput.id = "newKeyValue"; valInput.rows = 2;
  row2.appendChild(valInput);

  var row3 = el("div", "row");
  var submitBtn = el("button", "primary", "Ekle ve Çevir");
  submitBtn.id = "submitAddKey";
  row3.appendChild(submitBtn);
  var cancelBtn = el("button", null, "Vazgeç");
  cancelBtn.id = "cancelAddKey";
  row3.appendChild(cancelBtn);

  form.appendChild(row1);
  form.appendChild(row2);
  form.appendChild(row3);

  wrap.appendChild(toggle);
  wrap.appendChild(form);
  return wrap;
}

function statusLabel(status, confidence) {
  if (status === "missing") return "eksik";
  if (status === "empty") return "boş";
  if (status === "same") return confidence === "low" ? "aynı (muhtemelen ortak kelime)" : "aynı (kontrol et)";
  return "ok";
}

// Dizi (array) değerli key'ler tek textarea'da her satır bir madde olacak şekilde gösteriliyor
function toDisplayValue(v) {
  if (Array.isArray(v)) return v.join("\\n");
  return v || "";
}

function fromDisplayValue(text, isArray) {
  if (!isArray) return text;
  return text.split("\\n").map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 0; });
}

function renderDetail() {
  var container = document.getElementById("detail");
  container.innerHTML = "";
  if (!currentKey) {
    container.appendChild(el("div", "empty-hint", "Soldan bir bölüm, ortadan bir key seçin."));
    return;
  }
  var row = findKeyRow(currentKey);
  if (!row) {
    container.appendChild(el("div", "empty-hint", "Key bulunamadı."));
    return;
  }

  var header = el("div", "detail-header");
  header.appendChild(el("div", "detail-key", currentKey));
  container.appendChild(header);

  var isArrayKey = Array.isArray(row.en);

  var srcBox = el("div", "src-box");
  srcBox.appendChild(el("div", "lbl", isArrayKey ? "Kaynak metin listesi (en) — her satır bir madde" : "Kaynak metin (en)"));
  var srcArea = el("textarea");
  srcArea.rows = isArrayKey ? Math.min(Math.max(row.en.length, 2), 8) : 2;
  srcArea.value = toDisplayValue(row.en);
  srcArea.dataset.locale = "en";
  srcArea.dataset.isArray = isArrayKey ? "1" : "0";
  srcArea.classList.add("src-input");
  srcBox.appendChild(srcArea);
  var srcSaveBtn = el("button", null, "Kaydet");
  srcSaveBtn.classList.add("save-src-btn");
  srcSaveBtn.style.marginTop = "6px";
  srcBox.appendChild(srcSaveBtn);
  container.appendChild(srcBox);

  var actions = el("div", "detail-actions");
  var translateAllBtn = el("button", "primary", "Bu Key'i Çevir");
  translateAllBtn.id = "translateKeyBtn";
  actions.appendChild(translateAllBtn);
  container.appendChild(actions);

  DATA.targetLocales.forEach(function (code) {
    var lang = DATA.languages.find(function (l) { return l.code === code; });
    var cell = row.values[code];
    var langRow = el("div", "lang-row");
    langRow.dataset.locale = code;

    var nameCol = el("div", "lang-name");
    nameCol.appendChild(el("div", null, lang.native));
    nameCol.appendChild(el("div", "code", code + " · " + lang.english));
    langRow.appendChild(nameCol);

    var textArea = el("textarea");
    textArea.rows = isArrayKey ? Math.min(Math.max(row.en.length, 2), 8) : 2;
    textArea.value = toDisplayValue(cell.value);
    textArea.dataset.locale = code;
    textArea.dataset.isArray = isArrayKey ? "1" : "0";
    textArea.classList.add("value-input");
    langRow.appendChild(textArea);

    var pillClass = "status-pill " + cell.status + (cell.status === "same" && cell.confidence === "low" ? " low-conf" : "");
    var pill = el("div", pillClass, statusLabel(cell.status, cell.confidence));
    pill.classList.add("status-cell");
    langRow.appendChild(pill);

    var miniBtn = el("button", null, "Çevir");
    miniBtn.classList.add("translate-one-btn");
    miniBtn.dataset.locale = code;
    langRow.appendChild(miniBtn);

    if (cell.status === "same") {
      var actionsWrap = el("div", "lang-actions");
      var verifyBtn = el("button", "verify-one-btn", "AI Doğrula");
      verifyBtn.dataset.locale = code;
      actionsWrap.appendChild(verifyBtn);
      var confirmBtn = el("button", "confirm-same-btn", "Onayla");
      confirmBtn.title = "AI ne derse desin, bu eşleşme doğru diye işaretle";
      confirmBtn.dataset.locale = code;
      actionsWrap.appendChild(confirmBtn);
      langRow.appendChild(actionsWrap);
    } else {
      langRow.appendChild(el("span"));
    }

    container.appendChild(langRow);
  });
}

// ---------- Event delegation ----------
document.getElementById("sidebar").addEventListener("click", function (e) {
  var item = e.target.closest(".sec-item");
  if (!item) return;
  currentSection = item.dataset.section;
  currentKey = null;
  document.getElementById("search").value = "";
  renderSidebar();
  renderKeyList();
  renderDetail();
});

document.getElementById("keylist").addEventListener("click", function (e) {
  var keyItem = e.target.closest(".key-item");
  if (keyItem) {
    currentKey = keyItem.dataset.key;
    if (!document.getElementById("search").value.trim()) {
      renderKeyList();
    } else {
      document.querySelectorAll(".key-item").forEach(function (n) { n.classList.toggle("active", n.dataset.key === currentKey); });
      currentSection = currentKey.split(".")[0];
      renderSidebar();
    }
    renderDetail();
    return;
  }
  if (e.target.id === "addKeyToggleBtn") {
    var form = document.getElementById("addkey-form");
    form.style.display = form.style.display === "block" ? "none" : "block";
    return;
  }
  if (e.target.id === "cancelAddKey") {
    document.getElementById("addkey-form").style.display = "none";
    return;
  }
  if (e.target.id === "submitAddKey") {
    submitAddKey();
    return;
  }
  if (e.target.id === "translateSectionBtn") {
    var overwrite = document.getElementById("overwriteToggle").checked;
    translateSection(currentSection, overwrite);
    return;
  }
  if (e.target.id === "verifySectionBtn") {
    verifySection(currentSection);
    return;
  }
});

document.getElementById("search").addEventListener("input", function () {
  renderKeyList();
});

document.getElementById("refreshBtn").addEventListener("click", function () {
  loadData();
});

document.getElementById("autoFixToggle").addEventListener("change", async function (e) {
  await fetch("/api/auto-fix", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: e.target.checked }),
  });
});

function renderAutoFixStatus(status) {
  var pill = document.getElementById("autoFixStatus");
  var toggle = document.getElementById("autoFixToggle");
  toggle.checked = !!status.enabled;
  pill.classList.remove("active", "paused");
  pill.innerHTML = "";
  if (!status.enabled) {
    pill.appendChild(document.createTextNode("Otomatik onarım: duraklatıldı"));
    pill.classList.add("paused");
  } else if (status.running) {
    pill.appendChild(el("span", "pulse-dot"));
    pill.appendChild(document.createTextNode("Otomatik onarım: " + status.currentKey + " çevriliyor (" + status.remainingKeys + " key kaldı)"));
    pill.classList.add("active");
  } else if (status.remainingKeys > 0) {
    pill.appendChild(document.createTextNode("Otomatik onarım: " + status.remainingKeys + " key bekliyor"));
    pill.classList.add("active");
  } else {
    pill.appendChild(document.createTextNode("Otomatik onarım: eksik yok"));
    pill.classList.add("active");
  }
}

var lastAutoFixCount = -1;
var autoFixEvents = new EventSource("/events");
autoFixEvents.onmessage = function (e) {
  var status = JSON.parse(e.data);
  renderAutoFixStatus(status);
  if (status.fixedThisPass !== lastAutoFixCount) {
    lastAutoFixCount = status.fixedThisPass;
    loadData();
  }
};

async function submitAddKey() {
  var nameEl = document.getElementById("newKeyName");
  var valEl = document.getElementById("newKeyValue");
  var name = nameEl.value.trim();
  var value = valEl.value.trim();
  if (!name || !value) { alert("Key adı ve İngilizce metin gerekli."); return; }
  var fullKey = currentSection + "." + name;
  var res = await fetch("/api/add-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: fullKey, value: value }),
  });
  var data = await res.json();
  if (data.error) { alert(data.error); return; }
  await loadData();
  currentKey = fullKey;
  renderKeyList();
  renderDetail();
  // yeni key'i hemen tüm dillere çevir
  await translateWholeKey(fullKey, false);
}

// ---------- Detail panel: kayıt & çeviri işlemleri (event delegation) ----------
document.getElementById("detail").addEventListener("click", async function (e) {
  if (e.target.classList.contains("save-src-btn")) {
    var srcArea = document.querySelector(".src-input");
    var srcValue = fromDisplayValue(srcArea.value, srcArea.dataset.isArray === "1");
    await saveValue(currentKey, "en", srcValue);
    await loadData();
    renderKeyList();
    renderDetail();
    return;
  }
  if (e.target.id === "translateKeyBtn") {
    var overwrite = document.getElementById("overwriteToggle").checked;
    await translateWholeKey(currentKey, overwrite);
    return;
  }
  if (e.target.classList.contains("translate-one-btn")) {
    var locale = e.target.dataset.locale;
    e.target.disabled = true;
    var res = await fetch("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: currentKey, overwrite: true, locales: [locale] }),
    });
    var data = await res.json();
    e.target.disabled = false;
    if (data.error) { alert(data.error); return; }
    if (!data.translations || !data.translations[locale]) {
      alert("Model bu dil için çeviri döndürmedi, tekrar dene.");
      return;
    }
    await loadData();
    renderKeyList();
    renderDetail();
    return;
  }
  if (e.target.classList.contains("verify-one-btn")) {
    var vLocale = e.target.dataset.locale;
    e.target.disabled = true;
    e.target.textContent = "Doğrulanıyor...";
    var vRes = await fetch("/api/verify-same", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: currentKey, locale: vLocale }),
    });
    var vData = await vRes.json();
    e.target.disabled = false;
    e.target.textContent = "AI Doğrula";
    if (vData.error) { alert(vData.error); return; }
    var verdictMsg = vData.plausible
      ? "Onaylandı: gerçek bir çeviri/kognat. " + vData.reason
      : "Şüpheli: muhtemelen çevrilmemiş. " + vData.reason;
    alert(verdictMsg);
    await loadData();
    renderKeyList();
    renderDetail();
    return;
  }
  if (e.target.classList.contains("confirm-same-btn")) {
    var cLocale = e.target.dataset.locale;
    e.target.disabled = true;
    await fetch("/api/confirm-same", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: currentKey, locale: cLocale }),
    });
    e.target.disabled = false;
    await loadData();
    renderKeyList();
    renderDetail();
    return;
  }
});

document.getElementById("detail").addEventListener("blur", async function (e) {
  if (e.target.classList.contains("value-input")) {
    var value = fromDisplayValue(e.target.value, e.target.dataset.isArray === "1");
    await saveValue(currentKey, e.target.dataset.locale, value);
    await loadData();
    renderKeyList();
  }
}, true);

async function saveValue(key, locale, value) {
  await fetch("/api/save", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: key, locale: locale, value: value }),
  });
}

async function translateWholeKey(key, overwrite) {
  var btn = document.getElementById("translateKeyBtn");
  if (btn) { btn.disabled = true; btn.textContent = "Çevriliyor..."; }
  var res = await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: key, overwrite: overwrite }),
  });
  var data = await res.json();
  if (btn) { btn.disabled = false; btn.textContent = "Bu Key'i Çevir"; }
  if (data.error) { alert(data.error); return; }
  if (data.skipped) {
    alert('Bu key zaten tüm hedef dillerde dolu. Üzerine yeniden yazmak için üstteki "Var olanların üzerine de yaz" kutusunu işaretleyip tekrar dene.');
    return;
  }
  if (data.unfilled && data.unfilled.length > 0) {
    alert("Şu diller için model çeviri döndürmedi: " + data.unfilled.join(", ") + ". Tekrar deneyebilirsin.");
  }
  await loadData();
  renderKeyList();
  renderDetail();
}

async function translateSection(section, overwrite) {
  var btn = document.getElementById("translateSectionBtn");
  var progress = document.getElementById("sectionProgress");
  var progressText = document.getElementById("sectionProgressText");
  var fill = progress ? progress.querySelector(".progress-bar > div") : null;
  if (btn) btn.disabled = true;
  if (progress) progress.style.display = "flex";
  if (fill) fill.style.width = "0%";

  var res = await fetch("/api/translate-section", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ section: section, overwrite: overwrite }),
  });
  var reader = res.body.getReader();
  var decoder = new TextDecoder();
  var buffer = "";
  var total = 0;
  var done = 0;

  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    var idx = buffer.indexOf("\\n");
    while (idx >= 0) {
      var line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        var msg = JSON.parse(line);
        if (msg.type === "start") {
          total = msg.total;
        } else if (msg.type === "key") {
          done++;
          if (progressText) progressText.textContent = done + "/" + total;
          if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
        } else if (msg.type === "error") {
          alert("Hata: " + msg.message);
        } else if (msg.type === "done") {
          alert("Bölüm çevirisi bitti: " + msg.translatedCount + " key işlendi (" + msg.cellsApplied + " hücre dolduruldu), " + msg.skippedCount + " key zaten tamdı.");
        }
      }
      idx = buffer.indexOf("\\n");
    }
  }

  if (btn) btn.disabled = false;
  if (progress) progress.style.display = "none";
  await loadData();
  renderKeyList();
  renderDetail();
}

async function verifySection(section) {
  var btn = document.getElementById("verifySectionBtn");
  var progress = document.getElementById("sectionProgress");
  var progressText = document.getElementById("sectionProgressText");
  var fill = progress ? progress.querySelector(".progress-bar > div") : null;
  if (btn) btn.disabled = true;
  if (progress) progress.style.display = "flex";
  if (fill) fill.style.width = "0%";

  var res = await fetch("/api/verify-section", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ section: section }),
  });
  var reader = res.body.getReader();
  var decoder = new TextDecoder();
  var buffer = "";
  var total = 0;
  var done = 0;
  var sawZero = false;

  while (true) {
    var chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    var idx = buffer.indexOf("\\n");
    while (idx >= 0) {
      var line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) {
        var msg = JSON.parse(line);
        if (msg.type === "start") {
          total = msg.total;
          sawZero = total === 0;
        } else if (msg.type === "pair") {
          done++;
          if (progressText) progressText.textContent = done + "/" + total;
          if (fill) fill.style.width = (total ? Math.round((done / total) * 100) : 0) + "%";
        } else if (msg.type === "error") {
          alert("Hata: " + msg.message);
        } else if (msg.type === "done") {
          if (sawZero) {
            alert("Bu bölümde doğrulanacak 'aynı' işaretli hücre yok.");
          } else {
            alert("Doğrulama bitti: " + msg.confirmed + " tanesi gerçek kognat/terim olarak onaylandı, " + msg.flagged + " tanesi hala şüpheli.");
          }
        }
      }
      idx = buffer.indexOf("\\n");
    }
  }

  if (btn) btn.disabled = false;
  if (progress) progress.style.display = "none";
  await loadData();
  renderKeyList();
  renderDetail();
}

document.getElementById("codeUsageBtn").addEventListener("click", openCodeUsage);
document.getElementById("closeCodeUsage").addEventListener("click", closeCodeUsage);
document.getElementById("codeUsageOverlay").addEventListener("click", function (e) {
  if (e.target.id === "codeUsageOverlay") closeCodeUsage();
});

function closeCodeUsage() {
  document.getElementById("codeUsageOverlay").classList.remove("open");
}

async function openCodeUsage() {
  var overlay = document.getElementById("codeUsageOverlay");
  var body = document.getElementById("codeUsageBody");
  overlay.classList.add("open");
  body.innerHTML = "";
  body.appendChild(el("div", "empty-hint", "Taranıyor..."));

  var res = await fetch("/api/code-usage");
  var data = await res.json();
  body.innerHTML = "";

  body.appendChild(el("div", "cu-summary", "Kodda " + data.usedKeysCount + " farklı sabit key kullanılıyor (src/**/*.ts,*.tsx)."));

  body.appendChild(el("div", "cu-section-title", "en.json'da olmayan key'ler (" + data.missingInEn.length + ")"));
  if (data.missingInEn.length === 0) {
    body.appendChild(el("div", "empty-hint cu-ok", "Hiçbiri eksik değil — kodda kullanılan her key en.json'da mevcut."));
  } else {
    var missingList = el("div", "cu-list");
    data.missingInEn.forEach(function (k) {
      var row = el("div", "cu-row cu-bad cu-row-flex");
      row.appendChild(el("span", "cu-key", k));
      var addBtn = el("button", "add-missing-btn", "AI ile Ekle");
      addBtn.dataset.key = k;
      row.appendChild(addBtn);
      missingList.appendChild(row);
    });
    body.appendChild(missingList);
  }

  body.appendChild(el("div", "cu-section-title", "Dinamik key kalıpları (" + data.dynamicPatterns.length + ")"));
  if (data.dynamicPatterns.length === 0) {
    body.appendChild(el("div", "empty-hint", "Bulunamadı."));
  } else {
    var dynList = el("div", "cu-list");
    data.dynamicPatterns.forEach(function (p) {
      dynList.appendChild(el("div", "cu-row", p));
    });
    body.appendChild(dynList);
  }

  var unusedTitle = el("div", "cu-section-title", "Kullanılmayan key'ler, olası (" + data.unusedKeys.length + ")");
  body.appendChild(unusedTitle);
  body.appendChild(el("div", "cu-hint", "Statik/bilinen dinamik kalıplarla eşleşmiyor. Kesin değil — değişkene atanıp dolaylı çağrılan bazı key'ler kaçabilir, silmeden önce elle kontrol et."));
  if (data.unusedKeys.length === 0) {
    body.appendChild(el("div", "empty-hint cu-ok", "Hiçbir aday yok."));
  } else {
    var unusedList = el("div", "cu-list");
    data.unusedKeys.forEach(function (k) {
      unusedList.appendChild(el("div", "cu-row", k));
    });
    body.appendChild(unusedList);
  }
}

document.getElementById("codeUsageBody").addEventListener("click", async function (e) {
  if (!e.target.classList.contains("add-missing-btn")) return;
  var key = e.target.dataset.key;
  e.target.disabled = true;
  e.target.textContent = "Ekleniyor...";

  var res = await fetch("/api/add-missing-key", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: key }),
  });
  var data = await res.json();
  if (data.error) {
    alert(data.error);
    e.target.disabled = false;
    e.target.textContent = "AI ile Ekle";
    return;
  }

  e.target.textContent = "Çevriliyor...";
  await fetch("/api/translate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: key, overwrite: false }),
  });

  await loadData();
  renderKeyList();
  renderDetail();
  await openCodeUsage();
});

loadData();
</script>
</body>
</html>`;

// ---------- Sunucu ----------
Bun.serve({
  port: DASHBOARD_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    try {
      if (req.method === "GET" && url.pathname === "/") {
        return new Response(DASHBOARD_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
      if (req.method === "GET" && url.pathname === "/api/auto-fix") {
        return Response.json(autoFixStatus);
      }
      if (req.method === "POST" && url.pathname === "/api/auto-fix") {
        const body = await req.json();
        autoFixStatus.enabled = !!body.enabled;
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

console.log(`\n🌍 i18n Dashboard: http://localhost:${DASHBOARD_PORT}\n`);
autoFixLoop();
