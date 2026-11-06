import { createContext, useContext } from "react";
import type { Me } from "./api";

// Who is signed in to the dashboard, for pages to show only what they may do.
export const MeContext = createContext<Me | null>(null);

// useCan says whether the person signed in holds a permission; the host and admins
// holds them all. The server checks every call the same way.
export function useCan() {
  const me = useContext(MeContext);
  return (key: string) => !!me && (me.admin || me.permissions.includes(key));
}
