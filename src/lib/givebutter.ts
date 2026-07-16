// Givebutter popup integration helpers.
//
// The Givebutter loader script (in index.html) injects a global custom element
// (`<givebutter-widget>`) and intercepts clicks on anchors pointing to
// `givebutter.com/<id>` to open its built-in modal popup. We mount a hidden
// widget instance once, then trigger the popup by programmatically clicking a
// transient anchor.

const GIVEBUTTER_SCRIPT_SRC =
  "https://widgets.givebutter.com/latest.umd.cjs?acct=RQfQjxSSl93M8x0T&p=other";

export const GIVEBUTTER_WIDGET_ID = "j1XXrb";
export const GIVEBUTTER_DONATE_URL = `https://givebutter.com/${GIVEBUTTER_WIDGET_ID}`;

let initialized = false;

/** Ensure the Givebutter loader script + a hidden widget instance are mounted. */
export const ensureGivebutterLoaded = () => {
  if (typeof document === "undefined" || initialized) return;
  initialized = true;

  if (!document.querySelector(`script[src="${GIVEBUTTER_SCRIPT_SRC}"]`)) {
    const script = document.createElement("script");
    script.src = GIVEBUTTER_SCRIPT_SRC;
    script.async = true;
    document.body.appendChild(script);
  }

  if (!document.querySelector(`givebutter-widget[id="${GIVEBUTTER_WIDGET_ID}"]`)) {
    const widget = document.createElement("givebutter-widget");
    widget.setAttribute("id", GIVEBUTTER_WIDGET_ID);
    widget.setAttribute("style", "display:none");
    document.body.appendChild(widget);
  }
};

/**
 * Open the Givebutter donation popup. Falls back to opening the donation
 * URL in a new tab if the loader isn't ready.
 */
export const openGivebutterPopup = () => {
  ensureGivebutterLoaded();
  if (typeof document === "undefined") return;

  const anchor = document.createElement("a");
  anchor.href = GIVEBUTTER_DONATE_URL;
  anchor.rel = "noopener noreferrer";
  anchor.style.display = "none";
  document.body.appendChild(anchor);

  const fire = () => {
    anchor.click();
    setTimeout(() => anchor.remove(), 0);
  };

  let attempts = 0;
  const tryFire = () => {
    attempts += 1;
    fire();
    setTimeout(() => {
      const opened = document.querySelector(
        "iframe[src*='givebutter.com'], [data-givebutter-modal], .givebutter-widget-overlay",
      );
      if (!opened && attempts < 4) {
        tryFire();
      } else if (!opened && attempts >= 4) {
        window.open(GIVEBUTTER_DONATE_URL, "_blank", "noopener,noreferrer");
      }
    }, 250);
  };

  tryFire();
};