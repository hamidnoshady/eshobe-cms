'use client'

import type { UploadFieldClientProps } from 'payload'

import type { UploadInputProps } from '@payloadcms/ui'
import {
  Banner,
  BulkUploadProvider,
  Button,
  CheckboxInput,
  Drawer,
  SelectInput,
  TextInput,
  UploadInput,
  useAuth,
  useConfig,
  useDocumentForm,
  useDrawerSlug,
  useField,
  useLocale,
  useModal,
} from '@payloadcms/ui'
import { formatAdminURL } from 'payload/shared'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { formatNumber } from '@/lib/format'

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

  const fileTypeOptions = [
    { label: copy(isPersian, 'همهٔ تصاویر', 'All images'), value: 'all' },
    { label: copy(isPersian, 'تصاویر معمولی', 'Raster images'), value: 'raster' },
    { label: 'SVG', value: 'svg' },
  ]

  /**
   * The body of a Payload `Drawer`: the drawer supplies the overlay, header, close button,
   * focus trap and Escape handling, so this renders only content — built from Payload's
   * own `Button`, `TextInput`, `SelectInput`, `CheckboxInput` and `Banner` so it reads
   * like the list drawer Payload opens for «انتخاب از موجود».
   */
  return (
    <div className="tenant-media-picker" data-testid="tenant-media-picker" dir={isPersian ? 'rtl' : 'ltr'}>
      <p className="tenant-media-picker__intro">
        {copy(isPersian, 'فقط رسانه‌ها و پوشه‌های همین سایت نمایش داده می‌شوند.', 'Only media and folders for this site are shown.')}
      </p>

      <nav aria-label={copy(isPersian, 'مسیر پوشه', 'Folder path')} className="tenant-media-picker__navigation">
        <Button
          buttonStyle={activeFolder ? 'subtle' : 'pill'}
          extraButtonProps={{ 'data-testid': 'media-folder-root' }}
          margin={false}
          onClick={() => changeFolder(null)}
          size="small"
        >
          {copy(isPersian, 'ریشه', 'Root')}
        </Button>
        {folderPath.map((folder, index) => (
          <React.Fragment key={String(folder.id)}>
            <span aria-hidden="true" className="tenant-media-picker__separator">/</span>
            <Button
              buttonStyle={index === folderPath.length - 1 ? 'pill' : 'subtle'}
              margin={false}
              onClick={() => changeFolder(String(folder.id))}
              size="small"
            >
              {folder.name}
            </Button>
          </React.Fragment>
        ))}
        {activeFolder && (
          <Button
            buttonStyle="transparent"
            className="tenant-media-picker__back"
            margin={false}
            onClick={() => changeFolder(folderPath.length > 1 ? String(folderPath.at(-2)!.id) : null)}
            size="small"
          >
            {copy(isPersian, 'بازگشت به پوشهٔ بالاتر', 'Go to parent folder')}
          </Button>
        )}
      </nav>

      <div className="tenant-media-picker__filters">
        <TextInput
          className="tenant-media-picker__search"
          label={copy(isPersian, 'جست‌وجو در پوشه', 'Search in folder')}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setSearch(event.target.value)}
          path="tenant-media-picker-search"
          placeholder={copy(isPersian, 'نام فایل یا متن جایگزین', 'Filename or alt text')}
          value={search}
        />
        <SelectInput
          className="tenant-media-picker__type"
          isClearable={false}
          label={copy(isPersian, 'نوع فایل', 'File type')}
          name="tenant-media-picker-type"
          onChange={(option) => {
            const value = (option as { value?: string } | null)?.value
            setFileType((value === 'raster' || value === 'svg' ? value : 'all') as typeof fileType)
            setPage(1)
          }}
          options={fileTypeOptions}
          path="tenant-media-picker-type"
          value={fileType}
        />
        <CheckboxInput
          checked={searchAllFolders}
          className="tenant-media-picker__all-folders"
          id="tenant-media-picker-all-folders"
          label={copy(isPersian, 'جست‌وجو در همهٔ پوشه‌ها', 'Search all folders')}
          onToggle={(event) => { setSearchAllFolders(event.target.checked); setPage(1) }}
        />
      </div>

      <div className="tenant-media-picker__toolbar">
        <span className="tenant-media-picker__target">
          {copy(isPersian, 'محل بارگذاری:', 'Upload destination:')}{' '}
          <strong>{folderPath.length ? folderPath.map((folder) => folder.name).join(' / ') : copy(isPersian, 'ریشه', 'Root')}</strong>
        </span>
        {uploadAllowed && (
          <>
            <input
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif,image/svg+xml"
              aria-label={copy(isPersian, 'بارگذاری در این پوشه', 'Upload into this folder')}
              className="tenant-media-picker__file"
              multiple={hasMany}
              onChange={(event) => void uploadFiles(event.target.files)}
              ref={fileInputRef}
              type="file"
            />
            <Button
              buttonStyle="secondary"
              disabled={uploading || selectionLimitReached}
              icon="plus"
              iconPosition="left"
              margin={false}
              onClick={() => fileInputRef.current?.click()}
              size="small"
            >
              {uploading
                ? copy(isPersian, 'در حال بارگذاری…', 'Uploading…')
                : copy(isPersian, 'بارگذاری در این پوشه', 'Upload into this folder')}
            </Button>
          </>
        )}
      </div>

      <div aria-live="polite" className="tenant-media-picker__status">
        {folderLoading && copy(isPersian, 'در حال بارگذاری پوشه‌ها…', 'Loading folders…')}
        {mediaLoading && copy(isPersian, 'در حال بارگذاری رسانه‌ها…', 'Loading media…')}
      </div>
      {error && (
        <Banner type="error">
          <span role="alert">{error}</span>
        </Banner>
      )}

      {hasMany && (
        <div className="tenant-media-picker__bulk-actions">
          <Button
            buttonStyle="subtle"
            disabled={selectingAll || selectionLimitReached}
            margin={false}
            onClick={() => void selectAllResults()}
            size="small"
          >
            {selectingAll
              ? copy(isPersian, 'در حال انتخاب…', 'Selecting…')
              : copy(isPersian, 'انتخاب همهٔ نتایج فیلترشده', 'Select all filtered results')}
          </Button>
          <Button buttonStyle="subtle" disabled={!visibleMedia.length} margin={false} onClick={selectCurrentPage} size="small">
            {copy(isPersian, 'انتخاب موارد این صفحه', 'Select this page')}
          </Button>
          <Button buttonStyle="subtle" disabled={!selectedIDs.length} margin={false} onClick={() => setSelectedIDs([])} size="small">
            {copy(isPersian, 'پاک کردن انتخاب', 'Clear selection')}
          </Button>
          <span className="tenant-media-picker__count" data-testid="media-selected-count">
            {copy(isPersian, `${formatNumber(selectedIDs.length, 'fa')} مورد انتخاب شده`, `${selectedIDs.length} selected`)}
          </span>
        </div>
      )}

      {!folderLoading && visibleFolders.length > 0 && (
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
              <svg aria-hidden="true" className="tenant-media-picker__folder-icon" viewBox="0 0 20 20">
                <path d="M2.5 5.5a1 1 0 0 1 1-1h4l1.5 1.75h7.5a1 1 0 0 1 1 1v7.25a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z" />
              </svg>
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
          const preview = (
            <span className="tenant-media-picker__thumb">
              {thumbnail ? <img alt="" loading="lazy" src={thumbnail} /> : <span aria-hidden="true">▧</span>}
            </span>
          )

          return hasMany ? (
            <label
              aria-label={title}
              className={`tenant-media-picker__card${selected ? ' is-selected' : ''}${cannotAdd ? ' is-disabled' : ''}`}
              data-testid={`media-item-${id}`}
              key={id}
            >
              <input
                checked={selected}
                className="tenant-media-picker__check"
                disabled={cannotAdd}
                onChange={() => toggleMedia(doc)}
                type="checkbox"
              />
              {preview}
              <span className="tenant-media-picker__filename">{doc.filename || title}</span>
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
              {preview}
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
        <div className="tenant-media-picker__more">
          <Button
            buttonStyle="secondary"
            disabled={mediaLoading}
            margin={false}
            onClick={() => {
              setMediaLoading(true)
              void refreshMedia(page + 1, queryWhere, true).catch(() => setError(copy(isPersian, 'رسانه‌ها بارگذاری نشدند.', 'Media could not be loaded.')))
                .finally(() => setMediaLoading(false))
            }}
            size="small"
          >
            {copy(isPersian, 'بارگذاری موارد بیشتر', 'Load more')}
          </Button>
        </div>
      )}

      {hasMany && selectedIDs.length > 0 && (
        <aside aria-label={copy(isPersian, 'موارد انتخاب‌شده', 'Selected items')} className="tenant-media-picker__tray">
          <h4>{copy(isPersian, 'ترتیب موارد انتخاب‌شده', 'Order of selected items')}</h4>
          <ol>
            {selectedIDs.map((id, index) => {
              const doc = selectedDocs[id]
              const title = doc?.filename || doc?.alt || copy(isPersian, 'رسانه', 'Media item')
              return (
                <li key={`${id}-${index}`}>
                  <span className="tenant-media-picker__tray-title">{title}</span>
                  <Button
                    aria-label={copy(isPersian, `${title} را جلوتر ببر`, `Move ${title} earlier`)}
                    buttonStyle="icon-label"
                    disabled={index === 0}
                    margin={false}
                    onClick={() => moveSelected(index, -1)}
                    size="xsmall"
                  >↑</Button>
                  <Button
                    aria-label={copy(isPersian, `${title} را عقب‌تر ببر`, `Move ${title} later`)}
                    buttonStyle="icon-label"
                    disabled={index === selectedIDs.length - 1}
                    margin={false}
                    onClick={() => moveSelected(index, 1)}
                    size="xsmall"
                  >↓</Button>
                  <Button
                    aria-label={copy(isPersian, `${title} را بردار`, `Remove ${title}`)}
                    buttonStyle="icon-label"
                    icon="x"
                    margin={false}
                    onClick={() => setSelectedIDs((current) => current.filter((item) => item !== id))}
                    size="xsmall"
                  />
                </li>
              )
            })}
          </ol>
        </aside>
      )}

      <footer className="tenant-media-picker__footer">
        <Button buttonStyle="secondary" margin={false} onClick={onClose} size="medium">
          {copy(isPersian, 'لغو', 'Cancel')}
        </Button>
        {hasMany && (
          <Button
            buttonStyle="primary"
            extraButtonProps={{ 'data-testid': 'media-picker-insert' }}
            disabled={!selectedIDs.length}
            margin={false}
            onClick={() => onInsert(selectedIDs)}
            size="medium"
          >
            {copy(
              isPersian,
              `افزودن ${formatNumber(selectedIDs.length, 'fa')} رسانه`,
              `Insert ${selectedIDs.length} media item${selectedIDs.length === 1 ? '' : 's'}`,
            )}
          </Button>
        )}
      </footer>
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
  const drawerSlug = useDrawerSlug(`tenant-media-${pathFromProps}`)
  const { closeModal, isModalOpen, openModal } = useModal()
  const pickerOpen = isModalOpen(drawerSlug)
  const [folderContextID, setFolderContextID] = useState<string | null>(null)
  const openButtonRef = useRef<HTMLAnchorElement | HTMLButtonElement>(null)
  const wasOpen = useRef(false)

  // Escape, the drawer's own close button and an insert all close the modal; whichever
  // it was, focus goes back to the control that opened it.
  useEffect(() => {
    if (wasOpen.current && !pickerOpen) {
      window.requestAnimationFrame(() => openButtonRef.current?.focus())
    }
    wasOpen.current = pickerOpen
  }, [pickerOpen])
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
    closeModal(drawerSlug)
  }, [closeModal, drawerSlug, hasMany, maxRows, setValue])

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
          <Button
            buttonStyle="pill"
            className="tenant-media-upload__browse"
            extraButtonProps={{ 'aria-haspopup': 'dialog', 'data-testid': 'open-tenant-media-picker' }}
            disabled={readOnly || disabled || !pickerAvailable}
            margin={false}
            onClick={() => openModal(drawerSlug)}
            ref={openButtonRef}
            size="small"
          >
            {copy(isPersian, 'انتخاب از کتابخانهٔ رسانه', 'Choose from media library')}
          </Button>
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
        <Drawer
          className="tenant-media-drawer"
          slug={drawerSlug}
          title={copy(isPersian, 'انتخاب از کتابخانهٔ رسانه', 'Choose from media library')}
        >
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
              onClose={() => closeModal(drawerSlug)}
              onInsert={insertSelection}
              siteID={siteID}
              uploadAllowed={uploadAllowed}
            />
          )}
        </Drawer>
      </div>
    </BulkUploadProvider>
  )
}

export const TenantMediaUploadField = TenantMediaUploadFieldComponent
