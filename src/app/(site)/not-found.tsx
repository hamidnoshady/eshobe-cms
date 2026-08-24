import Link from 'next/link'
import React from 'react'

import { Button } from '@/components/ui/button'

export default function NotFound() {
  return (
    <div className="container py-28">
      <div className="prose max-w-none">
        <h1 style={{ marginBottom: 0 }}>۴۰۴</h1>
        <p className="mb-4">این صفحه پیدا نشد.</p>
      </div>
      <Button asChild variant="default">
        <Link href="/">بازگشت به خانه</Link>
      </Button>
    </div>
  )
}
