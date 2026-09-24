'use client'

import { Hamburger, Link, Logout, NavGroup, useNav } from '@payloadcms/ui'
import { usePathname } from 'next/navigation.js'
import React from 'react'

import type { ResolvedNavGroup } from '../navigation'

const baseClass = 'nav'

type Props = {
  /** Server-rendered slot for `admin.components.beforeNav` — the multi-tenant site selector lives here. */
  beforeNav?: React.ReactNode
  groups: ResolvedNavGroup[]
}

/**
 * The client half of the Eshobe sidebar. It reuses Payload's own nav primitives
 * (`NavGroup`, `Link`, `Logout`, `Hamburger`) and CSS class names (`nav*`), so it
 * inherits the panel's styling, RTL handling, collapse persistence and mobile
 * behaviour unchanged — the only thing that differs from the stock nav is which
 * groups are shown and under what labels (decided in `src/admin/navigation.ts`).
 */
export const EshobeNavClient: React.FC<Props> = ({ beforeNav, groups }) => {
  const pathname = usePathname()
  const { hydrated, navOpen, navRef, shouldAnimate } = useNav()

  const asideClass = [
    baseClass,
    navOpen && `${baseClass}--nav-open`,
    shouldAnimate && `${baseClass}--nav-animate`,
    hydrated && `${baseClass}--nav-hydrated`,
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <aside className={asideClass} inert={!navOpen ? true : undefined}>
      <div className={`${baseClass}__scroll`} ref={navRef}>
        {beforeNav}
        <nav className={`${baseClass}__wrap`}>
          {groups.map((group) => (
            <NavGroup key={group.label} label={group.label}>
              {group.entities.map((entity) => {
                const isActive =
                  pathname.startsWith(entity.href) &&
                  ['/', undefined].includes(pathname[entity.href.length])

                const label = (
                  <React.Fragment>
                    {isActive && <div className={`${baseClass}__link-indicator`} />}
                    <span className={`${baseClass}__link-label`}>{entity.label}</span>
                  </React.Fragment>
                )

                if (pathname === entity.href) {
                  return (
                    <div className={`${baseClass}__link`} id={entity.id} key={entity.id}>
                      {label}
                    </div>
                  )
                }

                return (
                  <Link
                    className={`${baseClass}__link`}
                    href={entity.href}
                    id={entity.id}
                    key={entity.id}
                    prefetch={false}
                  >
                    {label}
                  </Link>
                )
              })}
            </NavGroup>
          ))}

          <div className={`${baseClass}__controls`}>
            <Logout />
          </div>
        </nav>

        <div className={`${baseClass}__header`}>
          <div className={`${baseClass}__header-content`}>
            <NavHamburgerButton />
          </div>
        </div>
      </div>
    </aside>
  )
}

/** Mirrors `@payloadcms/next`'s internal NavHamburger (not a public export). */
const NavHamburgerButton: React.FC = () => {
  const { navOpen, setNavOpen } = useNav()
  return (
    <button
      className={`${baseClass}__mobile-close`}
      onClick={() => setNavOpen(false)}
      tabIndex={!navOpen ? -1 : undefined}
      type="button"
    >
      <Hamburger isActive />
    </button>
  )
}
