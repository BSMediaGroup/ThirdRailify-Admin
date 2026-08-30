import { Navigate, Route, Routes } from "react-router-dom";
import { AdminShell } from "./components/AdminShell";
import { adminAreas } from "./config/navigation";
import { AreaPage } from "./pages/AreaPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { InboxPage } from "./pages/InboxPage";
import { WatchAdminPage } from "./pages/WatchAdminPage";
import { AccountsPage } from "./pages/AccountsPage";
import { SiteContentPage } from "./pages/SiteContentPage";
import {
  BusinessInformationPage,
  CommerceOrdersPage,
  CommerceOverviewPage,
  CommerceCollectionsPage,
  CommerceProductsPage,
  PaymentsPayoutsPage,
  TaxDocumentsPage,
} from "./pages/CommercePages";
import { CustomerEmailsPage } from "./pages/CustomerEmailsPage";
import { CustomersPage } from "./pages/CustomersPage";
import { FulfillmentShippingPage } from "./pages/FulfillmentShippingPage";
import {
  GoatModerationPage,
  GoatsCommentsPage,
  GoatsEmailsPage,
  GoatsSettingsPage,
  GoatsOverviewPage,
  GoatsQueuePage,
} from "./pages/GoatsAdminPages";
import { WheelAdminDetailPage, WheelsAccessPage, WheelsLibraryPage, WheelsResultsPage, WheelsStagesPage } from "./pages/WheelsAdminPages";

const implementedPaths = new Set(["/", "/inbox", "/watch", "/content", "/access", "/shop", "/products", "/collections", "/orders", "/customers", "/commerce", "/commerce/payments", "/commerce/business", "/commerce/tax", "/commerce/emails", "/commerce/fulfillment", "/goats", "/wheels", "/wheels/stages", "/wheels/access", "/wheels/results"]);

export function App() {
  return (
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="inbox" element={<InboxPage />} />
        <Route path="access" element={<AccountsPage />} />
        <Route path="watch" element={<WatchAdminPage />} />
        <Route path="content" element={<SiteContentPage />} />
        <Route path="wheels" element={<WheelsLibraryPage />} />
        <Route path="wheels/stages" element={<WheelsStagesPage />} />
        <Route path="wheels/access" element={<WheelsAccessPage />} />
        <Route path="wheels/results" element={<WheelsResultsPage />} />
        <Route path="wheels/:id" element={<WheelAdminDetailPage />} />
        <Route path="shop" element={<Navigate to="/products" replace />} />
        <Route path="products" element={<CommerceProductsPage />} />
        <Route path="collections" element={<CommerceCollectionsPage />} />
        <Route path="orders" element={<CommerceOrdersPage />} />
        <Route path="customers" element={<CustomersPage />} />
        <Route path="commerce" element={<CommerceOverviewPage />} />
        <Route path="commerce/payments" element={<PaymentsPayoutsPage />} />
        <Route path="commerce/business" element={<BusinessInformationPage />} />
        <Route path="commerce/tax" element={<TaxDocumentsPage />} />
        <Route path="commerce/emails" element={<CustomerEmailsPage />} />
        <Route path="commerce/fulfillment" element={<FulfillmentShippingPage />} />
        <Route path="goats" element={<GoatsOverviewPage />} />
        <Route path="goats/pending" element={<GoatsQueuePage status="pending" />} />
        <Route path="goats/approved" element={<GoatsQueuePage status="approved" />} />
        <Route path="goats/rejected" element={<GoatsQueuePage status="rejected" />} />
        <Route path="goats/comments" element={<GoatsCommentsPage />} />
        <Route path="goats/reactions" element={<Navigate to="/goats/approved" replace />} />
        <Route path="goats/settings" element={<GoatsSettingsPage />} />
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
