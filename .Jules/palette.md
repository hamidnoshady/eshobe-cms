## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2024-10-13 - Correct react-hook-form async submission behavior

**Learning:** When using `react-hook-form`, async `onSubmit` handlers must explicitly return a Promise. If the handler uses an async wrapper function but doesn't return it (e.g., calling `void submitForm()`), `react-hook-form` will not be able to track the internal async execution, leading to `isSubmitting` resolving prematurely.

**Action:** Always verify that the final operation in an async `onSubmit` callback is returning the Promise of the execution (e.g., `return submitForm()`), which allows proper tracking of loading and disabled states in form submissions natively through `formState.isSubmitting`.
