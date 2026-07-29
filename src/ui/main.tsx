import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App.js";
import { AuthGate } from "./auth.js";
import "./styles.css";
import "./cv-workspace.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </React.StrictMode>,
);
