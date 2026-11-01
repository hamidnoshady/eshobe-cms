## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2024-10-18 - Async Form Submit UX
**Learning:** `react-hook-form` only automatically tracks `isSubmitting` when the `onSubmit` handler explicitly returns a Promise, which is important for natively rendering disabled states for form inputs.
**Action:** Always verify `void` is not used for async form handlers and utilize `isSubmitting` for submit button `disabled` states to prevent duplicate submissions and give visual feedback.
## 2024-11-01 - Icon-only buttons lacking ARIA labels
**Learning:** Found an icon-only button (`<Button buttonStyle="icon-label" icon="x" />`) used for removing users in `src/provisioning/AdminForm.tsx` that lacked an `aria-label`. This pattern is common for repetitive lists but causes accessibility issues for screen readers.
**Action:** Always ensure icon-only buttons (`buttonStyle="icon-label"`) have descriptive `aria-label` attributes to maintain accessibility.
