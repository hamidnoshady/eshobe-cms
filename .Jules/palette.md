## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).

## 2024-10-02 - Form Submission UX and Duplicate Prevention
**Learning:** The public form submission block (`src/blocks/Form/Component.tsx`) previously managed loading states manually with a 1-second delayed `setTimeout` and left the submit button enabled, leading to a clunky UX and potential duplicate form submissions by double-clicking.
**Action:** When using `react-hook-form`, prefer its built-in `isSubmitting` form state over manual loading flags. Always bind `disabled={isSubmitting}` to the primary submit button to instantly freeze user action and show loading text directly on the button instead of a separate DOM node for a unified, clear interaction model.
