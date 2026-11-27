// SPDX-License-Identifier: AGPL-3.0-or-later OR LicenseRef-Noodlegraph-Commercial
// SPDX-FileCopyrightText: 2026 Eagle Creative
/**
 * noodlegraph — pan and zoom of a canvas. Used by the editor; usable on its own.
 *
 * `attach(options)` makes a canvas zoomable with every input:
 *
 * | Input      | Zoom                                   | Pan                               |
 * |------------|----------------------------------------|-----------------------------------|
 * | Mouse      | wheel, around the pointer              | drag the background (the view's)  |
 * | Trackpad   | pinch (a `wheel` event with ctrlKey)   | two-finger scroll                 |
 * | Touch      | pinch with two fingers                 | one finger on the background, or two |
 * | Buttons    | − / 100 % / + / Fit                    |                                   |
 * | Keyboard   | + / − / 0 (Fit) while the view shows   |                                   |
 *
 * The zoom level is remembered per browser (localStorage, per `key`); where the picture sits
 * is not, because the content changes. The view keeps its own pointer handling for nodes,
 * wires and panning with one pointer; while two fingers are down `pinching` is true and the
 * view leaves the pointer alone.
 *
 * Options: `canvas`, `stage` (scaled with transform-origin 0 0), `controls` (an element the
 * buttons are put into), `key` (storage name), `min`, `max`, `fit()` (Fit button and 0),
 * `active()` (whether the view shows, for the keys), `onChange(view)`, `text` (other wording
 * for the buttons).
 */

const STEP = 1.2;  // a button press or key
const store = {
  get(key) { try { const k = Number(localStorage.getItem(`noodlegraph.zoom.${key}`)); return Number.isFinite(k) && k > 0 ? k : null; } catch { return null; } },
  set(key, k) { try { localStorage.setItem(`noodlegraph.zoom.${key}`, String(Math.round(k * 1000) / 1000)); } catch { /* no storage */ } },
};

/** A mouse wheel (zoom), or a trackpad's two-finger scroll (pan)? */
export function isMouseWheel(ev) {
  if (ev.deltaMode !== 0) return true;          // lines or pages: a wheel
  if (ev.deltaX !== 0) return false;            // sideways: a trackpad
  return Math.abs(ev.deltaY) >= 50;              // wheel notches are large, scroll steps small
}

export function attach(o) {
  const min = o.min ?? 0.2, max = o.max ?? 2.5;
  const view = { x: 0, y: 0, k: 1 };
  const touches = new Map();
  let pinch = null;            // { d0, k0, cx, cy } while two fingers are down
  let fingersDown = false;     // after a pinch until every finger is up: no panning by one
  const clamp = (k) => Math.min(max, Math.max(min, k));

  function apply() {
    o.stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
    const label = o.controls?.querySelector("[data-zoom=level]");
    if (label) label.textContent = `${Math.round(view.k * 100)} %`;
    o.controls?.querySelector("[data-zoom=out]")?.toggleAttribute("disabled", view.k <= min + 1e-6);
    o.controls?.querySelector("[data-zoom=in]")?.toggleAttribute("disabled", view.k >= max - 1e-6);
    o.onChange?.({ ...view });
  }

  function set(next, { remember = false } = {}) {
    if (next.k !== undefined) view.k = clamp(next.k);
    if (next.x !== undefined) view.x = next.x;
    if (next.y !== undefined) view.y = next.y;
    if (remember && o.key) store.set(o.key, view.k);
    apply();
  }

  /** Zoom by `factor` around a point of the canvas (default: its middle). */
  function zoomBy(factor, cx, cy, { remember = true } = {}) {
    const px = cx ?? o.canvas.clientWidth / 2, py = cy ?? o.canvas.clientHeight / 2;
    const k = clamp(view.k * factor);
    const f = k / view.k;
    set({ k, x: px - (px - view.x) * f, y: py - (py - view.y) * f }, { remember });
  }

  const zoomTo = (k, cx, cy) => zoomBy(k / view.k, cx, cy);
  const panBy = (dx, dy) => set({ x: view.x + dx, y: view.y + dy });
  const local = (clientX, clientY) => { const r = o.canvas.getBoundingClientRect(); return { x: clientX - r.left, y: clientY - r.top }; };
  /** Stage coordinates (unscaled) of a point on the screen. */
  function toStage(clientX, clientY) {
    const p = local(clientX, clientY);
    return { x: (p.x - view.x) / view.k, y: (p.y - view.y) / view.k };
  }

  // ---------------------------------------------------------------- wheel and trackpad
  o.canvas.addEventListener("wheel", (ev) => {
    ev.preventDefault();  // never scroll or zoom the page from the canvas
    const p = local(ev.clientX, ev.clientY);
    if (ev.ctrlKey) {  // trackpad pinch (or Ctrl + wheel): smooth
      zoomBy(Math.exp(-ev.deltaY * (ev.deltaMode === 1 ? 0.05 : 0.01)), p.x, p.y);
    } else if (ev.shiftKey && isMouseWheel(ev)) {
      panBy(-ev.deltaY * (ev.deltaMode === 1 ? 20 : 1), 0);
    } else if (isMouseWheel(ev)) {
      const notch = ev.deltaMode === 1 ? ev.deltaY / 3 : ev.deltaY / 100;
      zoomBy(Math.pow(1.15, -Math.max(-3, Math.min(3, notch))), p.x, p.y);
    } else {
      panBy(-ev.deltaX, -ev.deltaY);
    }
  }, { passive: false });

  // ---------------------------------------------------------------- two fingers
  const spread = () => {
    const [a, b] = [...touches.values()];
    const m = local((a.x + b.x) / 2, (a.y + b.y) / 2);
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: m.x, cy: m.y };
  };
  o.canvas.addEventListener("pointerdown", (ev) => {
    if (ev.pointerType !== "touch") return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (touches.size === 2) {
      const s = spread();
      pinch = { d0: s.d, k0: view.k, cx: s.cx, cy: s.cy };
      fingersDown = true;
      o.onPinchStart?.();
    }
  }, { capture: true });
  o.canvas.addEventListener("pointermove", (ev) => {
    if (!touches.has(ev.pointerId)) return;
    touches.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    if (!pinch || touches.size < 2) return;
    const s = spread();
    panBy(s.cx - pinch.cx, s.cy - pinch.cy);  // two fingers moving together pan
    zoomTo(pinch.k0 * (s.d / pinch.d0), s.cx, s.cy);
    pinch.cx = s.cx; pinch.cy = s.cy;
  }, { capture: true });
  const lift = (ev) => {
    touches.delete(ev.pointerId);
    if (touches.size < 2) pinch = null;
    if (touches.size === 0) fingersDown = false;
  };
  // on window: a finger lifted outside the canvas still counts
  window.addEventListener("pointerup", lift, true);
  window.addEventListener("pointercancel", lift, true);

  // ---------------------------------------------------------------- buttons and keys
  if (o.controls) {
    const btn = (zoom, text, label, act) => {
      const b = document.createElement("button");
      Object.assign(b, { type: "button", className: "ng-btn-quiet ng-btn-small ng-zoom-btn", textContent: text, title: label });
      b.dataset.zoom = zoom;
      b.setAttribute("aria-label", label);
      b.addEventListener("click", act);
      return b;
    };
    o.controls.classList.add("ng-zoom-controls");
    o.controls.setAttribute("role", "group");
    const t = { zoomLabel: "Zoom", zoomOut: "Zoom out (−)", zoomReset: "Zoom to 100 %", zoomIn: "Zoom in (+)", fit: "Fit", zoomFit: "Show everything (0)", ...(o.text ?? {}) };
    o.controls.setAttribute("aria-label", t.zoomLabel);
    o.controls.replaceChildren(
      btn("out", "−", t.zoomOut, () => zoomBy(1 / STEP)),
      btn("level", "100 %", t.zoomReset, () => zoomTo(1)),
      btn("in", "+", t.zoomIn, () => zoomBy(STEP)),
      ...(o.fit ? [btn("fit", t.fit, t.zoomFit, () => o.fit())] : []));
  }
  const onKey = (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey || !o.active?.()) return;
    if (ev.target.closest?.("input, select, textarea, [contenteditable], dialog")) return;
    if (ev.key === "+" || ev.key === "=") zoomBy(STEP);
    else if (ev.key === "-" || ev.key === "_") zoomBy(1 / STEP);
    else if (ev.key === "0" && o.fit) o.fit();
    else return;
    ev.preventDefault();
  };
  document.addEventListener("keydown", onKey);
  /** Take the listeners outside the canvas away again (the canvas is being removed). */
  const detach = () => {
    window.removeEventListener("pointerup", lift, true);
    window.removeEventListener("pointercancel", lift, true);
    document.removeEventListener("keydown", onKey);
  };

  apply();
  return {
    get view() { return { ...view }; },
    get pinching() { return fingersDown; },
    /** The zoom level this browser used last for this view, or null. */
    get remembered() { return o.key ? store.get(o.key) : null; },
    set, zoomBy, zoomTo, panBy, toStage, apply, detach,
    min, max,
  };
}
