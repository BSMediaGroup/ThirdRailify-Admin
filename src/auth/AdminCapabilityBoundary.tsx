import type { ReactNode } from "react";
import { AdminIcon } from "../components/AdminIcon";
import { useAuth } from "./AuthProvider";
import type { AdminCapability } from "./capabilities";

export function AdminCapabilityBoundary({ view, manage, preserveInspectionControls = false, children }: { view: AdminCapability; manage?: AdminCapability; preserveInspectionControls?: boolean; children: ReactNode }) {
  const { hasCapability } = useAuth();
  if (!hasCapability(view)) return <section className="capability-restricted" aria-labelledby="capability-restricted-title">
    <span><AdminIcon name="shield" size={30} /></span>
    <p className="eyebrow">Full Admin policy</p>
    <h1 id="capability-restricted-title">Access restricted</h1>
    <p>The Full Admin role has had this capability restricted by Master Admin.</p>
  </section>;
  const readOnly = Boolean(manage && !hasCapability(manage));
  return <>
    {readOnly && <div className="capability-readonly-callout" role="status"><AdminIcon name="shield" size={19} /><div><strong>Read-only access</strong><p>Master Admin has restricted management for this workspace. Inspection remains available.</p></div></div>}
    {readOnly && !preserveInspectionControls ? <fieldset className="capability-readonly-surface" disabled>{children}</fieldset> : children}
  </>;
}
