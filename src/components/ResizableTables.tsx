import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const STORAGE_PREFIX = "thirdrailify.admin.table-widths.v1";
const MIN_WIDTH = 72;
const MAX_WIDTH = 560;
const KEYBOARD_STEP = 12;

export function ResizableTables() {
  const location = useLocation();

  useEffect(() => {
    const enhance = () => document.querySelectorAll<HTMLTableElement>("#admin-main table").forEach((table, index) => enhanceTable(table, location.pathname, index));
    enhance();
    const observer = new MutationObserver(enhance);
    observer.observe(document.getElementById("admin-main") || document.body, { childList: true, subtree: true });
    const reset = (event: Event) => {
      const key = (event as CustomEvent<{ key?: string }>).detail?.key;
      document.querySelectorAll<HTMLTableElement>("#admin-main table[data-resizable-key]").forEach((table) => {
        if (!key || table.dataset.resizableKey === key) resetTable(table);
      });
    };
    window.addEventListener("thirdrailify:reset-table-columns", reset);
    return () => { observer.disconnect(); window.removeEventListener("thirdrailify:reset-table-columns", reset); };
  }, [location.pathname]);

  return null;
}

function enhanceTable(table: HTMLTableElement, pathname: string, index: number) {
  const headers = [...table.querySelectorAll<HTMLTableCellElement>(":scope > thead > tr:first-child > th")];
  if (!headers.length || table.dataset.resizableEnhanced === "true") return;
  const key = table.dataset.resizableKey || `${pathname.replace(/[^a-z0-9]+/gi, "-") || "root"}:${table.className || "table"}:${index}`;
  table.dataset.resizableKey = key;
  table.dataset.resizableEnhanced = "true";
  table.classList.add("resizable-admin-table");
  addResetControl(table, key);
  const stored = readWidths(key, headers.length);
  const widths = headers.map((header, column) => clamp(stored?.[column] ?? (Number(header.dataset.columnWidth) || Math.ceil(header.getBoundingClientRect().width)), minimum(header), maximum(header)));
  const colgroup = document.createElement("colgroup");
  widths.forEach((width) => { const col = document.createElement("col"); col.style.width = `${width}px`; colgroup.append(col); });
  table.prepend(colgroup);
  applyTableWidth(table, widths);

  headers.forEach((header, column) => {
    header.classList.add("resizable-admin-table__header");
    const handle = document.createElement("span");
    handle.className = "column-resize-handle";
    handle.tabIndex = 0;
    handle.setAttribute("role", "separator");
    handle.setAttribute("aria-orientation", "vertical");
    handle.setAttribute("aria-label", `Resize ${header.textContent?.trim() || `column ${column + 1}`}`);
    handle.addEventListener("click", stop);
    handle.addEventListener("pointerdown", (event) => beginPointerResize(event, table, colgroup, headers, widths, column, key));
    handle.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault(); event.stopPropagation();
      widths[column] = clamp(widths[column] + (event.key === "ArrowRight" ? KEYBOARD_STEP : -KEYBOARD_STEP), minimum(headers[column]), maximum(headers[column]));
      applyWidths(table, colgroup, widths); persistWidths(key, widths);
      handle.setAttribute("aria-valuenow", String(widths[column]));
    });
    handle.setAttribute("aria-valuemin", String(minimum(header)));
    handle.setAttribute("aria-valuemax", String(maximum(header)));
    handle.setAttribute("aria-valuenow", String(widths[column]));
    header.append(handle);
  });
}

function addResetControl(table: HTMLTableElement, key: string) {
  if (key === "accounts" || key === "customers") return;
  const container = table.parentElement;
  if (!container || container.querySelector(":scope > .table-column-reset")) return;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button table-column-reset";
  button.textContent = "Reset columns";
  button.addEventListener("click", () => resetTable(table));
  container.prepend(button);
}

function beginPointerResize(event: PointerEvent, table: HTMLTableElement, colgroup: HTMLTableColElement, headers: HTMLTableCellElement[], widths: number[], column: number, key: string) {
  if (event.button !== 0) return;
  event.preventDefault(); event.stopPropagation();
  const startX = event.clientX; const startWidth = widths[column];
  document.documentElement.classList.add("is-resizing-admin-table");
  const move = (next: PointerEvent) => {
    widths[column] = clamp(startWidth + next.clientX - startX, minimum(headers[column]), maximum(headers[column]));
    applyWidths(table, colgroup, widths);
  };
  const end = () => {
    document.documentElement.classList.remove("is-resizing-admin-table");
    window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); window.removeEventListener("pointercancel", end);
    persistWidths(key, widths);
  };
  window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true }); window.addEventListener("pointercancel", end, { once: true });
}

function resetTable(table: HTMLTableElement) {
  const headers = [...table.querySelectorAll<HTMLTableCellElement>(":scope > thead > tr:first-child > th")];
  const colgroup = table.querySelector<HTMLTableColElement>(":scope > colgroup");
  if (!colgroup) return;
  const widths = headers.map((header) => clamp(Number(header.dataset.columnWidth) || Math.ceil(header.scrollWidth + 28), minimum(header), maximum(header)));
  try { window.localStorage.removeItem(`${STORAGE_PREFIX}:${table.dataset.resizableKey}`); } catch { /* UI preference persistence is optional. */ }
  applyWidths(table, colgroup, widths);
  headers.forEach((header, index) => header.querySelector(".column-resize-handle")?.setAttribute("aria-valuenow", String(widths[index])));
}

function applyWidths(table: HTMLTableElement, colgroup: HTMLTableColElement, widths: number[]) {
  [...colgroup.children].forEach((col, index) => { (col as HTMLElement).style.width = `${widths[index]}px`; });
  applyTableWidth(table, widths);
}
function applyTableWidth(table: HTMLTableElement, widths: number[]) { table.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`; table.style.minWidth = "100%"; }
function minimum(header: HTMLTableCellElement) { return clamp(Number(header.dataset.columnMin) || MIN_WIDTH, 48, MAX_WIDTH); }
function maximum(header: HTMLTableCellElement) { return clamp(Number(header.dataset.columnMax) || MAX_WIDTH, minimum(header), 900); }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, Number.isFinite(value) ? Math.round(value) : min)); }
function stop(event: Event) { event.preventDefault(); event.stopPropagation(); }
function readWidths(key: string, count: number) { try { const value = JSON.parse(window.localStorage.getItem(`${STORAGE_PREFIX}:${key}`) || "null"); return Array.isArray(value) && value.length === count && value.every(Number.isFinite) ? value as number[] : null; } catch { return null; } }
function persistWidths(key: string, widths: number[]) { try { window.localStorage.setItem(`${STORAGE_PREFIX}:${key}`, JSON.stringify(widths)); } catch { /* UI preference persistence is optional. */ } }
