import React from 'react'

import type { UIFieldServerProps } from 'payload'

import { ActionButton } from './ActionButton'

/**
 * The self-test panel on a `deploy-targets` document.
 *
 * The token is write-only and encrypted: nothing in the admin UI can show it back, so
 * "did I paste it correctly?" has exactly one answer — ask Coolify. This button is
 * that question, and it is why the collection's description tells operators to run it
 * before using a server.
 *
 * The result is recorded on the row rather than only rendered here, so the list view
 * can show `lastSelfTestOk` and a server that has never been proven doesn't look the
 * same as one that passed.
 *
 * Note the id travels in the **body**: `/api/deploy-targets/self-test` is a collection
 * endpoint, and a path segment there would be read as a document id by Payload's own
 * routing.
 */
export const DeployTargetActions: React.FC<UIFieldServerProps> = ({ data, id }) => {
  if (!id) {
    return (
      <div className="banner banner--type-default">
        ابتدا نشانی و توکن سرور را ذخیره کنید، سپس «خودآزمایی» را اجرا کنید.
      </div>
    )
  }

  const doc = (data ?? {}) as Record<string, unknown>
  const ok = doc.lastSelfTestOk === true
  const at = doc.lastSelfTestAt ? String(doc.lastSelfTestAt) : null
  const detail = doc.lastSelfTestDetail ? String(doc.lastSelfTestDetail) : null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <ActionButton
        label="خودآزمایی اتصال"
        successMessage="اتصال برقرار شد و توکن معتبر است."
        url="/api/deploy-targets/self-test"
      />

      {!at && (
        <div className="banner banner--type-default">
          این سرور هنوز آزمایش نشده است. پیش از اولین استقرار، خودآزمایی را اجرا کنید — توکن
          رمزنگاری‌شده ذخیره می‌شود و راه دیگری برای بررسی درستی آن وجود ندارد.
        </div>
      )}

      {at && (
        <div className={`banner banner--type-${ok ? 'success' : 'error'}`}>
          آخرین خودآزمایی: {ok ? 'موفق' : 'ناموفق'}
          {detail ? ` — ${detail}` : ''}
        </div>
      )}
    </div>
  )
}

export default DeployTargetActions
