## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2024-05-23 - React Hook Form Submitting State
**Learning:** In PayloadCMS/Next.js dynamic forms using `react-hook-form`, `isSubmitting` is only tracked automatically if the `onSubmit` handler returns the Promise from the async operation. Otherwise, forms miss this native capability, causing confusing UX with multiple submissions possible.
**Action:** Always verify that async `onSubmit` handlers return a Promise when using `react-hook-form` to properly leverage `isSubmitting` for UI feedback.
