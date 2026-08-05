import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { InboxPage } from "./pages/InboxPage";
import { JoinPage } from "./pages/JoinPage";
import "./styles/tokens.css";
import "./styles/components.css";
import "./styles/layouts.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<InboxPage />} />
        <Route path="/join/:id" element={<JoinPage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
