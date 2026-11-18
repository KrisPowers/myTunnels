import { useEffect, useState } from "react";
import { Alerts, type Alert } from "./Alerts";
import { DashboardPage } from "./Dashboard";
import { Icon } from "./Icon";

// ConsolePage is the screen on the rack: the Dashboard alone at its normal
// size, filling the monitor, under a slim bar with the time, the alerts and
// the way back. The console button in the header opens it; the desktop app
// opens on it.
export function ConsolePage({ alerts }: { alerts: Alert[] }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);
  return (
    <div className="console">
      <header className="console-bar">
        <span className="brand-mark"><Icon name="public" size={16} /></span>
        <b>{now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</b>
        <span>{now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}</span>
        <span className="console-gap" />
        <Alerts alerts={alerts} />
        <a className="icon-btn" href="#/dashboard" aria-label="Close the console" title="Close the console"><Icon name="close" /></a>
      </header>
      <main className="page console-page">
        <DashboardPage />
      </main>
    </div>
  );
}
