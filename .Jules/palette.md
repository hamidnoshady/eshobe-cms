## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2024-05-24 - Returning Promise in react-hook-form
**Learning:** In order for `react-hook-form` to natively update its `isSubmitting` property in the `formState`, the async `onSubmit` handler must explicitly return a Promise. A fire-and-forget (`void`) submission causes `isSubmitting` to immediately flip back to false, breaking UI feedback states like disabled buttons or loading spinners.
**Action:** When implementing or fixing disabled loading states in forms handled by `react-hook-form`, ensure that the submit function returns the Promise (e.g., `return submitForm()` instead of `void submitForm()`).
