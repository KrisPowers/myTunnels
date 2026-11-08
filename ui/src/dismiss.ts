import { useEffect, useLayoutEffect, type RefObject } from "react";

// usePlace keeps an open popup, such as a menu or a list, inside the window:
// under its anchor, or over it when there is more room above, no taller than
// the room on that side, and moved in from either edge. It measures the popup
// as it opens, again whenever what is in it changes, so a list that fills in
// or grows as it scrolls stays on screen, and again when `left`, where its
// owner puts it, changes. It owns the popup's `top` and `max-height`, moves its
// `left` only to keep it in, and marks it `up` when above.
export function usePlace(open: boolean, anchor: RefObject<HTMLElement | null>, panel: RefObject<HTMLElement | null>, left: number) {
  useLayoutEffect(() => {
    const el = panel.current;
    const at = anchor.current;
    if (!open || !el || !at) return;
    // The tallest its stylesheet lets it be, read without what this set before.
    el.style.maxHeight = "";
    const cap = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
    const place = () => {
      const r = at.getBoundingClientRect();
      const gap = 4;
      const edge = 8;
      const below = innerHeight - r.bottom - gap - edge;
      const above = r.top - gap - edge;
      const border = el.offsetHeight - el.clientHeight;
      const natural = Math.min(el.scrollHeight + border, cap);
      const up = natural > below && above > below;
      const height = Math.min(natural, up ? above : below);
      el.style.maxHeight = `${height}px`;
      el.style.top = `${up ? r.top - gap - height : r.bottom + gap}px`;
      el.classList.toggle("up", up);
      // Past the right edge, it lines up with its anchor's right edge instead,
      // and never starts off the left.
      const box = el.getBoundingClientRect();
      if (box.right > innerWidth - edge) el.style.left = `${Math.max(edge, Math.min(r.right, innerWidth - edge) - box.width)}px`;
      else if (box.left < edge) el.style.left = `${edge}px`;
    };
    place();
    const changes = new MutationObserver(place);
    changes.observe(el, { childList: true, subtree: true, characterData: true });
    return () => changes.disconnect();
  }, [open, anchor, panel, left]);
}

// useDismiss closes a popup, such as a menu, on a click outside every one of
// `boxes` or on Escape, while it is open.
export function useDismiss(open: boolean, close: () => void, ...boxes: RefObject<HTMLElement | null>[]) {
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!boxes.some((b) => b.current?.contains(e.target as Node))) close();
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
    // The boxes are refs, which keep their identity.
  }, [open, close]);
}
