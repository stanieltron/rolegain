import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { AdminApp } from "./AdminApp.js";
import { AuthGate } from "./auth.js";
import "./styles.css";
import "./cv-workspace.css";

const adminRoute = window.location.pathname.replace(/\/+$/, "") === "/admin";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {adminRoute ? (
      <AdminApp />
    ) : (
      <AuthGate>
        <App />
      </AuthGate>
    )}
  </React.StrictMode>,
);
