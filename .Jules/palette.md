## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).

## 2024-10-02 - Form Submission UX State
**Learning:** The form block component (`src/blocks/Form/Component.tsx`) handled the loading state visually (`isLoading` text), but the submit button itself remained active during the submission process. This could lead to accidental double-submissions.
**Action:** Always ensure that submit buttons are disabled when a form submission is in progress (`isLoading` or `isSubmitting`). Look for `disabled={isLoading}` on form submit buttons to improve interaction feedback.
