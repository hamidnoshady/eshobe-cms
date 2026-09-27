import { describe, expect, it, vi } from 'vitest'

import {
  contentSlotSearchWhere,
  fetchAllContentSlotOptions,
  mapContentDocsToOptions,
} from '@/deploy/admin/contentSlotOptions'

describe('content slot option loading', () => {
  it('maps docs to id/label pairs', () => {
    expect(
      mapContentDocsToOptions([
        { id: '1', title: 'About' },
        { filename: 'logo.png', id: '2' },
        { id: '3' },
      ]),
    ).toEqual([{ id: '1', label: 'About' }, { id: '2', label: 'logo.png' }])
  })

  it('builds search filters per slot type', () => {
    expect(contentSlotSearchWhere('page', '  home ')).toEqual({
      or: [{ title: { contains: 'home' } }, { slug: { contains: 'home' } }],
    })
    expect(contentSlotSearchWhere('media', 'logo')).toEqual({ filename: { contains: 'logo' } })
    expect(contentSlotSearchWhere('post', '')).toBeUndefined()
  })

  it('paginates past the first 100 rows', async () => {
    const fetchPage = vi.fn(async ({ page }: { page: number }) => {
      if (page === 1) {
        return {
          docs: Array.from({ length: 100 }, (_, index) => ({
            id: `p-${index}`,
            title: `Page ${index}`,
          })),
          hasNextPage: true,
          nextPage: 2,
        }
      }
      return {
        docs: [{ id: 'p-100', title: 'Page 100' }],
        hasNextPage: false,
        nextPage: null,
      }
    })

    const options = await fetchAllContentSlotOptions(fetchPage, 'page')
    expect(options).toHaveLength(101)
    expect(fetchPage).toHaveBeenCalledTimes(2)
  })
})
