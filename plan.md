1. **Add `SearchIcon` to the search submit button**
   - The search submit button is currently a text-only, screen-reader-only button. I'll add the `Search` icon from `lucide-react` to it and make it visible inside the form, by styling it properly next to the input or overlaying it.
   - I'll change `src/search/Component.tsx` to include `Search as SearchIcon` from `lucide-react`.
   - Update the form to have a relative layout, and place the button inside or next to the input with appropriate styling (e.g. absolute position for inside the input).
   - Ensure the button has an `aria-label` for screen readers since the text will be hidden.
2. **Complete pre-commit steps**
   - Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.
3. **Submit PR**
   - Submit the UX improvement.
