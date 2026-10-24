// Material for MkDocs renders its search overlay as `role="dialog"` with no accessible name, so a
// screen reader announces an unnamed dialog (axe `aria-dialog-name`, serious — measured on
// docs.fairwins.app 2026-09-14, chippr-robotics/chippr-bots#204). Name it once per page view.
// `navigation.instant` swaps pages without a load event, so the theme's `document$` observable is
// the hook when it exists; a plain load listener covers the no-instant case.
(function () {
  function nameSearchDialog() {
    var dialog = document.querySelector('.md-search[role="dialog"]');
    if (dialog && !dialog.hasAttribute("aria-label") && !dialog.hasAttribute("aria-labelledby")) {
      dialog.setAttribute("aria-label", "Search");
    }
  }
  if (typeof document$ !== "undefined" && document$ && typeof document$.subscribe === "function") {
    document$.subscribe(nameSearchDialog);
  } else {
    document.addEventListener("DOMContentLoaded", nameSearchDialog);
  }
})();
