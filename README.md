# i18n Dashboard - Automated Translation Management System

**i18n Dashboard** is a professional multi-language (i18n) management tool designed for React Native (Expo) mobile education apps, leveraging **Ollama** integration. This system automatically completes UI strings in partially functional target languages through AI-powered automatic translation, quality control, and community contributions.

---

## 🎯 What Is This Project?

An automated i18n management system that:
- Automatically fills missing translations in target language files
- Validates "same" flags using AI to distinguish between legitimate cognates/technical terms and forgotten translations
- Provides a dashboard interface for manual translation contributions

### Core Capabilities

- **Auto-Fill**: Automatically completes UI strings in target language locales using AI
- **Same Flag Validation**: Uses AI to verify whether strings marked as "same" are legitimate cognates (e.g., "Flashcards", "Mindhouse Panel") or forgotten translations
- **Community Contributions**: Manual translation addition, AI-assisted English text generation for missing keys

---

## 🚀 Quick Start

> 📚 **New here? Follow the full step-by-step [TUTORIAL.md](TUTORIAL.md)** — installing Bun and Ollama, running the tool against your own project, configuration, and a dashboard usage guide.

1. Install [Bun](https://bun.sh) and [Ollama](https://ollama.com), then `ollama pull gemma4:26b`
2. Run the tool against your project (it auto-discovers the locale files):
   ```bash
   cd path/to/your-project
   bun run path/to/i18n-dashboard.tsx
   # or, from anywhere: bun run i18n-dashboard.tsx path/to/your-project
   ```
3. Open **http://localhost:5960** — Auto-Fix is on by default and starts filling missing translations immediately.

Optional: create `i18n-dash.config.json` in your project root to customize directories, models, port, and prompts — see [TUTORIAL.md](TUTORIAL.md#step-5--configure-optional) and [`i18n-dash.config.example.json`](i18n-dash.config.example.json).

---

## 📖 How It Works

### Core Logic

The dashboard supports three main stages:

#### 1️⃣ **Automatic Source Text Completion (Auto-Fill)**

Automatically fills missing translations or empty cells:
- For keys defined in source language (`en.json`)
- AI analyzes code context to generate appropriate English text
- Single API call handles all target language translations

#### 2️⃣ **"Same" Flag Validation**

Some keys may have identical values in both source and target languages:
- **Cognates/Terms**: Borrowed words like "Flashcards", "Mindhouse Panel"
- **Brand names**: Technical terms like AI, API, LMS
- **Numbers/Abbreviations**: "OK", "API", etc.

AI performs two-stage validation for these keys:
1. First model judges whether "same" is legitimate
2. Second model confirms if incorrectly flagged by first model

#### 3️⃣ **Community Contributions**

- Manual translation addition
- AI-assisted English text generation for missing keys
- Add new keys to source language

---

## 🧩 Technical Architecture

### Backend (TypeScript)

```
┌─────────────────────────────────────────────────────┐
│                    API Handlers                       │
│  - handleTranslate: Single or bulk translation        │
│  - streamTranslateSection: Section-based streaming    │
│  - handleSave: Manual save                             │
│  - handleVerifySame: AI validation                     │
└─────────────────────────────────────────────────────┘
```

### Frontend (React)

The dashboard is a React app served by Bun's fullstack server — no build step:
- `dashboard.html` (shell) + `dashboard-client.tsx` (React components) + `dashboard.css`
- Bun bundles and transpiles them on the fly when the page is requested
- Listens on port **5960** by default (configurable)

### Data Flow

```
User → t('key') → en.json missing/empty → API call
                ↓
          Ollama (base model + per-request system prompt)
                ↓
          JSON schema translation
                ↓
          All languages in single response
                ↓
          localeX.json updates
```

---

## 🛠️ Features

### ✅ Automatic Search and Fix (Auto-Fix)

Clicking the **"Search"** button in the top-right corner:
- Automatically fills missing/empty cells
- Checks every 15 seconds
- Completes all empty spaces without any user action

### ✅ Quality Control

- **Same flag**: AI determines whether "same" keys are legitimate cognates or forgotten translations
- **Ignored list**: Keys like `settings.*`, `home.appName`, `flashcards.title` are auto-approved
- **Cache system**: Translations for identical source text are cached to avoid redundant API calls

### ✅ Streaming API

For large content sets:
```bash
curl http://localhost:5960/api/translate \
  -H "Content-Type: application/json" \
  -d '{"section":"settings","overwrite":true}'
```

Response streams in **ndjson** format.

---

## 📂 File Structure

```
i18n-dash/
├── i18n-dashboard.tsx              # Backend: config, discovery, Ollama calls, API, server
├── dashboard.html                  # Frontend shell (loads the React client)
├── dashboard-client.tsx            # Frontend: React components
├── dashboard.css                   # Frontend styles
├── i18n-dash.config.example.json   # Example config for target projects
├── package.json                    # react/react-dom deps + bin entry
├── README.md                       # This file
└── .gitignore

your-project/                       # Any target repo
├── i18n-dash.config.json           # Optional — auto-discovery covers common layouts
├── .i18n-dash/                     # Tool state (translation cache + confirmed-same);
│                                   #   self-gitignored, created automatically
└── src/i18n/locales/               # (or locales/, public/locales/, …)
    ├── en.json                     # Source language
    ├── tr.json                     # Target languages (may be incomplete)
    └── ...
```

---

## 🌐 Supported Languages

- **Source Language**: English (`en`)
- **Target Languages**: 29 languages (Turkish, German, French, Spanish, Portuguese, Italian, etc.)

Languages are derived from the `.json` files present in the locales directory — add a new `xx.json` file and it becomes a target language. `i18n-dashboard.tsx` ships native/English display names for 30 common languages; unknown codes fall back to the code itself.

---

## 🔧 API Endpoints

### Translation

```bash
# Single key translation
POST /api/translate
{
  "key": "settings.themeName",
  "overwrite": true
}

# Select multiple languages
POST /api/translate
{
  "key": "settings.language",
  "locales": ["tr", "de"]
}
```

### AI-Assisted Key Generation

```bash
# Generate English text for missing key
POST /api/add-missing-key
{
  "key": "settings.newFeature"
}
```

### AI Validation

```bash
# Validate "same" flag
POST /api/verify-same
{
  "key": "home.welcome",
  "locale": "tr"
}
```

---

## 📊 Data Structure

### locale.json Example

```json
[
  {
    "translation": {
      "home.welcome": "Welcome to Mindhouse Panel",
      "settings.language": "English",
      "settings.themeName": "dark"
    }
  }
]
```

---

## 🐛 Troubleshooting

### Model Not Working

Ensure Ollama is running:
```bash
ollama list
ollama serve
```

### Cache Errors

Clear the tool's state directory (in the target project root):
```bash
rm -rf .i18n-dash
```

---

## 📝 License and Attribution

This project is licensed under the **Apache 2.0** license. Ollama models are subject to their own licenses.

For issues or inquiries: [github.com/Melih/mindhouse](https://github.com/Melih/mindhouse)

---

## 🙏 Contributors and Credits

- [Ollama](https://ollama.com/) - AI model platform
- [Gemma 4:26b](https://huggingface.co/google/gemma-4-26b-it) - Base model
- Mindhouse Panel developers

---

## ⚠️ Important Notes

1. **Do not modify source language (en.json)** files manually — the dashboard auto-updates them
2. Unless you manually edit target language files, API calls will auto-save changes
3. One process serves both the API and the React dashboard (Bun fullstack server)
4. **Auto-Fix** remains active — click the button in the top-right to pause it

---

## 📚 Additional Resources

- [i18next](https://www.i18next.com/) - Alternative i18n library
- [Crowdin](https://crowdin.com/) - Professional translation platform
- [DeepL API](https://developers.deepl.com/) - For commercial use

---

**Last Updated**: 2026-07-19
