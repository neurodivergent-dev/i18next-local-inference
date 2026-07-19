# 📚 Tutorial: From Zero to Fully Translated

This guide takes you from a blank machine to a project whose missing translations fill themselves in. Follow it once; after that it's a single command.

The tool is **project-independent**: point it at any repo that has JSON locale files and it fills the gaps automatically.

---

## Step 0 — What you need

| Requirement | Why |
|---|---|
| [Bun](https://bun.sh) | Runs the single-file tool (no build step, no dependencies) |
| [Ollama](https://ollama.com) | Runs the AI model **locally** — your strings never leave your machine |
| A project with JSON locale files | e.g. `src/i18n/locales/en.json`, `tr.json`, … (i18next-style, flat or nested keys) |

---

## Step 1 — Install Bun

```bash
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"

# macOS / Linux
curl -fsSL https://bun.sh/install | bash
```

Verify with `bun --version`.

---

## Step 2 — Install Ollama and pull the model

Download Ollama from [ollama.com](https://ollama.com), make sure it's running (`ollama list` should answer), then:

```bash
ollama pull gemma4:26b
```

> 💡 **Low on VRAM?** The default model is large. Any model from `ollama list` works — set `model` and `judgeModel` in the config (Step 5) to a smaller one. Translation quality scales with model size, but the JSON-schema-constrained output keeps even small models well-behaved.

No custom model creation is needed — the translation system prompt is sent per-request.

---

## Step 3 — Get the tool

```bash
git clone https://github.com/neurodivergent-dev/i18next-local-inference.git
```

---

## Step 4 — Run it against your project

```bash
# Option A: from inside your project
cd path/to/your-project
bun run path/to/i18next-local-inference/i18n-dashboard.tsx

# Option B: from anywhere, passing the project path
bun run i18n-dashboard.tsx path/to/your-project
```

On first launch the tool tells you exactly what it found:

```
🔎 Locale dizini otomatik bulundu: /path/to/your-project/locales

🌍 i18n Dashboard: http://localhost:5960
📁 Proje kökü: /path/to/your-project (config yok, varsayılanlar + otomatik keşif)
📂 Locale dizini: /path/to/your-project/locales — 30 dil, kaynak: en
🤖 Ollama: http://localhost:11434/api/generate | çeviri: gemma4:26b | yargıç: gemma4:26b
```

Open **http://localhost:5960** in your browser. That's it — **Auto-Fix is on by default**, so missing translations start filling in immediately, even if you never click anything.

If the locales directory can't be found automatically, the tool prints exactly what to put in the config — see the next step.

---

## Step 5 — Configure (optional)

Without any config, the tool auto-discovers the locales directory (`src/i18n/locales`, `locales`, `public/locales`, … or a limited-depth scan) and uses sensible defaults. To customize, create **`i18n-dash.config.json`** in the target project root (see [`i18n-dash.config.example.json`](i18n-dash.config.example.json) for a full example):

```json
{
  "localesDir": "src/i18n/locales",
  "srcDir": "src",
  "sourceLocale": "en",
  "model": "gemma4:26b",
  "appContext": "You are translating the UI strings of a mobile education app.",
  "ignoreSameKeyPrefixes": ["settings.english", "home.appName"],
  "ignoreSameValues": ["OK", "AI", "API"],
  "dynamicPrefixes": ["explore.steps."]
}
```

| Field | Default | Purpose |
|---|---|---|
| `localesDir` | auto-discover | Directory containing `en.json`, `tr.json`, … |
| `srcDir` | `src` (or project root) | Where `t('key')` usages are scanned |
| `sourceLocale` | `en` | Source language code |
| `ollamaUrl` | `http://localhost:11434/api/generate` | Ollama endpoint |
| `model` / `judgeModel` | `gemma4:26b` | Translation / validation models |
| `port` / `autoFixPollMs` | `5960` / `15000` | Server port / auto-fix interval |
| `appContext` | generic | App description injected into AI prompts (improves quality) |
| `ignoreSameKeyPrefixes` | `[]` | Keys where source == target is intentional |
| `ignoreSameValues` | `["OK", "AI", "API"]` | Values allowed to stay identical in all languages |
| `dynamicPrefixes` | `[]` | Key prefixes used via `t(variable)` that the regex scan can't see |

---

## Step 6 — Using the dashboard

- **The table** shows every key × every target language. Cell colors mean: `missing` (key absent), `empty` (present but blank), `same` (identical to source — maybe a forgotten translation), `ok`.
- **Auto-Fix** (top right) scans every 15 seconds and fills `missing`/`empty` cells on its own. Toggle it off if you want manual control.
- **Per-key translate**: fill one key for all languages (or a selection) in a single AI call; optionally overwrite existing values.
- **Per-section translate**: batch-translate an entire section with live streaming progress.
- **AI Verify on `same` cells**: the judge model decides whether an identical string is a legitimate cognate/brand/term or a forgotten translation. You can also force-confirm — human decisions always win over the AI.
- All edits are written directly into your locale JSON files, preserving each file's formatting and line endings.

---

## Step 7 — Review and commit

Start from a clean git tree so everything the AI wrote is visible as a diff:

```bash
git diff        # review the generated translations
git add -p      # take what you like
git commit
```

The tool's own state (translation cache, confirmed-same decisions) lives in `.i18n-dash/` in your project root and keeps itself out of git automatically.

---

## Troubleshooting

- **"Locale dizini bulunamadı"** → add `i18n-dash.config.json` with `"localesDir"` pointing at your locale folder.
- **Translations fail (502)** → is Ollama running? `ollama list` / `ollama serve`, and check the model in your config is pulled.
- **Port already in use** → set `"port"` in the config.
- **Stale cache** → delete the `.i18n-dash/` directory in your project root.

For architecture, API endpoints, and feature details, see the [README](README.md).
