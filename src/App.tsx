import { Navigate, Route, Routes } from "react-router-dom";
import type { ReactNode } from "react";
import { AdminShell } from "./components/AdminShell";
import { adminAreas } from "./config/navigation";
import { AreaPage } from "./pages/AreaPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { InboxPage } from "./pages/InboxPage";
import { AnalyticsPage } from "./pages/AnalyticsPage";
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
import { CommerceIntelligencePage } from "./pages/CommerceIntelligencePage";
import {
  GoatModerationPage,
  GoatsCommentsPage,
  GoatsEmailsPage,
  GoatsSettingsPage,
  GoatsOverviewPage,
  GoatsQueuePage,
} from "./pages/GoatsAdminPages";
import { WheelAdminDetailPage, WheelsAccessPage, WheelsLibraryPage, WheelsResultsPage, WheelsStagesPage } from "./pages/WheelsAdminPages";
import { WheelsMechanicsPage, WheelsOverviewPage } from "./pages/WheelsMechanicsPages";
import { IntegrationsOperationsPage, MediaOperationsPage, MembershipOperationsPage, SettingsOperationsPage } from "./pages/OperationsPages";
import { AutomationsPage, PollCreatorAccessPage, PollManagementPage } from "./pages/PollsAdminPages";
import { GamingAdminPage } from "./pages/GamingAdminPage";
import { AdminCapabilityBoundary } from "./auth/AdminCapabilityBoundary";
import { adminRoutePolicy } from "./auth/capabilities";

const implementedPaths = new Set(["/", "/analytics", "/inbox", "/watch", "/gaming", "/content", "/access", "/shop", "/products", "/collections", "/orders", "/customers", "/commerce", "/commerce/payments", "/commerce/analytics", "/commerce/business", "/commerce/tax", "/commerce/emails", "/commerce/fulfillment", "/media", "/membership", "/integrations", "/settings", "/goats", "/wheels", "/wheels/library", "/wheels/stages", "/wheels/mechanics", "/wheels/access", "/wheels/results", "/polls", "/polls/access", "/automations"]);

export function App() {
  return (
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={guard("/", <OverviewPage />)} />
        <Route path="inbox" element={guard("/inbox", <InboxPage />)} />
        <Route path="analytics" element={guard("/analytics", <AnalyticsPage />)} />
        <Route path="access" element={guard("/access", <AccountsPage />)} />
        <Route path="watch" element={guard("/watch", <WatchAdminPage />)} />
        <Route path="gaming" element={guard("/gaming", <GamingAdminPage />)} />
        <Route path="content" element={guard("/content", <SiteContentPage />)} />
        <Route path="media" element={guard("/media", <MediaOperationsPage />)} />
        <Route path="membership" element={guard("/membership", <MembershipOperationsPage />)} />
        <Route path="integrations" element={guard("/integrations", <IntegrationsOperationsPage />)} />
        <Route path="settings" element={guard("/settings", <SettingsOperationsPage />)} />
        <Route path="wheels" element={guard("/wheels", <WheelsOverviewPage />)} />
        <Route path="wheels/library" element={guard("/wheels/library", <WheelsLibraryPage />)} />
        <Route path="wheels/stages" element={guard("/wheels/stages", <WheelsStagesPage />)} />
        <Route path="wheels/mechanics" element={guard("/wheels/mechanics", <WheelsMechanicsPage />)} />
        <Route path="wheels/access" element={guard("/wheels/access", <WheelsAccessPage />)} />
        <Route path="wheels/results" element={guard("/wheels/results", <WheelsResultsPage />)} />
        <Route path="wheels/:id" element={guard("/wheels", <WheelAdminDetailPage />)} />
        <Route path="polls" element={guard("/polls", <PollManagementPage />)} />
        <Route path="polls/access" element={guard("/polls/access", <PollCreatorAccessPage />)} />
        <Route path="automations" element={guard("/automations", <AutomationsPage />)} />
        <Route path="shop" element={guard("/shop", <Navigate to="/products" replace />)} />
        <Route path="products" element={guard("/products", <CommerceProductsPage />)} />
        <Route path="collections" element={guard("/collections", <CommerceCollectionsPage />)} />
        <Route path="orders" element={guard("/orders", <CommerceOrdersPage />)} />
        <Route path="customers" element={guard("/customers", <CustomersPage />)} />
        <Route path="commerce" element={guard("/commerce", <CommerceOverviewPage />)} />
        <Route path="commerce/payments" element={guard("/commerce/payments", <PaymentsPayoutsPage />)} />
        <Route path="commerce/analytics" element={guard("/commerce/analytics", <CommerceIntelligencePage />)} />
        <Route path="commerce/business" element={guard("/commerce/business", <BusinessInformationPage />)} />
        <Route path="commerce/tax" element={guard("/commerce/tax", <TaxDocumentsPage />)} />
        <Route path="commerce/emails" element={guard("/commerce/emails", <CustomerEmailsPage />)} />
        <Route path="commerce/fulfillment" element={guard("/commerce/fulfillment", <FulfillmentShippingPage />)} />
        <Route path="goats" element={guard("/goats", <GoatsOverviewPage />)} />
        <Route path="goats/pending" element={guard("/goats/pending", <GoatsQueuePage status="pending" />)} />
        <Route path="goats/approved" element={guard("/goats/approved", <GoatsQueuePage status="approved" />)} />
        <Route path="goats/rejected" element={guard("/goats/rejected", <GoatsQueuePage status="rejected" />)} />
        <Route path="goats/comments" element={guard("/goats/comments", <GoatsCommentsPage />)} />
        <Route path="goats/reactions" element={guard("/goats", <Navigate to="/goats/approved" replace />)} />
        <Route path="goats/settings" element={guard("/goats/settings", <GoatsSettingsPage />)} />
        <Route path="goats/emails" element={guard("/goats/emails", <GoatsEmailsPage />)} />
        <Route path="goats/:id" element={guard("/goats", <GoatModerationPage />)} />
        {adminAreas.filter((area) => !implementedPaths.has(area.path)).map((area) => (
          <Route key={area.path} path={area.path.slice(1)} element={guard(area.path, <AreaPage area={area} />)} />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}

function guard(path: string, element: ReactNode) {
  const policy = adminRoutePolicy(path);
  return <AdminCapabilityBoundary view={policy.view} manage={policy.manage} preserveInspectionControls={path === "/settings"}>{element}</AdminCapabilityBoundary>;
}
