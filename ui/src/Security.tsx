import { Icon, type IconName } from "./Icon";
import { useCan } from "./me";
import { OAuth } from "./OAuth";
import { TwoFactorSetup } from "./TwoFactor";

// AdvancedSecurity holds the ways to sign in beyond a password: emailed codes,
// on for every sign-in at once, and third-party providers tunnels can offer.
export function AdvancedSecurity({ tab }: { tab: string }) {
  const can = useCan();
  const tabs: [string, string, IconName][] = [
    ...(can("twofactor.manage") ? [["twofactor", "Two-Factor Auth", "lock"]] as [string, string, IconName][] : []),
    ...(can("oauth.manage") ? [["oauth", "Third-Party OAuth", "key"]] as [string, string, IconName][] : []),
  ];
  const current = tabs.some(([k]) => k === tab) ? tab : tabs[0]?.[0] ?? "";
  return (
    <>
      <div className="page-head">
        <div className="page-head-main">
          <h1>Advanced Security</h1>
        </div>
      </div>
      <nav className="sub-nav" aria-label="Advanced Security">
        {tabs.map(([key, label, icon]) => (
          <a key={key} className={"sub-nav-item" + (current === key ? " on" : "")} href={`#/security/${key}`} aria-current={current === key ? "page" : undefined}>
            <Icon name={icon} size={18} />
            <span>{label}</span>
          </a>
        ))}
      </nav>
      <div className="page-body stack" key={current}>
        {current === "twofactor" && <TwoFactorSetup />}
        {current === "oauth" && <OAuth />}
      </div>
    </>
  );
}
