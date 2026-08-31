import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./auth/AuthProvider";
import { AdminAccessBoundary } from "./auth/AdminAccessBoundary";
import { AdminToastProvider } from "./components/AdminToasts";
import "./styles/global.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <AdminToastProvider><AdminAccessBoundary><App /></AdminAccessBoundary></AdminToastProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
