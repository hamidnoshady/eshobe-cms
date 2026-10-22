1. **Enhance a11y in `JalaliDateField.tsx`**: Add critical ARIA attributes to the date picker.
   - Add `aria-expanded={open}` and `aria-haspopup="dialog"` to the main `jdp__input` button.
   - Add `aria-label="تغییر نمای تقویم"` (Change calendar view) to the `jdp__title` button.
   - Add `aria-pressed={selected && selected.y === cursor.y && selected.m === cursor.m && selected.d === d}` to the day buttons.

2. **Verify changes**: Check linting and tests to ensure no regressions.
3. **Complete pre-commit steps**: Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.
4. **Submit PR**: Title "🎨 Palette: [UX improvement]" and include required sections.
