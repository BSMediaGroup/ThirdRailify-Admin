import { Route, Routes } from "react-router-dom";
import { AdminShell } from "./components/AdminShell";
import { adminAreas } from "./config/navigation";
import { AreaPage } from "./pages/AreaPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { WatchAdminPage } from "./pages/WatchAdminPage";
import { AccountsPage } from "./pages/AccountsPage";
import {
  BusinessInformationPage,
  CommerceOrdersPage,
  CommerceOverviewPage,
  CommerceProductsPage,
  CustomerEmailsPage,
  FulfillmentIntegrationsPage,
  PaymentsPayoutsPage,
  TaxDocumentsPage,
} from "./pages/CommercePages";
import {
  GoatModerationPage,
  GoatsCommentsPage,
  GoatsEmailsPage,
  GoatsOverviewPage,
  GoatsQueuePage,
} from "./pages/GoatsAdminPages";

const implementedPaths = new Set(["/", "/watch", "/access", "/products", "/orders", "/commerce", "/commerce/payments", "/commerce/business", "/commerce/tax", "/commerce/emails", "/commerce/fulfillment", "/goats"]);

export function App() {
  return (
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="access" element={<AccountsPage />} />
        <Route path="watch" element={<WatchAdminPage />} />
        <Route path="products" element={<CommerceProductsPage />} />
        <Route path="orders" element={<CommerceOrdersPage />} />
        <Route path="commerce" element={<CommerceOverviewPage />} />
        <Route path="commerce/payments" element={<PaymentsPayoutsPage />} />
        <Route path="commerce/business" element={<BusinessInformationPage />} />
        <Route path="commerce/tax" element={<TaxDocumentsPage />} />
        <Route path="commerce/emails" element={<CustomerEmailsPage />} />
        <Route path="commerce/fulfillment" element={<FulfillmentIntegrationsPage />} />
        <Route path="goats" element={<GoatsOverviewPage />} />
        <Route path="goats/pending" element={<GoatsQueuePage status="pending" />} />
        <Route path="goats/approved" element={<GoatsQueuePage status="approved" />} />
        <Route path="goats/rejected" element={<GoatsQueuePage status="rejected" />} />
        <Route path="goats/comments" element={<GoatsCommentsPage />} />
        <Route path="goats/emails" element={<GoatsEmailsPage />} />
        <Route path="goats/:id" element={<GoatModerationPage />} />
        {adminAreas.filter((area) => !implementedPaths.has(area.path)).map((area) => (
          <Route key={area.path} path={area.path.slice(1)} element={<AreaPage area={area} />} />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
