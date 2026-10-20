import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { followHostTheme } from "./theme";
import "./styles.css";

followHostTheme();
createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
