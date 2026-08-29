export function resetResizableTable(key: string) {
  window.dispatchEvent(new CustomEvent("thirdrailify:reset-table-columns", { detail: { key } }));
}
