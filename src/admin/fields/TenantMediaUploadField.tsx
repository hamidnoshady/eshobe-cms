'use client'

import type { UploadFieldClientProps } from 'payload'

import type { UploadInputProps } from '@payloadcms/ui'
import { BulkUploadProvider, UploadInput, useAuth, useConfig, useDocumentForm, useField, useLocale } from '@payloadcms/ui'
import { formatAdminURL } from 'payload/shared'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import './TenantMediaUploadField.scss'

type ID = number | string

type FolderDoc = {
  folder?: unknown
  folderType?: null | string[]
  id: ID
  name: string
}

type MediaDoc = {
  alt?: string | null
  filename?: string | null
  id: ID
  mimeType?: string | null
  sizes?: { thumbnail?: { url?: string | null } | null } | null
  url?: string | null
}

type Paginated<T> = {
  docs: T[]
  hasNextPage?: boolean
  nextPage?: number | null
  totalPages?: number
}

type Where = Record<string, unknown>

type PickerProps = {
  apiRoute: string
  foldersField: string
  foldersSlug: string
  hasMany: boolean
  initialFolderID: string | null
  initialIDs: string[]
  isPersian: boolean
  locale: string
  mediaFilter?: unknown
  onFolderChange: (folderID: string | null) => void
  maxRows?: number
  onClose: () => void
  onInsert: (ids: string[]) => void
  siteID: string
  uploadAllowed: boolean
}

const copy = (isPersian: boolean, fa: string, en: string): string => (isPersian ? fa : en)

const relationID = (value: unknown): string | null => {
  let current = value

  for (let index = 0; index < 5; index += 1) {
    if (typeof current === 'string' || typeof current === 'number') {
      return String(current)
    }

    if (!current || typeof current !== 'object') return null

    const record = current as Record<string, unknown>
    if ('value' in record) {
      current = record.value
      continue
    }
    if ('id' in record) {
      current = record.id
      continue
    }

    return null
  }

  return null
}

const collectionURL = (apiRoute: string, slug: string): string =>
  formatAdminURL({ apiRoute, path: `/${slug}` })

const appendQueryValue = (params: URLSearchParams, prefix: string, value: unknown): void => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => appendQueryValue(params, `${prefix}[${index}]`, item))
    return
  }

  if (value && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      appendQueryValue(params, `${prefix}[${key}]`, nested)
    }
    return
  }

  if (value !== undefined) params.append(prefix, value === null ? 'null' : String(value))
}

const queryURL = (apiRoute: string, slug: string, where: Where, page: number, locale?: string): string => {
  const params = new URLSearchParams({ depth: '0', limit: '60', page: String(page) })
  if (locale) params.set('locale', locale)
  appendQueryValue(params, 'where', where)
  return `${collectionURL(apiRoute, slug)}?${params.toString()}`
}

const responseDocs = async <T,>(response: Response): Promise<Paginated<T>> => {
  if (!response.ok) throw new Error('The media library could not be loaded.')
  return (await response.json()) as Paginated<T>
}

const appendConstraint = (where: Where, constraint: Where): Where => ({
  ...where,
  and: [...(Array.isArray(where.and) ? (where.and as Where[]) : []), constraint],
})

const folderParentID = (folder: FolderDoc, fieldName: string): string | null =>
  relationID((folder as unknown as Record<string, unknown>)[fieldName])

const canContainMedia = (folder: FolderDoc): boolean =>
  !folder.folderType?.length || folder.folderType.includes('media')

const PickerDialog = ({
  apiRoute,
  foldersField,
  foldersSlug,
  hasMany,
  initialFolderID,
  initialIDs,
  isPersian,
  locale,
  mediaFilter,
  onFolderChange,
  maxRows,
  onClose,
  onInsert,
  siteID,
  uploadAllowed,
}: PickerProps) => {
  const [folders, setFolders] = useState<FolderDoc[]>([])
  const [media, setMedia] = useState<MediaDoc[]>([])
  const [selectedIDs, setSelectedIDs] = useState<string[]>(initialIDs)
  const [selectedDocs, setSelectedDocs] = useState<Record<string, MediaDoc>>({})
  const [currentFolderID, setCurrentFolderID] = useState<string | null>(initialFolderID)
  const currentFolderIDRef = useRef(initialFolderID)
  const changeFolder = useCallback((folderID: string | null) => {
    currentFolderIDRef.current = folderID
    setCurrentFolderID(folderID)
    onFolderChange(folderID)
  }, [onFolderChange])
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [searchAllFolders, setSearchAllFolders] = useState(false)
  const [fileType, setFileType] = useState<'all' | 'raster' | 'svg'>('all')
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(1)
  const [folderLoading, setFolderLoading] = useState(true)
  const [mediaLoading, setMediaLoading] = useState(true)
  const [selectingAll, setSelectingAll] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const mediaRequestID = useRef(0)
  const folderMap = useMemo(() => new Map(folders.map((folder) => [String(folder.id), folder])), [folders])

  const folderPath = useMemo(() => {
    const path: FolderDoc[] = []
    let nextID = currentFolderID
    const visited = new Set<string>()

    while (nextID && !visited.has(nextID)) {
      visited.add(nextID)
      const folder = folderMap.get(nextID)
      if (!folder) break
      path.unshift(folder)
      nextID = folderParentID(folder, foldersField)
    }

    return path
  }, [currentFolderID, folderMap, foldersField])

  const activeFolder = folderPath.at(-1)
  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => canContainMedia(folder) && folderParentID(folder, foldersField) === (currentFolderID || null))
        .sort((a, b) => a.name.localeCompare(b.name)),
    [currentFolderID, folders, foldersField],
  )

  const baseWhere = useMemo(() => {
    let where: Where = { site: { equals: siteID } }
    if (mediaFilter && typeof mediaFilter === 'object' && !Array.isArray(mediaFilter)) {
      where = appendConstraint(where, mediaFilter as Where)
    }
    if (!searchAllFolders) {
      where = appendConstraint(where, currentFolderID
        ? { [foldersField]: { equals: currentFolderID } }
        : { [foldersField]: { exists: false } })
    }
    if (debouncedSearch.trim()) {
      const term = debouncedSearch.trim()
      where = appendConstraint(where, {
        or: [
          { filename: { like: term } },
          { alt: { like: term } },
        ],
      })
    }
    return where
  }, [currentFolderID, debouncedSearch, foldersField, mediaFilter, searchAllFolders, siteID])

  const queryWhere = useMemo(() => {
    if (fileType === 'svg') return appendConstraint(baseWhere, { mimeType: { equals: 'image/svg+xml' } })
    if (fileType === 'raster') return appendConstraint(baseWhere, { mimeType: { not_equals: 'image/svg+xml' } })
    return baseWhere
  }, [baseWhere, fileType])

  const refreshMedia = useCallback(async (requestedPage: number, where = queryWhere, append = false) => {
    const requestID = ++mediaRequestID.current
    const result = await responseDocs<MediaDoc>(await fetch(
      queryURL(apiRoute, 'media', where, requestedPage, locale),
      { credentials: 'include', headers: { Accept: 'application/json' } },
    ))
    if (requestID !== mediaRequestID.current) return
    setError('')
    setMedia((current) => append ? [...current, ...result.docs] : result.docs)
    setPage(requestedPage)
    setTotalPages(Math.max(1, result.totalPages ?? 1))
    setSelectedDocs((current) => ({
      ...current,
      ...Object.fromEntries(result.docs.map((doc) => [String(doc.id), doc])),
    }))
  }, [apiRoute, locale, queryWhere])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setDebouncedSearch(search)
      setPage(1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    dialogRef.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
        return
      }
      if (event.key !== 'Tab') return

      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )
      if (!focusable?.length) return
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  useEffect(() => {
    let current = true

    const loadFolders = async () => {
      const all: FolderDoc[] = []
      let nextPage = 1
      let lastPage = 1

      do {
        const result = await responseDocs<FolderDoc>(await fetch(
          queryURL(apiRoute, foldersSlug, { site: { equals: siteID } }, nextPage),
          { credentials: 'include', headers: { Accept: 'application/json' } },
        ))
        all.push(...result.docs)
        lastPage = Math.max(1, result.totalPages ?? 1)
        nextPage += 1
      } while (nextPage <= lastPage)

      if (!current) return
      const activeID = currentFolderIDRef.current
      const activeFolder = all.find((folder) => String(folder.id) === activeID)
      if (activeID && (!activeFolder || !canContainMedia(activeFolder))) changeFolder(null)
      setFolders(all)
      setFolderLoading(false)
      setError('')
    }

    void loadFolders().catch(() => {
      if (!current) return
      setFolderLoading(false)
      setError(copy(isPersian, 'پوشه‌ها بارگذاری نشدند. دوباره تلاش کنید.', 'Folders could not be loaded. Please try again.'))
    })

    return () => { current = false }
  }, [apiRoute, changeFolder, foldersSlug, isPersian, siteID])

  useEffect(() => {
    let current = true
    let pending = true
    const loadingTimer = window.setTimeout(() => {
      if (current && pending) setMediaLoading(true)
    }, 0)

    void refreshMedia(1, queryWhere)
      .catch(() => {
        if (current) setError(copy(isPersian, 'رسانه‌ها بارگذاری نشدند. دوباره تلاش کنید.', 'Media could not be loaded. Please try again.'))
      })
      .finally(() => {
        pending = false
        window.clearTimeout(loadingTimer)
        if (current) setMediaLoading(false)
      })

    return () => {
      current = false
      window.clearTimeout(loadingTimer)
    }
  }, [isPersian, queryWhere, refreshMedia])

  useEffect(() => {
    const missingIDs = selectedIDs.filter((id) => !selectedDocs[id])
    if (!missingIDs.length) return

    let current = true
    const loadSelected = async () => {
      const params = new URLSearchParams({ depth: '0', limit: String(missingIDs.length), page: '1' })
      const idWhere: Where = { and: [{ site: { equals: siteID } }, { id: { in: missingIDs } }] }
      appendQueryValue(params, 'where', idWhere)
      const response = await fetch(`${collectionURL(apiRoute, 'media')}?${params.toString()}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
      const result = await responseDocs<MediaDoc>(response)
      if (current && result.docs.length) {
        setSelectedDocs((docs) => ({
          ...docs,
          ...Object.fromEntries(result.docs.map((doc) => [String(doc.id), doc])),
        }))
      }
    }

    void loadSelected().catch(() => undefined)
    return () => { current = false }
  }, [apiRoute, selectedDocs, selectedIDs, siteID])

  const mediaMatchesType = useCallback((doc: MediaDoc) => {
    if (fileType === 'svg') return doc.mimeType === 'image/svg+xml'
    if (fileType === 'raster') return Boolean(doc.mimeType?.startsWith('image/')) && doc.mimeType !== 'image/svg+xml'
    return true
  }, [fileType])

  const toggleMedia = (doc: MediaDoc) => {
    const id = String(doc.id)
    setSelectedDocs((current) => ({ ...current, [id]: doc }))
    setSelectedIDs((current) => {
      if (current.includes(id)) return current.filter((selected) => selected !== id)
      const max = maxRows && hasMany ? maxRows : Number.POSITIVE_INFINITY
      return current.length >= max ? current : [...current, id]
    })
  }

  const moveSelected = (index: number, direction: -1 | 1) => {
    setSelectedIDs((current) => {
      const target = index + direction
      if (target < 0 || target >= current.length) return current
      const reordered = [...current]
      ;[reordered[index], reordered[target]] = [reordered[target]!, reordered[index]!]
      return reordered
    })
  }

  const selectAllResults = async () => {
    setSelectingAll(true)
    setError('')
    try {
      const all: MediaDoc[] = []
      let nextPage = 1
      let lastPage = 1

      do {
        const result = await responseDocs<MediaDoc>(await fetch(
          queryURL(apiRoute, 'media', queryWhere, nextPage),
          { credentials: 'include', headers: { Accept: 'application/json' } },
        ))
        all.push(...result.docs.filter(mediaMatchesType))
        lastPage = Math.max(1, result.totalPages ?? 1)
        nextPage += 1
      } while (nextPage <= lastPage)

      setSelectedDocs((current) => ({
        ...current,
        ...Object.fromEntries(all.map((doc) => [String(doc.id), doc])),
      }))
      setSelectedIDs((current) => {
        const merged = [...current]
        for (const doc of all) {
          const id = String(doc.id)
          if (!merged.includes(id)) merged.push(id)
        }
        return maxRows && hasMany ? merged.slice(0, maxRows) : merged
      })
    } catch {
      setError(copy(isPersian, 'نتایج برای انتخاب بارگذاری نشدند.', 'Could not load the filtered results for selection.'))
    } finally {
      setSelectingAll(false)
    }
  }

  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length || !uploadAllowed) return
    setUploading(true)
    setError('')

    try {
      const created: MediaDoc[] = []
      const remainingRows = maxRows && hasMany
        ? Math.max(0, maxRows - selectedIDs.length)
        : Number.POSITIVE_INFINITY
      const accepted = Array.from(files).slice(0, hasMany ? remainingRows : 1)
      if (!accepted.length) return

      for (const file of accepted) {
        const formData = new FormData()
        formData.append('_payload', JSON.stringify({
          alt: file.name.replace(/\.[^.]+$/, ''),
          folder: currentFolderID,
          site: siteID,
        }))
        formData.append('file', file, file.name)

        const response = await fetch(collectionURL(apiRoute, 'media'), {
          body: formData,
          credentials: 'include',
          method: 'POST',
        })
        if (!response.ok) throw new Error('Upload failed.')
        const body = await response.json() as { doc?: MediaDoc } & MediaDoc
        const doc = body.doc ?? body
        if (doc.id === undefined) throw new Error('Upload failed.')
        created.push(doc)
      }

      setSelectedDocs((current) => ({
        ...current,
        ...Object.fromEntries(created.map((doc) => [String(doc.id), doc])),
      }))
      setSelectedIDs((current) => {
        const merged = [...current]
        for (const doc of created) {
          const id = String(doc.id)
          if (!merged.includes(id)) merged.push(id)
        }
        return maxRows && hasMany ? merged.slice(0, maxRows) : merged
      })
      await refreshMedia(1)
    } catch {
      setError(copy(isPersian, 'بارگذاری انجام نشد. نوع و اندازهٔ فایل را بررسی کنید.', 'Upload failed. Check the file type and size, then try again.'))
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const selectCurrentPage = () => {
    const currentPageIDs = media.filter(mediaMatchesType).map((doc) => String(doc.id))
    setSelectedDocs((current) => ({
      ...current,
      ...Object.fromEntries(media.filter(mediaMatchesType).map((doc) => [String(doc.id), doc])),
    }))
    setSelectedIDs((current) => {
      const merged = [...current]
      for (const id of currentPageIDs) if (!merged.includes(id)) merged.push(id)
      return maxRows && hasMany ? merged.slice(0, maxRows) : merged
    })
  }

  const selectionLimitReached = Boolean(maxRows && hasMany && selectedIDs.length >= maxRows)
  const visibleMedia = media.filter(mediaMatchesType)

  return (
    <div
      aria-labelledby="tenant-media-picker-title"
      aria-modal="true"
      className="tenant-media-picker__backdrop"
      data-testid="tenant-media-picker"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
      ref={dialogRef}
      role="dialog"
      tabIndex={-1}
    >
      <section className="tenant-media-picker" dir={isPersian ? 'rtl' : 'ltr'}>
        <header className="tenant-media-picker__header">
          <div>
            <h2 id="tenant-media-picker-title">{copy(isPersian, 'انتخاب از کتابخانهٔ رسانه', 'Choose from media library')}</h2>
            <p>{copy(isPersian, 'فقط رسانه‌ها و پوشه‌های همین سایت نمایش داده می‌شوند.', 'Only media and folders for this site are shown.')}</p>
          </div>
          <button aria-label={copy(isPersian, 'بستن', 'Close')} className="tenant-media-picker__close" onClick={onClose} type="button">×</button>
        </header>

        <div className="tenant-media-picker__navigation">
          <button
            className="tenant-media-picker__crumb"
            data-testid="media-folder-root"
            onClick={() => changeFolder(null)}
            type="button"
          >
            {copy(isPersian, 'ریشه', 'Root')}
          </button>
          {folderPath.map((folder) => (
            <React.Fragment key={String(folder.id)}>
              <span aria-hidden="true">/</span>
              <button
                className="tenant-media-picker__crumb"
                onClick={() => changeFolder(String(folder.id))}
                type="button"
              >
                {folder.name}
              </button>
            </React.Fragment>
          ))}
          {activeFolder && (
            <button
              className="tenant-media-picker__back"
              onClick={() => changeFolder(folderPath.length > 1 ? String(folderPath.at(-2)!.id) : null)}
              type="button"
            >
              {copy(isPersian, 'بازگشت به پوشهٔ بالاتر', 'Go to parent folder')}
            </button>
          )}
        </div>

        <div className="tenant-media-picker__filters">
          <label className="tenant-media-picker__search">
            <span>{copy(isPersian, 'جست‌وجو در پوشه', 'Search in folder')}</span>
            <input
              aria-label={copy(isPersian, 'جست‌وجو در پوشه', 'Search in folder')}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={copy(isPersian, 'نام فایل یا متن جایگزین', 'Filename or alt text')}
              type="search"
              value={search}
            />
          </label>
          <label>
            <span>{copy(isPersian, 'نوع فایل', 'File type')}</span>
            <select
              aria-label={copy(isPersian, 'نوع فایل', 'File type')}
              onChange={(event) => { setFileType(event.target.value as typeof fileType); setPage(1) }}
              value={fileType}
            >
              <option value="all">{copy(isPersian, 'همهٔ تصاویر', 'All images')}</option>
              <option value="raster">{copy(isPersian, 'تصاویر معمولی', 'Raster images')}</option>
              <option value="svg">SVG</option>
            </select>
          </label>
          <label className="tenant-media-picker__all-folders">
            <input
              checked={searchAllFolders}
              onChange={(event) => { setSearchAllFolders(event.target.checked); setPage(1) }}
              type="checkbox"
            />
            <span>{copy(isPersian, 'جست‌وجو در همهٔ پوشه‌ها', 'Search all folders')}</span>
          </label>
          <div className="tenant-media-picker__target">
            {copy(isPersian, 'محل بارگذاری:', 'Upload destination:')}{' '}
            {folderPath.length ? folderPath.map((folder) => folder.name).join(' / ') : copy(isPersian, 'ریشه', 'Root')}
          </div>
        </div>

        {uploadAllowed && (
          <div className="tenant-media-picker__upload">
            <input
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml"
              aria-label={copy(isPersian, 'بارگذاری در این پوشه', 'Upload into this folder')}
              multiple={hasMany}
              onChange={(event) => void uploadFiles(event.target.files)}
              ref={fileInputRef}
              type="file"
            />
            <button
              disabled={uploading || selectionLimitReached}
              onClick={() => fileInputRef.current?.click()}
              type="button"
            >
              {uploading
                ? copy(isPersian, 'در حال بارگذاری…', 'Uploading…')
                : copy(isPersian, 'بارگذاری در این پوشه', 'Upload into this folder')}
            </button>
          </div>
        )}

        <div aria-live="polite" className="tenant-media-picker__status">
          {folderLoading && copy(isPersian, 'در حال بارگذاری پوشه‌ها…', 'Loading folders…')}
          {mediaLoading && copy(isPersian, 'در حال بارگذاری رسانه‌ها…', 'Loading media…')}
          {error && <span role="alert">{error}</span>}
        </div>

        <div className="tenant-media-picker__bulk-actions">
          {hasMany && (
            <>
              <button disabled={selectingAll || selectionLimitReached} onClick={() => void selectAllResults()} type="button">
                {selectingAll
                  ? copy(isPersian, 'در حال انتخاب…', 'Selecting…')
                  : copy(isPersian, 'انتخاب همهٔ نتایج فیلترشده', 'Select all filtered results')}
              </button>
              <button disabled={!visibleMedia.length} onClick={selectCurrentPage} type="button">
                {copy(isPersian, 'انتخاب موارد این صفحه', 'Select this page')}
              </button>
              <button disabled={!selectedIDs.length} onClick={() => setSelectedIDs([])} type="button">
                {copy(isPersian, 'پاک کردن انتخاب', 'Clear selection')}
              </button>
            </>
          )}
          <span data-testid="media-selected-count">
            {copy(isPersian, `${selectedIDs.length} مورد انتخاب شده`, `${selectedIDs.length} selected`)}
          </span>
        </div>

        {folderLoading ? null : (
          <div aria-label={copy(isPersian, 'پوشه‌ها', 'Folders')} className="tenant-media-picker__folders" role="group">
            {visibleFolders.map((folder) => (
              <button
                aria-label={copy(isPersian, `باز کردن پوشهٔ ${folder.name}`, `Open folder ${folder.name}`)}
                className="tenant-media-picker__folder"
                data-testid={`media-folder-${String(folder.id)}`}
                key={String(folder.id)}
                onClick={() => changeFolder(String(folder.id))}
                type="button"
              >
                <span aria-hidden="true">📁</span>
                <span>{folder.name}</span>
              </button>
            ))}
          </div>
        )}

        <div aria-label={copy(isPersian, 'رسانه‌ها', 'Media')} className="tenant-media-picker__grid" role="group">
          {visibleMedia.map((doc) => {
            const id = String(doc.id)
            const selected = selectedIDs.includes(id)
            const thumbnail = doc.sizes?.thumbnail?.url || doc.url || ''
            const title = doc.alt || doc.filename || id
            const cannotAdd = !selected && selectionLimitReached

            return hasMany ? (
              <label
                aria-label={title}
                className={`tenant-media-picker__card${selected ? ' is-selected' : ''}${cannotAdd ? ' is-disabled' : ''}`}
                data-testid={`media-item-${id}`}
                key={id}
              >
                <input
                  checked={selected}
                  disabled={cannotAdd}
                  onChange={() => toggleMedia(doc)}
                  type="checkbox"
                />
                {thumbnail ? <img alt="" loading="lazy" src={thumbnail} /> : <span aria-hidden="true">▧</span>}
                <span className="tenant-media-picker__filename">{doc.filename || title}</span>
                {selected && <span className="tenant-media-picker__selected-mark">✓ {copy(isPersian, 'انتخاب‌شده', 'Selected')}</span>}
              </label>
            ) : (
              <button
                aria-label={copy(isPersian, `انتخاب ${title}`, `Select ${title}`)}
                aria-pressed={selected}
                className={`tenant-media-picker__card${selected ? ' is-selected' : ''}`}
                data-testid={`media-item-${id}`}
                key={id}
                onClick={() => onInsert([id])}
                type="button"
              >
                {thumbnail ? <img alt="" loading="lazy" src={thumbnail} /> : <span aria-hidden="true">▧</span>}
                <span className="tenant-media-picker__filename">{doc.filename || title}</span>
              </button>
            )
          })}
        </div>

        {!mediaLoading && !visibleMedia.length && !error && (
          <p className="tenant-media-picker__empty">
            {copy(isPersian, 'در این پوشه رسانه‌ای پیدا نشد.', 'No media found in this folder.')}
          </p>
        )}

        {page < totalPages && (
          <button
            className="tenant-media-picker__load-more"
            disabled={mediaLoading}
            onClick={() => {
              setMediaLoading(true)
              void refreshMedia(page + 1, queryWhere, true).catch(() => setError(copy(isPersian, 'رسانه‌ها بارگذاری نشدند.', 'Media could not be loaded.')))
                .finally(() => setMediaLoading(false))
            }}
            type="button"
          >
            {copy(isPersian, 'بارگذاری موارد بیشتر', 'Load more')}
          </button>
        )}

        {hasMany && (
          <aside aria-label={copy(isPersian, 'موارد انتخاب‌شده', 'Selected items')} className="tenant-media-picker__tray">
            <h3>{copy(isPersian, `انتخاب‌شده‌ها (${selectedIDs.length})`, `Selected items (${selectedIDs.length})`)}</h3>
            {selectedIDs.length > 0 && (
              <ol>
                {selectedIDs.map((id, index) => {
                  const doc = selectedDocs[id]
                  const title = doc?.filename || doc?.alt || copy(isPersian, 'رسانه', 'Media item')
                  return (
                    <li key={`${id}-${index}`}>
                      <span>{title}</span>
                      <button
                        aria-label={copy(isPersian, `${title} را جلوتر ببر`, `Move ${title} earlier`)}
                        disabled={index === 0}
                        onClick={() => moveSelected(index, -1)}
                        type="button"
                      >↑</button>
                      <button
                        aria-label={copy(isPersian, `${title} را عقب‌تر ببر`, `Move ${title} later`)}
                        disabled={index === selectedIDs.length - 1}
                        onClick={() => moveSelected(index, 1)}
                        type="button"
                      >↓</button>
                      <button
                        aria-label={copy(isPersian, `${title} را بردار`, `Remove ${title}`)}
                        onClick={() => setSelectedIDs((current) => current.filter((item) => item !== id))}
                        type="button"
                      >×</button>
                    </li>
                  )
                })}
              </ol>
            )}
          </aside>
        )}

        <footer className="tenant-media-picker__footer">
          <button onClick={onClose} type="button">{copy(isPersian, 'لغو', 'Cancel')}</button>
          {hasMany && (
            <button
              data-testid="media-picker-insert"
              disabled={!selectedIDs.length}
              onClick={() => onInsert(selectedIDs)}
              type="button"
            >
              {copy(isPersian, `افزودن ${selectedIDs.length} رسانه`, `Insert ${selectedIDs.length} media item${selectedIDs.length === 1 ? '' : 's'}`)}
            </button>
          )}
        </footer>
      </section>
    </div>
  )
}

const TenantMediaUploadFieldComponent = (props: UploadFieldClientProps) => {
  const { field, path: pathFromProps, readOnly } = props
  const {
    customComponents: { AfterInput, BeforeInput, Description, Error, Label } = {},
    disabled,
    filterOptions,
    path,
    setValue,
    showError,
    value,
  } = useField({ potentiallyStalePath: pathFromProps })
  const { config } = useConfig()
  const { code } = useLocale()
  const { permissions } = useAuth()
  const documentForm = useDocumentForm()
  const siteID = relationID(documentForm.getDataByPath('site'))
  const [pickerOpen, setPickerOpen] = useState(false)
  const [folderContextID, setFolderContextID] = useState<string | null>(null)
  const openButtonRef = useRef<HTMLButtonElement>(null)
  const hasMany = field.hasMany === true
  const maxRows = field.maxRows
  const uploadAllowed =
    !readOnly && !disabled && field.admin?.allowCreate !== false && Boolean(permissions?.collections?.media?.create)
  const isPersian = code.toLowerCase().startsWith('fa')
  const apiRoute = config.routes.api
  const foldersConfig = config.folders === false ? undefined : config.folders
  const foldersField = foldersConfig?.fieldName || 'folder'
  const foldersSlug = foldersConfig?.slug || 'payload-folders'
  const currentIDs = useMemo(() => {
    const values = Array.isArray(value) ? value : value === null || value === undefined || value === '' ? [] : [value]
    return values.map(relationID).filter((id): id is string => Boolean(id))
  }, [value])
  const inputValue: UploadInputProps['value'] = hasMany
    ? currentIDs.map((id) => ({ relationTo: 'media' as const, value: id }))
    : value as UploadInputProps['value']

  const insertSelection = useCallback((ids: string[]) => {
    const unique = [...new Set(ids)]
    const capped = maxRows && hasMany ? unique.slice(0, maxRows) : unique
    setValue(hasMany ? capped : capped[0] ?? null)
    setPickerOpen(false)
    window.requestAnimationFrame(() => openButtonRef.current?.focus())
  }, [hasMany, maxRows, setValue])

  const mediaFilterOptions =
    filterOptions && typeof filterOptions === 'object' && 'media' in filterOptions
      ? (filterOptions as Record<string, unknown>).media
      : undefined
  const mediaFilterRequiresServer =
    typeof filterOptions === 'function' || typeof mediaFilterOptions === 'function'
  const pickerAvailable = Boolean(siteID) && mediaFilterOptions !== false && !mediaFilterRequiresServer

  return (
    <BulkUploadProvider drawerSlugPrefix={pathFromProps}>
      <div className="tenant-media-upload">
        <UploadInput
          AfterInput={AfterInput}
          allowCreate={false}
          api={apiRoute}
          BeforeInput={BeforeInput}
          className="tenant-media-upload__native"
          Description={Description}
          description={field.admin?.description}
          displayPreview={field.displayPreview}
          Error={Error}
          filterOptions={filterOptions}
          hasMany={hasMany}
          isSortable={field.admin?.isSortable}
          label={field.label}
          Label={Label}
          localized={field.localized}
          maxRows={maxRows}
          onChange={setValue}
          path={path}
          readOnly={readOnly || disabled}
          relationTo={field.relationTo}
          required={field.required}
          serverURL={config.serverURL}
          showError={showError}
          value={inputValue}
        />
        <div className="tenant-media-upload__actions">
          <button
            aria-haspopup="dialog"
            className="tenant-media-upload__browse"
            data-testid="open-tenant-media-picker"
            disabled={readOnly || disabled || !pickerAvailable}
            onClick={() => setPickerOpen(true)}
            ref={openButtonRef}
            type="button"
          >
            {copy(isPersian, 'انتخاب رسانه از پوشه‌ها', 'Browse media by folder')}
          </button>
          {!siteID && (
            <span className="tenant-media-upload__hint">
              {copy(isPersian, 'ابتدا سایت این محتوا را انتخاب کنید.', 'Select this document’s site before choosing media.')}
            </span>
          )}
          {siteID && mediaFilterRequiresServer && (
            <span className="tenant-media-upload__hint">
              {copy(isPersian, 'فیلتر این فیلد در انتخابگر رسانه پشتیبانی نمی‌شود.', 'This field’s dynamic media filter cannot be applied by the folder picker.')}
            </span>
          )}
        </div>
        {pickerOpen && siteID && (
          <PickerDialog
            key={siteID}
            apiRoute={apiRoute}
            foldersField={foldersField}
            foldersSlug={foldersSlug}
            hasMany={hasMany}
            initialFolderID={folderContextID}
            initialIDs={currentIDs}
            isPersian={isPersian}
            locale={code}
            mediaFilter={mediaFilterOptions}
            onFolderChange={setFolderContextID}
            maxRows={maxRows}
            onClose={() => {
              setPickerOpen(false)
              window.requestAnimationFrame(() => openButtonRef.current?.focus())
            }}
            onInsert={insertSelection}
            siteID={siteID}
            uploadAllowed={uploadAllowed}
          />
        )}
      </div>
    </BulkUploadProvider>
  )
}

export const TenantMediaUploadField = TenantMediaUploadFieldComponent
