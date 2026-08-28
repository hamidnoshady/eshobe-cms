import React from 'react'

import type { ContactBlock as Props } from '@/payload-types'

import { toLocaleDigits } from '@/lib/format'
import { getSiteContext } from '@/lib/site-context'
import { uiString } from '@/lib/ui-strings'

/**
 * The chrome strings live in `src/lib/ui-strings.ts` — the shared map exists because
 * the storefront's purchase form needs the same four words. Everything else this
 * block renders is editor content, which Payload localizes.
 */
export const ContactBlockComponent = async ({
  address,
  email,
  heading,
  hours,
  intro,
  phones,
}: Props) => {
  const { locale } = await getSiteContext()

  return (
    <section className="container">
      {(heading || intro) && (
        <div className="max-w-2xl mb-8">
          {heading && <h2 className="text-3xl font-bold">{heading}</h2>}
          {intro && <p className="mt-3 text-muted-foreground">{intro}</p>}
        </div>
      )}

      <dl className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4">
        {address && (
          <div>
            <dt className="font-semibold">{uiString('address', locale)}</dt>
            <dd className="mt-2 whitespace-pre-line text-muted-foreground">{address}</dd>
          </div>
        )}

        {phones && phones.length > 0 && (
          <div>
            <dt className="font-semibold">{uiString('phone', locale)}</dt>
            {phones.map((phone) => (
              <dd className="mt-2" key={phone}>
                {/* `href` keeps the raw ASCII digits — a `tel:` with Persian-Indic
                    digits does not dial. `<bdi>` stops the bidi algorithm reordering
                    a number that sits in a right-to-left paragraph. */}
                <a className="text-muted-foreground hover:text-foreground" href={`tel:${phone}`}>
                  <bdi>{toLocaleDigits(phone, locale)}</bdi>
                </a>
              </dd>
            ))}
          </div>
        )}

        {email && (
          <div>
            <dt className="font-semibold">{uiString('email', locale)}</dt>
            <dd className="mt-2">
              <a className="text-muted-foreground hover:text-foreground" href={`mailto:${email}`}>
                <bdi>{email}</bdi>
              </a>
            </dd>
          </div>
        )}

        {hours && (
          <div>
            <dt className="font-semibold">{uiString('hours', locale)}</dt>
            <dd className="mt-2 whitespace-pre-line text-muted-foreground">
              {toLocaleDigits(hours, locale)}
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}
