import type { Block } from 'payload'

export const Code: Block = {
  slug: 'code',
  interfaceName: 'CodeBlock',
  labels: { plural: 'کدها', singular: 'کد' },
  fields: [
    {
      name: 'language',
      type: 'select',
      label: 'زبان',
      defaultValue: 'typescript',
      options: [
        {
          label: 'تایپ‌اسکریپت',
          value: 'typescript',
        },
        {
          label: 'جاوااسکریپت',
          value: 'javascript',
        },
        {
          label: 'CSS',
          value: 'css',
        },
      ],
    },
    {
      name: 'code',
      type: 'code',
      label: false,
      required: true,
    },
  ],
}
