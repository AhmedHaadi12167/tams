import React, { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import { MoreVertical } from "lucide-react";

/**
 * ActionsMenu — one button per row instead of five.
 *
 * A row that ends in view / print / pay / edit / delete is four buttons too
 * many. They push the table sideways, the row wraps on a phone, and the
 * destructive one sits a few pixels from the harmless one. Collapsing them
 * behind a single ⋮ fixes all three, and has the useful side effect that
 * adding a sixth action later costs no horizontal space at all.
 *
 * Rendered through a portal into <body>. A menu drawn inside the table would
 * be clipped by the `overflow-x-auto` wrapper every list here uses — it would
 * simply not appear for the last row, which is the kind of bug that looks
 * like the button is broken.
 *
 * Usage:
 *
 *   <ActionsMenu
 *     items={[
 *       { label: "View", icon: Eye, onClick: () => open(row) },
 *       { label: "Delete", icon: Trash2, danger: true, onClick: ... },
 *     ]}
 *   />
 *
 * Every item is a plain onClick. There is deliberately no way to render a
 * component *inside* the menu: an earlier version allowed it, a Pay button
 * with its own modal was put there, and clicking it closed the menu — which
 * unmounted the portal and destroyed the modal before it could paint. The
 * button looked simply dead. A modal has to outlive the thing that opened
 * it, so it belongs at page level and the menu item only sets state.
 */

export default function ActionsMenu({ items = [], label = "Actions" }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef(null);
  const menuRef = useRef(null);

  const visible = items.filter(Boolean);
  if (visible.length === 0) return null;

  const place = () => {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    // Right-aligned under the button, nudged back on screen if it would
    // spill off a narrow phone.
    const width = 200;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    // Flip above when there isn't room below, so the last row of a long
    // table doesn't open a menu into empty space past the fold.
    const estimated = visible.length * 40 + 12;
    const below = window.innerHeight - r.bottom;
    const top = below < estimated && r.top > estimated ? r.top - estimated - 4 : r.bottom + 4;
    setPos({ top, left, width });
  };

  const toggle = () => {
    if (!open) place();
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e) => {
      if (
        !menuRef.current?.contains(e.target) &&
        !btnRef.current?.contains(e.target)
      )
        setOpen(false);
    };
    const esc = (e) => e.key === "Escape" && setOpen(false);
    // Scrolling or resizing moves the button out from under the menu, and a
    // menu floating beside nothing is worse than one that just closes.
    const close = () => setOpen(false);

    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`p-1.5 rounded-lg transition-colors ${
          open
            ? "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-200"
            : "text-gray-400 hover:text-gray-700 hover:bg-gray-100 dark:hover:bg-gray-700 dark:hover:text-gray-200"
        }`}
      >
        <MoreVertical className="w-4 h-4" />
      </button>

      {open &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            style={{ top: pos.top, left: pos.left, width: pos.width }}
            className="fixed z-50 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg py-1"
          >
            {visible.map((item, i) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.label || i}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onClick?.();
                  }}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                    item.danger
                      ? "text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20"
                      : "text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/60"
                  }`}
                >
                  {Icon && <Icon className="w-4 h-4 shrink-0" />}
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </>
  );
}
