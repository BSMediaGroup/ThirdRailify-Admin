import { Route, Routes } from "react-router-dom";
import { AdminShell } from "./components/AdminShell";
import { adminAreas } from "./config/navigation";
import { AreaPage } from "./pages/AreaPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { OverviewPage } from "./pages/OverviewPage";
import { AccountsPage } from "./pages/AccountsPage";

export function App() {
  return (
    <Routes>
      <Route element={<AdminShell />}>
        <Route index element={<OverviewPage />} />
        <Route path="access" element={<AccountsPage />} />
        {adminAreas.filter((area) => area.path !== "/" && area.path !== "/access").map((area) => (
          <Route key={area.path} path={area.path.slice(1)} element={<AreaPage area={area} />} />
        ))}
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
