import type { ReactNode } from "react";
import type { Device, Route, User } from "./api";
import { Devices } from "./Devices";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { OAuth } from "./OAuth";
import { TwoFactorSetup } from "./TwoFactor";
import { Users } from "./Users";

// SecurityPage is what the host and admins look after, in one page with a tab
// each: the accounts, the devices, emailed sign-in codes and third-party
// sign-in.
export function SecurityPage({ tab, users, devices, routes, onChanged }: {
  tab: string;
  users: User[] | null;
  devices: Device[] | null;
  routes: Route[];
  onChanged: () => Promise<void>;
}) {
  const can = useCan();
  const pending = devices?.filter((d) => d.status === "pending").length ?? 0;
  const tabs = ([
    [can("users.view"), "users", "Users", "group"],
    [can("devices.view"), "devices", "Devices", "devices"],
    [can("twofactor.manage"), "twofactor", "Two-Factor Auth", "lock"],
    [can("oauth.manage"), "oauth", "Third-Party OAuth", "key"],
  ] as [boolean, string, string, IconName][]).filter(([shown]) => shown);
  const current = tabs.some(([, k]) => k === tab) ? tab : tabs[0]?.[1] ?? "";

  const nav: ReactNode = (
    <nav className="sub-nav" aria-label="Security & Roles">
      {tabs.map(([, key, label, icon]) => (
        <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/security/${key}`} aria-current={current === key ? "page" : undefined}>
          <Icon name={icon} size={18} />
          <span>{label}</span>
          {key === "devices" && pending > 0 && <span className="nav-count">{pending}</span>}
        </a>
      ))}
    </nav>
  );

  if (current === "users") return <Users nav={nav} users={users} routes={routes} />;
  if (current === "devices") return <Devices nav={nav} devices={devices} routes={routes} onChanged={onChanged} />;
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Security &amp; Roles</h1>
        </div>
      </div>
      {nav}
      <div className="page-body stack" key={current}>
        {current === "twofactor" && <TwoFactorSetup />}
        {current === "oauth" && <OAuth />}
      </div>
    </>
  );
}
