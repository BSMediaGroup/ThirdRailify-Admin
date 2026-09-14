import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { automationRequest } from "../lib/automation-client";

type Detail = {
  id: string;
  eventType: string;
  providerEventAt: string | null;
  createdAt: string;
  outcome: string;
  actionResult: string | null;
  historical: Record<string, unknown>;
  current: Record<string, unknown>;
};

export function AutomationReceiptDialog({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void automationRequest<{ ok: true; receipt: Detail }>(
      `receipts/${encodeURIComponent(id)}`,
    )
      .then((value) => {
        if (active) setDetail(value.receipt);
      })
      .catch((reason) => {
        if (active)
          setError(
            reason instanceof Error ? reason.message : "Receipt unavailable.",
          );
      });
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", key);
    return () => {
      active = false;
      window.removeEventListener("keydown", key);
    };
  }, [id, onClose]);
  return createPortal(
    <div className="admin-modal-backdrop" role="presentation">
      <section
        className="admin-modal automation-receipt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="receipt-title"
      >
        <header>
          <div>
            <p className="eyebrow">IMMUTABLE ACTIVITY</p>
            <h2 id="receipt-title">Receipt detail</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Close receipt">
            ×
          </button>
        </header>
        {error ? (
          <div className="admin-alert" role="alert">
            {error}
          </div>
        ) : !detail ? (
          <p role="status">Loading receipt…</p>
        ) : (
          <div className="automation-receipt-dialog__body">
            <p>
              <b>{detail.eventType}</b> ·{" "}
              {detail.actionResult || detail.outcome} ·{" "}
              {new Date(detail.createdAt).toLocaleString()}
            </p>
            <ReceiptSection
              title="Historical snapshot"
              value={detail.historical}
            />
            <ReceiptSection title="Current references" value={detail.current} />
          </div>
        )}
        <footer>
          <button className="primary-button" type="button" onClick={onClose}>
            Done
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
function ReceiptSection({
  title,
  value,
}: {
  title: string;
  value: Record<string, unknown>;
}) {
  return (
    <section>
      <h3>{title}</h3>
      <dl>
        {Object.entries(value).map(([key, item]) => (
          <div key={key}>
            <dt>{words(key)}</dt>
            <dd>{display(item)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
function display(value: unknown) {
  if (value == null || value === "") return "Not recorded";
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}
function words(value: string) {
  return value
    .replace(/([A-Z])/g, " $1")
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
