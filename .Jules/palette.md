## 2024-10-02 - Icon-Only Button Accessibility
**Learning:** Found a missing `aria-label` on the mobile hamburger close button (`NavHamburgerButton` in `src/admin/nav/EshobeNav.client.tsx`). Adding `aria-label` provides critical context for screen readers when an icon is used alone.
**Action:** When finding or creating icon-only buttons (like `Hamburger` icons, `X` close buttons), ensure to add an `aria-label` in the appropriate local language (e.g., Persian `بستن منو` for Close menu in this project).
## 2024-10-23 - ARIA Attributes for Custom Popovers
**Learning:** Custom UI components like the Jalali calendar date picker in Payload CMS needed proper `aria-expanded` and `aria-haspopup="dialog"` properties to communicate interactive popover status to screen readers, as well as an `aria-label` for utility buttons that switch views (e.g. from days to months).
**Action:** When inspecting or reviewing custom dropdowns, menus, or date pickers, always verify that the trigger button communicates its state (`aria-expanded`) and role (`aria-haspopup`).
