import type { Device, User } from "./api";
import { Devices } from "./Devices";
import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { OAuth } from "./OAuth";
import { TwoFactorSetup } from "./TwoFactor";
import { Users } from "./Users";

// SecurityPage is what the host and admins look after, in one page with a tab
// each: the accounts, the devices, emailed sign-in codes and third-party
// sign-in. Every tab shares the one heading, so it never changes height.
export function SecurityPage({ tab, users, devices }: {
  tab: string;
  users: User[] | null;
  devices: Device[] | null;
}) {
  const can = useCan();
  const tabs = ([
    [can("users.view"), "users", "Users", "group"],
    [can("devices.view"), "devices", "Devices", "devices"],
    [can("twofactor.manage"), "twofactor", "Two-Factor Auth", "lock"],
    [can("oauth.manage"), "oauth", "Third-Party OAuth", "key"],
  ] as [boolean, string, string, IconName][]).filter(([shown]) => shown);
  const current = tabs.some(([, k]) => k === tab) ? tab : tabs[0]?.[1] ?? "";

  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Security</h1>
        </div>
        {current === "users" && can("users.manage") && (
          <div className="page-actions">
            <a className="btn primary" href="#/users/new"><Icon name="add" size={18} />New user</a>
          </div>
        )}
      </div>
      <nav className="sub-nav" aria-label="Security">
        {tabs.map(([, key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/security/${key}`} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      {current === "users" && <Users users={users} />}
      {current === "devices" && <Devices devices={devices} users={users} />}
      {(current === "twofactor" || current === "oauth") && (
        <div className="page-body stack" key={current}>
          {current === "twofactor" && <TwoFactorSetup />}
          {current === "oauth" && <OAuth />}
        </div>
      )}
    </>
  );
}
