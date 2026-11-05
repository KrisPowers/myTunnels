import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CodeApp } from "./Repo";
import "./styles.css";

// Code's address serves this page marked as code: the repositories alone.
const code = document.querySelector('meta[name="code"]') !== null;

createRoot(document.getElementById("root")!).render(code ? <CodeApp /> : <App />);
