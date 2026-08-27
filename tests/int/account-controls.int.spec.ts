import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

import config from '@/payload.config'
import { Users } from '@/collections/Users'

describe('Account and User admin controls configuration', () => {
  it('registers AccountView as custom account view in payload.config', async () => {
    const resolvedConfig = await config
    const accountView = resolvedConfig.admin?.components?.views?.account
    expect(accountView).toBeDefined()
    expect(accountView?.Component).toBe('@/components/admin/AccountView')
  })

  it('registers CancelButton and AccountSaveButton in Users collection edit components', () => {
    const editComponents = Users.admin?.components?.edit
    expect(editComponents).toBeDefined()
    expect(editComponents?.beforeDocumentControls).toContain('@/components/admin/CancelButton')
    expect(editComponents?.SaveButton).toBe('@/components/admin/AccountSaveButton')
  })

  it('includes entries in importMap.js for the custom account components', () => {
    const importMapPath = path.resolve(process.cwd(), 'src/app/(payload)/admin/importMap.js')
    const content = fs.readFileSync(importMapPath, 'utf8')

    expect(content).toContain('@/components/admin/CancelButton#default')
    expect(content).toContain('@/components/admin/AccountSaveButton#default')
    expect(content).toContain('@/components/admin/AccountView#default')
  })

  it('has custom.scss with RTL and responsive fixes for buttons and controls', () => {
    const scssPath = path.resolve(process.cwd(), 'src/app/(payload)/custom.scss')
    const content = fs.readFileSync(scssPath, 'utf8')

    // Gradient overlay that hid button labels in RTL is disabled
    expect(content).toContain('.doc-controls__controls::after')
    expect(content).toContain('display: none !important')

    // Button label visibility guarantees
    expect(content).toContain('.btn__label')
    expect(content).toContain('visibility: visible !important')

    // Responsive fixes for mobile/tablet
    expect(content).toContain('@media (max-width: 1024px)')
    expect(content).toContain('top: 0 !important')

    // Horizontal overflow fix for .payload-settings in RTL
    expect(content).toContain('.payload-settings')
    expect(content).toContain('inset-inline-start: 0 !important')
  })

  it('verifies component source files exist and export default and named components', () => {
    const cancelButtonSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/admin/CancelButton.tsx'),
      'utf8',
    )
    const saveButtonSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/admin/AccountSaveButton.tsx'),
      'utf8',
    )
    const accountViewSrc = fs.readFileSync(
      path.resolve(process.cwd(), 'src/components/admin/AccountView.tsx'),
      'utf8',
    )

    expect(cancelButtonSrc).toContain('export const CancelButton')
    expect(cancelButtonSrc).toContain('action-cancel')
    expect(cancelButtonSrc).toContain('general:cancel')

    expect(saveButtonSrc).toContain('export const AccountSaveButton')
    expect(saveButtonSrc).toContain('action-save')
    expect(saveButtonSrc).toContain('general:save')
    expect(saveButtonSrc).toContain('general:saving')

    expect(accountViewSrc).toContain('export const AccountView')
    expect(accountViewSrc).toContain('BeforeDocumentControls={<CancelButton />}')
    expect(accountViewSrc).toContain('SaveButton={<AccountSaveButton />}')
  })
})
