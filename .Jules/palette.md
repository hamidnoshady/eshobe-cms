## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2026-10-20 - Native Promise Return for react-hook-form
**Learning:** Found a component (FormBlock) where async submission didn't update the react-hook-form native `isSubmitting` state properly. Returning the Promise from the onSubmit handler is required for react-hook-form to properly update and allow the disabled state on buttons during form submission.
**Action:** When working with react-hook-form async submissions, always `return` the Promise instead of using `void` or no return so the UI can accurately reflect disabled/loading states without manual state management.
