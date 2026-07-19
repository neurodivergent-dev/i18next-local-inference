import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

// ---------- Types mirroring the server's /api/data payload ----------

type CellStatus = "ok" | "missing" | "empty" | "same" | "suspicious";

interface Cell {
  value: string | string[] | null;
  status: CellStatus;
  confidence?: "low" | "high";
  reason?: string; // judge's verdict for "suspicious" cells
}

interface KeyRow {
  key: string;
  en: string | string[];
  values: Record<string, Cell>;
}

interface Section {
  name: string;
  keyCount: number;
  missingCount: number;
  keys: KeyRow[];
}

interface Language {
  code: string;
  native: string;
  english: string;
}

interface Data {
  sections: Section[];
  languages: Language[];
  sourceLocale: string;
  targetLocales: string[];
}

interface AutoFixStatus {
  enabled: boolean;
  verifyEnabled: boolean;
  phase: "idle" | "translating" | "verifying";
  currentKey: string | null;
  fixedThisPass: number;
  remainingKeys: number;
  verifiedThisPass: number;
  confirmedThisPass: number;
  flaggedThisPass: number;
  remainingPairs: number;
  lastScanAt: string | null;
}

interface CodeUsage {
  usedKeysCount: number;
  missingInEn: string[];
  dynamicPatterns: string[];
  unusedKeys: string[];
}

interface ProjectInfo {
  projectRoot: string;
  projectName: string;
  localesDir: string | null;
  error: string | null;
  configPath: string;
  configExists: boolean;
  config: Record<string, any>;
  port: number;
  recents: string[];
  restartRequired?: boolean;
}

interface BrowseDir {
  name: string;
  path: string;
  isProject: boolean;
}

interface BrowseResult {
  path: string;
  parent: string | null;
  dirs: BrowseDir[];
  error?: string;
}

// ---------- API helpers ----------

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  return res.json();
}

async function postJson<T = any>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

// Consumes an ndjson streaming response line by line
async function streamNdjson(path: string, body: unknown, onMessage: (msg: any) => void): Promise<void> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let idx = buffer.indexOf("\n");
    while (idx >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.trim()) onMessage(JSON.parse(line));
      idx = buffer.indexOf("\n");
    }
  }
}

// ---------- Value display: array-valued keys are edited as one item per line ----------

function toDisplayValue(v: string | string[] | null): string {
  if (Array.isArray(v)) return v.join("\n");
  return v || "";
}

function fromDisplayValue(text: string, isArray: boolean): string | string[] {
  if (!isArray) return text;
  return text.split("\n").map((s) => s.trim()).filter((s) => s.length > 0);
}

function overallStatus(row: KeyRow): "ok" | "warn" | "bad" {
  const vals = Object.values(row.values);
  if (vals.some((v) => v.status === "missing" || v.status === "empty")) return "bad";
  if (vals.some((v) => v.status === "same" || v.status === "suspicious")) return "warn";
  return "ok";
}

function statusLabel(status: CellStatus, confidence?: string): string {
  if (status === "missing") return "missing";
  if (status === "empty") return "empty";
  if (status === "same") return confidence === "low" ? "same (likely cognate)" : "same (check it)";
  if (status === "suspicious") return "suspicious (AI)";
  return "ok";
}

interface SectionProgress {
  done: number;
  total: number;
}

// ---------- Components ----------

function ThemeToggle() {
  const [theme, setTheme] = useState<string>(() => document.documentElement.dataset.theme || "dark");
  const toggle = () => {
    const next = theme === "light" ? "dark" : "light";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem("i18n-dash-theme", next);
  };
  return (
    <button className="icon-btn" onClick={toggle} title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}>
      {theme === "light" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" /></svg>
      )}
    </button>
  );
}

function Topbar(props: {
  data: Data | null;
  autoFix: AutoFixStatus | null;
  search: string;
  onSearch: (v: string) => void;
  overwrite: boolean;
  onOverwrite: (v: boolean) => void;
  onToggleAutoFix: (enabled: boolean) => void;
  onToggleAutoVerify: (enabled: boolean) => void;
  onOpenCodeUsage: () => void;
  onRefresh: () => void;
  sweepBusy: boolean;
  sweepProgress: SectionProgress | null;
  onSweepSuspicious: () => void;
  project: ProjectInfo | null;
  onOpenProject: () => void;
  onOpenSettings: () => void;
}) {
  const { data, autoFix } = props;

  let totalKeys = 0;
  let totalCells = 0;
  let okCells = 0;
  let suspiciousCells = 0;
  if (data) {
    for (const sec of data.sections) {
      totalKeys += sec.keyCount;
      for (const k of sec.keys) {
        for (const v of Object.values(k.values)) {
          totalCells++;
          if (v.status === "ok") okCells++;
          if (v.status === "suspicious") suspiciousCells++;
        }
      }
    }
  }
  const pct = totalCells ? Math.round((okCells / totalCells) * 1000) / 10 : 0;

  let pillClass = "autofix-pill";
  let pillContent: React.ReactNode = "Auto: loading...";
  if (autoFix) {
    if (autoFix.phase === "translating") {
      pillClass += " active";
      pillContent = (
        <>
          <span className="pulse-dot" />
          {`Translating ${autoFix.currentKey} (${autoFix.remainingKeys} keys left)`}
        </>
      );
    } else if (autoFix.phase === "verifying") {
      pillClass += " active";
      pillContent = (
        <>
          <span className="pulse-dot" />
          {`Judging ${autoFix.currentKey} (${autoFix.remainingPairs} left · ${autoFix.confirmedThisPass} ok / ${autoFix.flaggedThisPass} suspicious)`}
        </>
      );
    } else if (!autoFix.enabled && !autoFix.verifyEnabled) {
      pillClass += " paused";
      pillContent = "Auto: paused";
    } else if (autoFix.remainingKeys > 0 || autoFix.remainingPairs > 0) {
      pillClass += " active";
      pillContent = `Auto: ${autoFix.remainingKeys + autoFix.remainingPairs} items pending`;
    } else {
      pillClass += " active";
      pillContent = "Auto: all caught up";
    }
  }

  return (
    <div id="topbar">
      <div className="brand">
        <span className="brand-mark">i18n</span>
        <h1>Dashboard</h1>
      </div>
      <button
        className={"btn-icon project-chip" + (props.project && !props.project.localesDir ? " project-chip-error" : "")}
        onClick={props.onOpenProject}
        title={props.project?.projectRoot || "Pick a project"}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" /></svg>
        {props.project ? (props.project.localesDir ? props.project.projectName : "Pick a project") : "..."}
      </button>
      <div id="stats">
        {data && (
          <>
            <span className="stat-chip"><strong>{totalKeys}</strong>&nbsp;keys</span>
            <span className="stat-chip">
              <span className="stat-mini-bar"><div style={{ width: pct + "%" }} /></span>
              <strong>{pct}%</strong>&nbsp;· {okCells}/{totalCells}
            </span>
          </>
        )}
      </div>
      <div className={pillClass}>{pillContent}</div>
      <div className="spacer" />
      <div className="search-wrap">
        <svg className="search-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></svg>
        <input id="search" type="text" placeholder="Search key or text..." value={props.search} onChange={(e) => props.onSearch(e.target.value)} />
      </div>
      <label className="switch-label">
        <span className="switch">
          <input type="checkbox" checked={props.overwrite} onChange={(e) => props.onOverwrite(e.target.checked)} />
          <span className="track" />
        </span>
        Overwrite existing
      </label>
      <label className="switch-label">
        <span className="switch">
          <input type="checkbox" checked={autoFix?.enabled ?? true} onChange={(e) => props.onToggleAutoFix(e.target.checked)} />
          <span className="track" />
        </span>
        Auto-fix
      </label>
      <label className="switch-label" title="Background AI judging of cells identical to the source: cognates get confirmed, likely forgotten translations get flagged">
        <span className="switch">
          <input type="checkbox" checked={autoFix?.verifyEnabled ?? true} onChange={(e) => props.onToggleAutoVerify(e.target.checked)} />
          <span className="track" />
        </span>
        Auto-verify
      </label>
      {(suspiciousCells > 0 || props.sweepBusy) && (
        <button
          className="btn-icon btn-suspicious"
          disabled={props.sweepBusy}
          onClick={props.onSweepSuspicious}
          title="Translate every cell the judge flagged as a forgotten translation"
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" /><path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" /></svg>
          {props.sweepBusy && props.sweepProgress
            ? `Sweeping ${props.sweepProgress.done}/${props.sweepProgress.total}`
            : `Fix Suspicious (${suspiciousCells})`}
        </button>
      )}
      <ThemeToggle />
      <button className="icon-btn" onClick={props.onOpenSettings} title="Project settings (models, paths, prompts)">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" /><circle cx="12" cy="12" r="3" /></svg>
      </button>
      <button className="btn-icon" onClick={props.onOpenCodeUsage}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m18 16 4-4-4-4" /><path d="m6 8-4 4 4 4" /><path d="m14.5 4-5 16" /></svg>
        Code Usage
      </button>
      <button className="btn-icon" onClick={props.onRefresh}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5" /><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" /></svg>
        Refresh
      </button>
    </div>
  );
}

function Sidebar(props: { data: Data; currentSection: string | null; onSelect: (name: string) => void }) {
  return (
    <div id="sidebar">
      {props.data.sections.map((sec) => {
        const cells = sec.keyCount * props.data.targetLocales.length;
        const pct = cells ? Math.round(((cells - sec.missingCount) / cells) * 100) : 100;
        return (
          <div
            key={sec.name}
            className={"sec-item" + (sec.name === props.currentSection ? " active" : "")}
            onClick={() => props.onSelect(sec.name)}
            title={`${sec.missingCount} of ${cells} cells need attention`}
          >
            <div className="sec-row">
              <span className="sec-name">{sec.name}</span>
              <span className={"sec-badge " + (sec.missingCount > 0 ? "bad" : "good")}>
                {sec.missingCount > 0 ? sec.missingCount : "✓"}
              </span>
            </div>
            <div className="sec-progress">
              <div className={pct === 100 ? "full" : undefined} style={{ width: pct + "%" }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

function AddKeyForm(props: { sourceLocale: string; onSubmit: (name: string, value: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");

  const submit = () => {
    if (!name.trim() || !value.trim()) {
      alert("Key name and source text are required.");
      return;
    }
    props.onSubmit(name.trim(), value.trim());
    setOpen(false);
    setName("");
    setValue("");
  };

  return (
    <div className="addkey-toggle-wrap">
      <button onClick={() => setOpen(!open)}>+ Add New Key</button>
      {open && (
        <div className="addkey-form">
          <div className="row">
            <label>Key name (without section, e.g. newLabel or group.sub)</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="row">
            <label>Source text ({props.sourceLocale})</label>
            <textarea rows={2} value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <div className="row">
            <button className="primary" onClick={submit}>Add &amp; Translate</button>{" "}
            <button onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function KeyList(props: {
  data: Data;
  search: string;
  currentSection: string | null;
  currentKey: string | null;
  sectionBusy: boolean;
  sectionProgress: SectionProgress | null;
  onSelectKey: (key: string) => void;
  onTranslateSection: () => void;
  onVerifySection: () => void;
  onAddKey: (name: string, value: string) => void;
}) {
  const term = props.search.trim().toLowerCase();
  let rows: KeyRow[] = [];
  let headerLabel: string;

  if (term) {
    for (const sec of props.data.sections) {
      for (const k of sec.keys) {
        if (k.key.toLowerCase().includes(term) || String(k.en).toLowerCase().includes(term)) rows.push(k);
      }
    }
    headerLabel = `Search: ${rows.length} results`;
  } else if (props.currentSection) {
    const sec = props.data.sections.find((s) => s.name === props.currentSection);
    rows = sec ? sec.keys : [];
    headerLabel = `${props.currentSection} (${rows.length})`;
  } else {
    headerLabel = "Select a section";
  }

  const inSection = !term && !!props.currentSection;

  return (
    <div id="keylist">
      <div className="kl-header">
        <span>{headerLabel}</span>
        {inSection && (
          <>
            <button disabled={props.sectionBusy} onClick={props.onTranslateSection}>Translate Section</button>
            <button disabled={props.sectionBusy} onClick={props.onVerifySection}>Verify Same</button>
            {props.sectionProgress && (
              <span className="progress-wrap">
                <span className="progress-bar">
                  <div style={{ width: (props.sectionProgress.total ? Math.round((props.sectionProgress.done / props.sectionProgress.total) * 100) : 0) + "%" }} />
                </span>
                <span>{props.sectionProgress.done}/{props.sectionProgress.total}</span>
              </span>
            )}
          </>
        )}
      </div>
      {inSection && <AddKeyForm sourceLocale={props.data.sourceLocale} onSubmit={props.onAddKey} />}
      {rows.map((k) => (
        <div
          key={k.key}
          className={"key-item" + (k.key === props.currentKey ? " active" : "")}
          onClick={() => props.onSelectKey(k.key)}
        >
          <span
            className={"dot " + overallStatus(k)}
            title={{ ok: "Complete", warn: "Has same-as-source cells", bad: "Has missing or empty cells" }[overallStatus(k)]}
          />
          <div style={{ overflow: "hidden" }}>
            <div className="kname">{k.key.split(".").slice(1).join(".") || k.key}</div>
            {term ? <div className="ksection">{k.key.split(".")[0]}</div> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function Detail(props: {
  data: Data;
  dataVersion: number;
  currentKey: string | null;
  onSave: (key: string, locale: string, value: string | string[]) => Promise<void>;
  onTranslateKey: () => Promise<void>;
  onTranslateOne: (locale: string) => Promise<void>;
  onVerifyOne: (locale: string) => Promise<void>;
  onConfirmSame: (locale: string) => Promise<void>;
}) {
  const [translating, setTranslating] = useState(false);
  const [busyLocale, setBusyLocale] = useState<string | null>(null);
  const [verifyingLocale, setVerifyingLocale] = useState<string | null>(null);

  if (!props.currentKey) {
    return (
      <div id="detail">
        <div className="empty-hint">
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="m5 8 6 6" /><path d="m4 14 6-6 2-3" /><path d="M2 5h12" /><path d="M7 2h1" /><path d="m22 22-5-10-5 10" /><path d="M14 18h6" /></svg>
          Select a section on the left, then a key.
        </div>
      </div>
    );
  }

  let row: KeyRow | null = null;
  for (const sec of props.data.sections) {
    const found = sec.keys.find((k) => k.key === props.currentKey);
    if (found) { row = found; break; }
  }
  if (!row) {
    return <div id="detail"><div className="empty-hint">Key not found.</div></div>;
  }

  const isArrayKey = Array.isArray(row.en);
  const rowCount = isArrayKey ? Math.min(Math.max((row.en as string[]).length, 2), 8) : 2;
  const src = props.data.sourceLocale;

  return (
    <div id="detail">
      <div className="detail-header">
        <div className="detail-key">{props.currentKey}</div>
      </div>

      <div className="src-box">
        <div className="lbl">{isArrayKey ? `Source text list (${src}) — one item per line` : `Source text (${src})`}</div>
        <textarea
          key={`src:${props.currentKey}:${props.dataVersion}`}
          rows={rowCount}
          defaultValue={toDisplayValue(row.en)}
          onBlur={(e) => props.onSave(props.currentKey!, src, fromDisplayValue(e.target.value, isArrayKey))}
        />
      </div>

      <div className="detail-actions">
        <button
          className="primary"
          disabled={translating}
          onClick={async () => {
            setTranslating(true);
            try { await props.onTranslateKey(); } finally { setTranslating(false); }
          }}
        >
          {translating ? "Translating..." : "Translate This Key"}
        </button>
      </div>

      {props.data.targetLocales.map((code) => {
        const lang = props.data.languages.find((l) => l.code === code)!;
        const cell = row!.values[code];
        const pillClass = "status-pill " + cell.status + (cell.status === "same" && cell.confidence === "low" ? " low-conf" : "");
        return (
          <div className="lang-row" key={code}>
            <div className="lang-name">
              <div>{lang.native}</div>
              <div className="code">{code} · {lang.english}</div>
            </div>
            <textarea
              key={`${code}:${props.currentKey}:${props.dataVersion}`}
              rows={rowCount}
              defaultValue={toDisplayValue(cell.value)}
              onBlur={(e) => props.onSave(props.currentKey!, code, fromDisplayValue(e.target.value, isArrayKey))}
            />
            <div className={pillClass} title={cell.reason}><span className="pill-dot" />{statusLabel(cell.status, cell.confidence)}</div>
            <button
              className="translate-one-btn"
              disabled={busyLocale === code}
              onClick={async () => {
                setBusyLocale(code);
                try { await props.onTranslateOne(code); } finally { setBusyLocale(null); }
              }}
            >
              Translate
            </button>
            {cell.status === "same" || cell.status === "suspicious" ? (
              <div className="lang-actions">
                <button
                  className="verify-one-btn"
                  disabled={verifyingLocale === code}
                  onClick={async () => {
                    setVerifyingLocale(code);
                    try { await props.onVerifyOne(code); } finally { setVerifyingLocale(null); }
                  }}
                >
                  {verifyingLocale === code ? "Verifying..." : "AI Verify"}
                </button>
                <button
                  className="confirm-same-btn"
                  title="Mark this identical pair as correct, whatever the AI says"
                  onClick={() => props.onConfirmSame(code)}
                >
                  Confirm
                </button>
              </div>
            ) : (
              <span />
            )}
          </div>
        );
      })}
    </div>
  );
}

function CodeUsageModal(props: { sourceLocale: string; onClose: () => void; onDataChanged: () => Promise<void> }) {
  const [usage, setUsage] = useState<CodeUsage | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [busyPhase, setBusyPhase] = useState<string>("");

  const load = useCallback(async () => {
    setUsage(null);
    setUsage(await getJson<CodeUsage>("/api/code-usage"));
  }, []);

  useEffect(() => { load(); }, [load]);

  const addMissing = async (key: string) => {
    setBusyKey(key);
    setBusyPhase("Adding...");
    const data = await postJson("/api/add-missing-key", { key });
    if (data.error) {
      alert(data.error);
      setBusyKey(null);
      return;
    }
    setBusyPhase("Translating...");
    await postJson("/api/translate", { key, overwrite: false });
    setBusyKey(null);
    await props.onDataChanged();
    await load();
  };

  const src = props.sourceLocale;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal-card">
        <div className="modal-header">
          <h2>Code Usage Audit</h2>
          <button className="modal-close" onClick={props.onClose}>✕</button>
        </div>
        <div className="modal-body">
          {!usage ? (
            <div className="empty-hint">Scanning...</div>
          ) : (
            <>
              <div className="cu-summary">{usage.usedKeysCount} distinct static keys are used in code.</div>

              <div className="cu-section-title">Keys missing from {src}.json ({usage.missingInEn.length})</div>
              {usage.missingInEn.length === 0 ? (
                <div className="empty-hint cu-ok">None missing — every key used in code exists in {src}.json.</div>
              ) : (
                <div className="cu-list">
                  {usage.missingInEn.map((k) => (
                    <div className="cu-row cu-bad cu-row-flex" key={k}>
                      <span className="cu-key">{k}</span>
                      <button className="add-missing-btn" disabled={busyKey === k} onClick={() => addMissing(k)}>
                        {busyKey === k ? busyPhase : "Add via AI"}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="cu-section-title">Dynamic key patterns ({usage.dynamicPatterns.length})</div>
              {usage.dynamicPatterns.length === 0 ? (
                <div className="empty-hint">None found.</div>
              ) : (
                <div className="cu-list">
                  {usage.dynamicPatterns.map((p) => <div className="cu-row" key={p}>{p}</div>)}
                </div>
              )}

              <div className="cu-section-title">Possibly unused keys ({usage.unusedKeys.length})</div>
              <div className="cu-hint">Not matched by static usage or known dynamic patterns. Not definitive — keys called indirectly through variables can slip through; check manually before deleting.</div>
              {usage.unusedKeys.length === 0 ? (
                <div className="empty-hint cu-ok">No candidates.</div>
              ) : (
                <div className="cu-list">
                  {usage.unusedKeys.map((k) => <div className="cu-row" key={k}>{k}</div>)}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function ProjectModal(props: { project: ProjectInfo | null; onClose: () => void; onSwitched: (info: ProjectInfo) => void }) {
  const [browse, setBrowse] = useState<BrowseResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(props.project?.error ?? null);

  const nav = useCallback(async (path: string) => {
    const res = await getJson<BrowseResult>("/api/browse?path=" + encodeURIComponent(path));
    if (!res.error) setBrowse(res);
  }, []);

  useEffect(() => {
    nav(props.project?.projectRoot || "");
  }, [nav, props.project?.projectRoot]);

  const open = async (path: string) => {
    setBusy(true);
    try {
      const info = await postJson<ProjectInfo>("/api/project", { path });
      props.onSwitched(info);
      if (info.localesDir) props.onClose();
      else setError(info.error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal-card">
        <div className="modal-header">
          <h2>Open Project</h2>
          <button className="modal-close" onClick={props.onClose}>✕</button>
        </div>
        <div className="modal-body">
          {error && <div className="proj-error">{error}</div>}

          {(props.project?.recents?.length ?? 0) > 0 && (
            <>
              <div className="cu-section-title">Recent projects</div>
              <div className="cu-list">
                {props.project!.recents.map((p) => (
                  <div className="cu-row cu-row-flex proj-row" key={p} onClick={() => open(p)}>
                    <span className="cu-key">{p}</span>
                    <button className="add-missing-btn" disabled={busy}>Open</button>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="cu-section-title">Browse folders</div>
          <div className="proj-path">{browse?.path || "Computer"}</div>
          <div className="cu-list proj-browser">
            {browse?.parent !== null && browse !== null && (
              <div className="cu-row proj-row" onClick={() => nav(browse.parent || "")}>.. (up)</div>
            )}
            {browse?.dirs.map((d) => (
              <div className="cu-row cu-row-flex proj-row" key={d.path} onClick={() => nav(d.path)}>
                <span className="cu-key">{d.isProject ? "📦 " : "📁 "}{d.name}</span>
              </div>
            ))}
          </div>
          <button className="primary" disabled={busy || !browse?.path} onClick={() => open(browse!.path)}>
            {busy ? "Opening..." : "Use this folder as the project"}
          </button>
        </div>
      </div>
    </div>
  );
}

function SettingsModal(props: { project: ProjectInfo; onClose: () => void; onSaved: (info: ProjectInfo) => void }) {
  const cfg = props.project.config;
  const [models, setModels] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    localesDir: cfg.localesDir ?? "",
    srcDir: cfg.srcDir ?? "",
    sourceLocale: cfg.sourceLocale ?? "en",
    ollamaUrl: cfg.ollamaUrl ?? "",
    model: cfg.model ?? "",
    judgeModel: cfg.judgeModel ?? "",
    appContext: cfg.appContext ?? "",
    autoVerify: cfg.autoVerify !== false,
    port: cfg.port ?? props.project.port,
    ignoreSameValues: (cfg.ignoreSameValues ?? []).join(", "),
    ignoreSameKeyPrefixes: (cfg.ignoreSameKeyPrefixes ?? []).join("\n"),
    dynamicPrefixes: (cfg.dynamicPrefixes ?? []).join("\n"),
  });

  useEffect(() => {
    getJson<{ models: string[] }>("/api/ollama-models").then((r) => setModels(r.models ?? []));
  }, []);

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setBusy(true);
    try {
      const payload = {
        localesDir: form.localesDir.trim(),
        srcDir: form.srcDir.trim(),
        sourceLocale: form.sourceLocale.trim() || "en",
        ollamaUrl: form.ollamaUrl.trim(),
        model: form.model.trim(),
        judgeModel: form.judgeModel.trim(),
        appContext: form.appContext.trim(),
        autoVerify: form.autoVerify,
        port: Number(form.port) || props.project.port,
        ignoreSameValues: form.ignoreSameValues.split(",").map((s: string) => s.trim()).filter(Boolean),
        ignoreSameKeyPrefixes: form.ignoreSameKeyPrefixes.split("\n").map((s: string) => s.trim()).filter(Boolean),
        dynamicPrefixes: form.dynamicPrefixes.split("\n").map((s: string) => s.trim()).filter(Boolean),
      };
      const info = await postJson<ProjectInfo>("/api/config", payload);
      if (info.restartRequired) alert("Port change saved — restart the tool for it to take effect.");
      props.onSaved(info);
      props.onClose();
    } finally {
      setBusy(false);
    }
  };

  const modelOptions = (current: string) =>
    [...new Set([current, ...models])].filter(Boolean).map((m) => <option key={m} value={m}>{m}</option>);

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="modal-card">
        <div className="modal-header">
          <h2>Project Settings</h2>
          <button className="modal-close" onClick={props.onClose}>✕</button>
        </div>
        <div className="modal-body">
          <div className="cu-hint" style={{ margin: "0 0 12px" }}>
            Saved to {props.project.configPath} and applied immediately (except the port).
          </div>
          <div className="form-grid">
            <label>Locales folder
              <input type="text" value={form.localesDir} placeholder="auto-discover" onChange={(e) => set("localesDir", e.target.value)} />
            </label>
            <label>Source code folder
              <input type="text" value={form.srcDir} placeholder="src (or project root)" onChange={(e) => set("srcDir", e.target.value)} />
            </label>
            <label>Source language
              <input type="text" value={form.sourceLocale} onChange={(e) => set("sourceLocale", e.target.value)} />
            </label>
            <label>Port
              <input type="text" value={form.port} onChange={(e) => set("port", e.target.value)} />
            </label>
            <label>Translator model (fast workhorse)
              {models.length > 0
                ? <select value={form.model} onChange={(e) => set("model", e.target.value)}>{modelOptions(form.model)}</select>
                : <input type="text" value={form.model} onChange={(e) => set("model", e.target.value)} />}
            </label>
            <label>Judge model (smart verifier)
              {models.length > 0
                ? <select value={form.judgeModel} onChange={(e) => set("judgeModel", e.target.value)}>{modelOptions(form.judgeModel)}</select>
                : <input type="text" value={form.judgeModel} onChange={(e) => set("judgeModel", e.target.value)} />}
            </label>
            <label>Ollama URL
              <input type="text" value={form.ollamaUrl} onChange={(e) => set("ollamaUrl", e.target.value)} />
            </label>
            <label className="switch-label form-switch">
              <span className="switch">
                <input type="checkbox" checked={form.autoVerify} onChange={(e) => set("autoVerify", e.target.checked)} />
                <span className="track" />
              </span>
              Auto-verify "same" cells in the background
            </label>
          </div>
          <label className="form-block">App description for the AI (improves translation quality)
            <textarea rows={2} value={form.appContext} onChange={(e) => set("appContext", e.target.value)} />
          </label>
          <label className="form-block">Values allowed to stay identical in every language (comma separated)
            <textarea rows={2} value={form.ignoreSameValues} onChange={(e) => set("ignoreSameValues", e.target.value)} />
          </label>
          <label className="form-block">Key prefixes exempt from the "same" check (one per line)
            <textarea rows={3} value={form.ignoreSameKeyPrefixes} onChange={(e) => set("ignoreSameKeyPrefixes", e.target.value)} />
          </label>
          <label className="form-block">Dynamic key prefixes used via t(variable) (one per line)
            <textarea rows={2} value={form.dynamicPrefixes} onChange={(e) => set("dynamicPrefixes", e.target.value)} />
          </label>
          <button className="primary" disabled={busy} onClick={save}>{busy ? "Saving..." : "Save Settings"}</button>
        </div>
      </div>
    </div>
  );
}

// ---------- App ----------

function App() {
  const [data, setData] = useState<Data | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [currentSection, setCurrentSection] = useState<string | null>(null);
  const [currentKey, setCurrentKey] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [autoFix, setAutoFix] = useState<AutoFixStatus | null>(null);
  const [codeUsageOpen, setCodeUsageOpen] = useState(false);
  const [sectionBusy, setSectionBusy] = useState(false);
  const [sectionProgress, setSectionProgress] = useState<SectionProgress | null>(null);
  const lastFixCount = useRef(-1);

  const loadData = useCallback(async () => {
    const d = await getJson<Data>("/api/data");
    setData(d);
    setDataVersion((v) => v + 1);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // Auto-fix status over SSE; reload the table whenever a pass fixes something
  useEffect(() => {
    const events = new EventSource("/events");
    events.onmessage = (e) => {
      const status: AutoFixStatus = JSON.parse(e.data);
      setAutoFix(status);
      const progress = status.fixedThisPass + status.verifiedThisPass;
      if (progress !== lastFixCount.current) {
        lastFixCount.current = progress;
        loadData();
      }
    };
    return () => events.close();
  }, [loadData]);

  const saveValue = useCallback(async (key: string, locale: string, value: string | string[]) => {
    await postJson("/api/save", { key, locale, value });
    await loadData();
  }, [loadData]);

  const translateWholeKey = useCallback(async (key: string, ow: boolean) => {
    const res = await postJson("/api/translate", { key, overwrite: ow });
    if (res.error) { alert(res.error); return; }
    if (res.skipped) {
      alert('This key is already filled in all target languages. Check "Also overwrite existing" at the top and retry to re-translate.');
      return;
    }
    if (res.unfilled && res.unfilled.length > 0) {
      alert("The model returned no translation for: " + res.unfilled.join(", ") + ". You can try again.");
    }
    await loadData();
  }, [loadData]);

  const runSectionStream = useCallback(async (path: string, body: any, kind: "translate" | "verify") => {
    setSectionBusy(true);
    setSectionProgress({ done: 0, total: 0 });
    let total = 0;
    let done = 0;
    let sawZero = false;
    try {
      await streamNdjson(path, body, (msg) => {
        if (msg.type === "start") {
          total = msg.total;
          sawZero = total === 0;
          setSectionProgress({ done, total });
        } else if (msg.type === "key" || msg.type === "pair") {
          done++;
          setSectionProgress({ done, total });
        } else if (msg.type === "error") {
          alert("Error: " + msg.message);
        } else if (msg.type === "done") {
          if (kind === "translate") {
            alert(`Section translation finished: ${msg.translatedCount} keys processed (${msg.cellsApplied} cells filled), ${msg.skippedCount} keys were already complete.`);
          } else if (sawZero) {
            alert('No "same"-flagged cells to verify in this section.');
          } else {
            alert(`Verification finished: ${msg.confirmed} confirmed as real cognates/terms, ${msg.flagged} still suspicious.`);
          }
        }
      });
    } finally {
      setSectionBusy(false);
      setSectionProgress(null);
    }
    await loadData();
  }, [loadData]);

  const [sweepBusy, setSweepBusy] = useState(false);
  const [sweepProgress, setSweepProgress] = useState<SectionProgress | null>(null);
  const [project, setProject] = useState<ProjectInfo | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    getJson<ProjectInfo>("/api/project").then((p) => {
      setProject(p);
      if (!p.localesDir) setProjectOpen(true); // fresh launch with no project: open the picker
    });
  }, []);

  const onProjectChanged = useCallback(async (info: ProjectInfo) => {
    setProject(info);
    setCurrentSection(null);
    setCurrentKey(null);
    await loadData();
  }, [loadData]);

  const sweepSuspicious = useCallback(async () => {
    setSweepBusy(true);
    let total = 0;
    let done = 0;
    try {
      await streamNdjson("/api/translate-suspicious", {}, (msg) => {
        if (msg.type === "start") {
          total = msg.totalCells;
          setSweepProgress({ done: 0, total });
        } else if (msg.type === "key") {
          done += msg.attempted;
          setSweepProgress({ done, total });
        } else if (msg.type === "error") {
          alert("Error: " + msg.message);
        } else if (msg.type === "done") {
          alert(`Suspicious sweep finished: ${msg.cellsApplied} cells translated, ${msg.cellsUnchanged} left unchanged (the model kept the source text), ${msg.cellsFailed} failed.`);
        }
      });
    } finally {
      setSweepBusy(false);
      setSweepProgress(null);
    }
    await loadData();
  }, [loadData]);

  const addKey = useCallback(async (name: string, value: string) => {
    const fullKey = `${currentSection}.${name}`;
    const res = await postJson("/api/add-key", { key: fullKey, value });
    if (res.error) { alert(res.error); return; }
    await loadData();
    setCurrentKey(fullKey);
    // Translate the new key into every language right away
    await translateWholeKey(fullKey, false);
  }, [currentSection, loadData, translateWholeKey]);

  return (
    <>
      <Topbar
        data={data}
        autoFix={autoFix}
        search={search}
        onSearch={setSearch}
        overwrite={overwrite}
        onOverwrite={setOverwrite}
        onToggleAutoFix={(enabled) => postJson("/api/auto-fix", { enabled })}
        onToggleAutoVerify={(enabled) => postJson("/api/auto-fix", { verifyEnabled: enabled })}
        onOpenCodeUsage={() => setCodeUsageOpen(true)}
        onRefresh={loadData}
        sweepBusy={sweepBusy}
        sweepProgress={sweepProgress}
        onSweepSuspicious={sweepSuspicious}
        project={project}
        onOpenProject={() => setProjectOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <div id="layout">
        {data ? (
          <>
            <Sidebar
              data={data}
              currentSection={currentSection}
              onSelect={(name) => { setCurrentSection(name); setCurrentKey(null); setSearch(""); }}
            />
            <KeyList
              data={data}
              search={search}
              currentSection={currentSection}
              currentKey={currentKey}
              sectionBusy={sectionBusy}
              sectionProgress={sectionProgress}
              onSelectKey={(key) => {
                setCurrentKey(key);
                if (search.trim()) setCurrentSection(key.split(".")[0]);
              }}
              onTranslateSection={() => runSectionStream("/api/translate-section", { section: currentSection, overwrite }, "translate")}
              onVerifySection={() => runSectionStream("/api/verify-section", { section: currentSection }, "verify")}
              onAddKey={addKey}
            />
            <Detail
              data={data}
              dataVersion={dataVersion}
              currentKey={currentKey}
              onSave={saveValue}
              onTranslateKey={() => translateWholeKey(currentKey!, overwrite)}
              onTranslateOne={async (locale) => {
                const res = await postJson("/api/translate", { key: currentKey, overwrite: true, locales: [locale] });
                if (res.error) { alert(res.error); return; }
                if (!res.translations || !res.translations[locale]) {
                  alert("The model returned no translation for this language, try again.");
                  return;
                }
                await loadData();
              }}
              onVerifyOne={async (locale) => {
                const res = await postJson("/api/verify-same", { key: currentKey, locale });
                if (res.error) { alert(res.error); return; }
                alert(res.plausible
                  ? "Confirmed: a real translation/cognate. " + res.reason
                  : "Suspicious: probably untranslated. " + res.reason);
                await loadData();
              }}
              onConfirmSame={async (locale) => {
                await postJson("/api/confirm-same", { key: currentKey, locale });
                await loadData();
              }}
            />
          </>
        ) : (
          <div className="empty-hint">Loading...</div>
        )}
      </div>
      {codeUsageOpen && data && (
        <CodeUsageModal
          sourceLocale={data.sourceLocale}
          onClose={() => setCodeUsageOpen(false)}
          onDataChanged={loadData}
        />
      )}
      {projectOpen && (
        <ProjectModal
          project={project}
          onClose={() => setProjectOpen(false)}
          onSwitched={onProjectChanged}
        />
      )}
      {settingsOpen && project && (
        <SettingsModal
          project={project}
          onClose={() => setSettingsOpen(false)}
          onSaved={onProjectChanged}
        />
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
