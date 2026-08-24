import { describe, expect, it } from 'vitest'

import { slugify } from '@/lib/slug'

describe('slugify', () => {
  it('keeps Persian letters instead of stripping them', () => {
    expect(slugify('درباره ما')).toBe('درباره-ما')
    expect(slugify('تماس با ما!')).toBe('تماس-با-ما')
  })

  it('still handles Latin', () => {
    expect(slugify('  About Us — 2026 ')).toBe('about-us-2026')
  })

  it('normalises what two keyboards spell differently', () => {
    // Arabic yeh + kaf vs Persian yeh + kaf.
    expect(slugify('كيف')).toBe(slugify('کیف'))
    expect(slugify('صفحهٔ ۱۲')).toBe('صفحهٔ-12')
  })

  it('splits on ZWNJ, which cannot survive a URL', () => {
    expect(slugify('به‌زودی')).toBe('به-زودی')
  })

  it('never returns leading, trailing or doubled separators', () => {
    expect(slugify('!!! سلام --- دنیا !!!')).toBe('سلام-دنیا')
    expect(slugify('***')).toBe('')
    expect(slugify(null)).toBe('')
  })
})
