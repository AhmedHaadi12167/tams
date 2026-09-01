/**
 * openPrintWindow — put HTML in a new window and print it.
 *
 * The window opens as about:blank and is written into, so it inherits the
 * app's Content-Security-Policy. In production that policy forbids inline
 * script — deliberately, since it is what stops an injected <script> in a
 * passenger's name from ever running. It also, unavoidably, stopped these
 * pages' own `<script>window.onload=...print()</script>`, so the print dialog
 * never appeared on the live site while working perfectly on a dev server,
 * which has no such policy.
 *
 * Weakening the policy to fix a print button would be a bad trade. A popup
 * opened from here shares this origin, so script already running here can
 * simply call print() on it. Nothing inline, nothing relaxed.
 *
 * @param {string} html      the document to show
 * @param {object} [options]
 * @param {number} [options.delay] ms to wait after load, so images paint
 *                                 before the dialog opens
 * @returns {Window|null} the window, or null if the popup was blocked
 */
export const openPrintWindow = (html, { delay = 250 } = {}) => {
  const win = window.open("", "_blank");
  if (!win) return null;

  win.document.write(html);
  win.document.close();

  const go = () => {
    try {
      win.focus();
      win.print();
    } catch {
      // The window was closed before it settled. Nothing to print.
    }
  };

  if (win.document.readyState === "complete") setTimeout(go, delay);
  else win.addEventListener("load", () => setTimeout(go, delay));

  return win;
};
