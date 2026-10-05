## 2024-05-15 - Inline loading states for async actions
**Learning:** Moving loading text elements from loose blocks (like `<p>در حال ارسال…</p>`) into the submission button itself, alongside a spinner and `disabled` state, is much more accessible and provides better immediate feedback to users regarding async actions.
**Action:** Always wrap async submission buttons in a disabled state and swap their content for an animated spinner (like `Loader2` from `lucide-react`) combined with localized loading text.
