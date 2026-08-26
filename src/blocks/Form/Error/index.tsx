'use client'

import * as React from 'react'
import { useFormContext } from 'react-hook-form'

export const Error = ({ name }: { name: string }) => {
  const {
    formState: { errors },
  } = useFormContext()
  return (
    // `text-destructive`, not `text-red-500`: the per-site theme owns the palette, so
    // a hardcoded red is the one colour on the page that ignores it. `role="alert"`
    // because the message appears only after a failed submit.
    <div className="mt-2 text-destructive text-sm" role="alert">
      {(errors[name]?.message as string) || 'این فیلد الزامی است'}
    </div>
  )
}
