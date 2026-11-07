## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2024-10-18 - Async Form Submit UX
**Learning:** `react-hook-form` only automatically tracks `isSubmitting` when the `onSubmit` handler explicitly returns a Promise, which is important for natively rendering disabled states for form inputs.
**Action:** Always verify `void` is not used for async form handlers and utilize `isSubmitting` for submit button `disabled` states to prevent duplicate submissions and give visual feedback.
## 2024-11-08 - Accessible Icon Buttons in Search Form
**Learning:** Replaced a hidden text-only search submit button (`sr-only`) with a visible `SearchIcon` button placed absolutely within the input field. This follows standard UX patterns, provides a clear visual affordance, and retains accessibility via a properly localized `aria-label`.
**Action:** When working with forms or inputs that typically have an associated action button (like search or submit), use standard icon libraries (`lucide-react`) and position them visually within or adjacent to the input using Tailwind's layout and spacing utilities (`relative`, `absolute`, `pe-10`), while ensuring they are always accessible to screen readers with `aria-label`.
