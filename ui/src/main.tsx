import { createRoot } from "react-dom/client";
import { App } from "./App";
import { StorageApp } from "./Explorer";
import "./styles.css";

// The storage address serves this page marked as storage: the explorer alone.
const storage = document.querySelector('meta[name="storage"]') !== null;

createRoot(document.getElementById("root")!).render(storage ? <StorageApp /> : <App />);
