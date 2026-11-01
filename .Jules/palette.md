## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2024-10-18 - Async Form Submit UX
**Learning:** `react-hook-form` only automatically tracks `isSubmitting` when the `onSubmit` handler explicitly returns a Promise, which is important for natively rendering disabled states for form inputs.
**Action:** Always verify `void` is not used for async form handlers and utilize `isSubmitting` for submit button `disabled` states to prevent duplicate submissions and give visual feedback.
## 2024-10-28 - Date Picker Screen Reader Support
**Learning:** Date picker cell grids are often constructed with numbered buttons representing days without context of month or year. Screen readers reading just the numbers create a confusing experience.
**Action:** Always add an `aria-label` to dynamically generated calendar cell buttons that includes the full context (e.g. "Select Day Month Year").
