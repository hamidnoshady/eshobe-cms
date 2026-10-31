## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2024-10-18 - Async Form Submit UX
**Learning:** `react-hook-form` only automatically tracks `isSubmitting` when the `onSubmit` handler explicitly returns a Promise, which is important for natively rendering disabled states for form inputs.
**Action:** Always verify `void` is not used for async form handlers and utilize `isSubmitting` for submit button `disabled` states to prevent duplicate submissions and give visual feedback.
## 2024-11-01 - Consolidate Loading State with Submit Action
**Learning:** Moving a standalone `p` tag displaying a loading state into the `Button` element itself creates a much clearer link between the action the user took and the current status of the application. It prevents the loading text from getting lost or requiring visual scanning.
**Action:** Always prefer rendering loading states directly inside the interactive element that initiated the asynchronous operation over adding adjacent text blocks, unless the progress state is complex enough to require a separate UI component.
