import React from "react";
import ReactDOM from "react-dom/client";
import { EvalApp } from "./EvalApp.js";
import "../ui/styles.css";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <EvalApp />
  </React.StrictMode>,
);
