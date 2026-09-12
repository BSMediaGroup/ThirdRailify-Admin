import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { AdminArea } from "../config/navigation";
import { AdminIcon } from "./AdminIcon";

const RECENTS_KEY = "thirdrailify.admin.quick-search.recents";
const RESULT_LIMIT = 9;

type Props = {
  areas: AdminArea[];
  currentPath: string;
  collapsed: boolean;
  onSelect: (path: string) => void;
};

export function AdminQuickSearch({ areas, currentPath, collapsed, onSelect }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const [recentPaths, setRecentPaths] = useState<string[]>(readRecents);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const areaByPath = useMemo(() => new Map(areas.map((area) => [area.path, area])), [areas]);
  const results = useMemo(() => searchAreas(areas, query, recentPaths, currentPath), [areas, currentPath, query, recentPaths]);
  const shortcut = useMemo(() => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl", []);

  const show = useCallback(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : triggerRef.current;
    setQuery("");
    setActiveIndex(0);
    setOpen(true);
  }, []);

  const dismiss = useCallback((restoreFocus = true) => {
    setOpen(false);
    if (restoreFocus) window.requestAnimationFrame(() => returnFocusRef.current?.focus({ preventScroll: true }));
  }, []);

  const choose = useCallback((area: AdminArea) => {
    const next = [area.path, ...recentPaths.filter((path) => path !== area.path)].slice(0, 6);
    setRecentPaths(next);
    writeRecents(next);
    setOpen(false);
    onSelect(area.path);
  }, [onSelect, recentPaths]);

  useEffect(() => {
    const validCurrent = areaByPath.get(currentPath);
    if (!validCurrent) return;
    setRecentPaths((current) => {
      const next = [validCurrent.path, ...current.filter((path) => path !== validCurrent.path)].slice(0, 6);
      writeRecents(next);
      return next;
    });
  }, [areaByPath, currentPath]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (open) inputRef.current?.focus(); else show();
      }
    };
    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  }, [open, show]);

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    document.documentElement.classList.add("admin-quick-search-open");
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    return () => {
      window.cancelAnimationFrame(frame);
      document.documentElement.classList.remove("admin-quick-search-open");
      if (dialog.open) dialog.close();
    };
  }, [open]);

  useEffect(() => setActiveIndex(0), [query]);
  useEffect(() => { if (activeIndex >= results.length) setActiveIndex(Math.max(0, results.length - 1)); }, [activeIndex, results.length]);

  const onInputKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => results.length ? (index + 1) % results.length : 0); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => results.length ? (index - 1 + results.length) % results.length : 0); }
    else if (event.key === "Home") { event.preventDefault(); setActiveIndex(0); }
    else if (event.key === "End") { event.preventDefault(); setActiveIndex(Math.max(0, results.length - 1)); }
    else if (event.key === "Enter" && results[activeIndex]) { event.preventDefault(); choose(results[activeIndex]); }
  };

  return <>
    <button ref={triggerRef} className="sidebar-quick-search" type="button" aria-label="Open quick search" aria-haspopup="dialog" aria-expanded={open} aria-controls="admin-quick-search-dialog" aria-keyshortcuts="Control+K Meta+K" title={collapsed ? "Quick search (Ctrl or Command K)" : undefined} onClick={show}>
      <SearchGlyph />
      <span>Quick search…</span>
      <kbd><span>{shortcut}</span><span>K</span></kbd>
    </button>
    {open ? createPortal(<dialog id="admin-quick-search-dialog" ref={dialogRef} className="admin-quick-search" aria-labelledby="admin-quick-search-title" onCancel={(event) => { event.preventDefault(); dismiss(); }} onMouseDown={(event) => { if (event.target === event.currentTarget) dismiss(); }}>
      <section className="admin-quick-search__surface" onMouseDown={(event) => event.stopPropagation()}>
        <h2 id="admin-quick-search-title" className="sr-only">Quick navigation</h2>
        <div className="admin-quick-search__input-row">
          <SearchGlyph />
          <input ref={inputRef} type="search" role="combobox" aria-label="Search Admin pages" aria-expanded="true" aria-controls="admin-quick-search-results" aria-autocomplete="list" aria-activedescendant={results[activeIndex] ? `admin-search-result-${resultId(results[activeIndex].path)}` : undefined} autoComplete="off" spellCheck="false" placeholder="Search pages, tools, and features…" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onInputKeyDown} />
          {query ? <button type="button" className="admin-quick-search__clear" aria-label="Clear search" onClick={() => { setQuery(""); inputRef.current?.focus(); }}>Clear</button> : <kbd>Esc</kbd>}
        </div>
        <div className="admin-quick-search__meta"><span>{query.trim() ? "Best matches" : "Recent & suggested"}</span><span>{results.length} {results.length === 1 ? "destination" : "destinations"}</span></div>
        <div id="admin-quick-search-results" className="admin-quick-search__results" role="listbox" aria-label="Admin destinations">
          {results.map((area, index) => {
            const parent = area.parentPath ? areaByPath.get(area.parentPath) : null;
            return <button id={`admin-search-result-${resultId(area.path)}`} key={area.path} type="button" role="option" aria-selected={index === activeIndex} className={index === activeIndex ? "is-active" : ""} onMouseMove={() => setActiveIndex(index)} onClick={() => choose(area)}>
              <span className="admin-quick-search__result-icon"><AdminIcon name={area.icon} size={18} /></span>
              <span className="admin-quick-search__result-copy"><strong>{area.label}</strong><small>{parent ? `${parent.shortLabel} · ` : ""}{area.summary}</small></span>
              <span className="admin-quick-search__result-path">{area.path === "/" ? "/overview" : area.path}</span>
              <AdminIcon name="arrow" size={15} />
            </button>;
          })}
          {!results.length ? <div className="admin-quick-search__empty"><SearchGlyph /><strong>No matching destination</strong><span>Try a page name, feature, or route.</span></div> : null}
        </div>
        <footer className="admin-quick-search__footer"><span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span><span><kbd>↵</kbd> Open</span><span><kbd>Esc</kbd> Close</span></footer>
      </section>
    </dialog>, document.body) : null}
  </>;
}

function searchAreas(areas: AdminArea[], query: string, recentPaths: string[], currentPath: string) {
  const normalized = normalize(query);
  if (!normalized) {
    const preferred = [currentPath, ...recentPaths, "/", "/inbox", "/commerce", "/products", "/wheels", "/automations"];
    const ranked = preferred.map((path) => areas.find((area) => area.path === path)).filter((area): area is AdminArea => Boolean(area));
    return [...new Map([...ranked, ...areas].map((area) => [area.path, area])).values()].slice(0, RESULT_LIMIT);
  }
  const tokens = normalized.split(" ").filter(Boolean);
  return areas.map((area) => ({ area, score: areaScore(area, normalized, tokens) })).filter(({ score }) => score > 0).sort((left, right) => right.score - left.score || left.area.label.localeCompare(right.area.label)).slice(0, RESULT_LIMIT).map(({ area }) => area);
}

function areaScore(area: AdminArea, query: string, tokens: string[]) {
  const label = normalize(area.label);
  const short = normalize(area.shortLabel);
  const path = normalize(area.path.replaceAll("/", " "));
  const summary = normalize(area.summary);
  const scope = normalize(area.futureScope.join(" "));
  const haystack = `${label} ${short} ${path} ${summary} ${scope}`;
  if (!tokens.every((token) => haystack.includes(token))) return 0;
  let score = 20;
  if (label === query || short === query) score += 120;
  if (label.startsWith(query)) score += 80;
  if (short.startsWith(query)) score += 65;
  if (path.startsWith(query)) score += 50;
  if (label.includes(query)) score += 35;
  if (summary.includes(query)) score += 15;
  return score - Math.min(area.path.length, 30) / 10;
}

function normalize(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function resultId(path: string) { return path === "/" ? "overview" : path.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, ""); }
function readRecents() { try { const value = JSON.parse(window.localStorage.getItem(RECENTS_KEY) || "[]"); return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 6) : []; } catch { return []; } }
function writeRecents(paths: string[]) { try { window.localStorage.setItem(RECENTS_KEY, JSON.stringify(paths)); } catch { /* Navigation remains fully functional without persistence. */ } }
function SearchGlyph() { return <svg className="admin-search-glyph" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.2 4.2" /></svg>; }
