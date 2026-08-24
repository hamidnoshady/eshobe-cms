import type { CollectionConfig } from 'payload'

import { authenticated } from '../access/authenticated'
import { isHexColor } from '../lib/theme'

/**
 * A colour that will be interpolated into a `<style>` tag. Rejected in the admin as
 * well as dropped at render time — an editor who typed `red` deserves to be told,
 * not to wonder why the site looks unchanged.
 */
const hexColor = (value: unknown): string | true =>
  isHexColor(value) || value == null ? true : 'رنگ را به شکل کد هکس بنویسید، مثل #0f766e.'

/**
 * Per-site design tokens. Registered as `isGlobal: true` in the multi-tenant
 * plugin, so each site gets exactly one document and edits it like a global —
 * Payload globals cannot be tenant-scoped.
 *
 * ponytail: colours, radius and line-height only. `src/lib/theme.ts` emits them as
 * CSS custom properties; a font picker and density/preset knobs go in when a customer
 * actually asks, since Vazirmatn is the only permitted family today.
 */
export const Theme: CollectionConfig = {
  slug: 'theme',
  access: {
    create: authenticated,
    delete: authenticated,
    // Public: the site shell needs the tokens to render. Scoped by `findForSite`.
    read: () => true,
    update: authenticated,
  },
  labels: {
    singular: 'پوسته',
    plural: 'پوسته',
  },
  fields: [
    {
      type: 'row',
      fields: [
        {
          name: 'primary',
          type: 'text',
          label: 'رنگ اصلی',
          defaultValue: '#0f766e',
          validate: hexColor,
        },
        {
          name: 'accent',
          type: 'text',
          label: 'رنگ تأکید',
          defaultValue: '#f59e0b',
          validate: hexColor,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'background',
          type: 'text',
          label: 'پس‌زمینه',
          defaultValue: '#ffffff',
          validate: hexColor,
        },
        {
          name: 'foreground',
          type: 'text',
          label: 'متن',
          defaultValue: '#0a0a0a',
          validate: hexColor,
        },
      ],
    },
    {
      type: 'row',
      fields: [
        {
          name: 'radius',
          type: 'select',
          label: 'گردی گوشه‌ها',
          defaultValue: 'md',
          options: [
            { label: 'بدون گردی', value: 'none' },
            { label: 'کم', value: 'sm' },
            { label: 'متوسط', value: 'md' },
            { label: 'زیاد', value: 'lg' },
          ],
        },
        {
          name: 'lineHeight',
          type: 'number',
          label: 'فاصله خطوط',
          defaultValue: 1.8,
          min: 1.4,
          max: 2.4,
          admin: {
            description: 'فارسی به فضای عمودی بیشتری از لاتین نیاز دارد؛ کمتر از ۱٫۶ توصیه نمی‌شود.',
            step: 0.1,
          },
        },
      ],
    },
  ],
}
