import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./components/Tooltip.css";
import App from "./App";
import { platform } from "./services/platform";

document.documentElement.dataset.platform = platform;

// Disable the webview's default context menu; Branchline provides its own menus.
if (!import.meta.env.DEV) {
  window.addEventListener("contextmenu", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target?.closest("input, textarea, .selectable")) e.preventDefault();
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
