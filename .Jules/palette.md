## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).

## 2026-10-08 - Localized Screen Reader Only Labels
**Learning:** Found a hardcoded english string 'submit' inside an `sr-only` (screen reader only) class in the Search component (`src/search/Component.tsx`). This means screen reader users viewing the Persian site would still hear English here.
**Action:** When adding `sr-only` text for accessibility, remember that this text must also be localized using the app's `uiString` function just like visible text.
