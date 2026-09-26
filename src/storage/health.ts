import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'

import { normaliseStorageError, type StorageErrorCategory } from './errors'
import type { StorageConnection } from './types'

export type StorageHealthStatus =
  | 'degraded'
  | 'disabled'
  | 'failed'
  | 'healthy'
  | 'retest_required'
  | 'testing'
  | 'unknown'

export type StorageHealthStepKey =
  | 'authentication'
  | 'bucket'
  | 'cleanup'
  | 'delete'
  | 'endpoint'
  | 'read'
  | 'tls'
  | 'write'

export type StorageHealthStep = {
  detail?: string
  key: StorageHealthStepKey
  label: string
  ok: boolean
}

export type StorageTestMode = 'full' | 'quick'

export type StorageTestResult = {
  authenticationOk: boolean
  bucketAccessible: boolean
  deleteAccessOk: boolean
  endpointReachable: boolean
  errorCategory?: StorageErrorCategory
  errorCode?: string
  errorMessage?: string
  healthStatus: StorageHealthStatus
  latencyMs: number
  mode: StorageTestMode
  ok: boolean
  readAccessOk: boolean
  steps: StorageHealthStep[]
  writeAccessOk: boolean
}

const testTimeoutMs = (): number => Number(process.env.STORAGE_TEST_TIMEOUT_MS ?? 15_000)

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Timeout'), { name: 'TimeoutError' })), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const diagnosticKey = (): string => `_system/health-check/${randomUUID()}`

const step = (
  key: StorageHealthStepKey,
  label: string,
  ok: boolean,
  detail?: string,
): StorageHealthStep => ({ detail, key, label, ok })

export const buildStorageClient = (connection: StorageConnection): S3Client =>
  new S3Client({
    credentials: {
      accessKeyId: connection.accessKeyId,
      secretAccessKey: connection.secretAccessKey,
    },
    endpoint: connection.endpoint,
    forcePathStyle: connection.forcePathStyle,
    maxAttempts: 2,
    region: connection.region || 'default',
  })

/** Read-only bucket reachability check (HeadBucket). */
export const runQuickStorageTest = async (
  connection: StorageConnection,
  client: S3Client = buildStorageClient(connection),
): Promise<StorageTestResult> => {
  const started = Date.now()
  const steps: StorageHealthStep[] = []

  steps.push(step('endpoint', 'Endpoint در دسترس', true))
  steps.push(step('tls', 'TLS / transport', true))

  try {
    await withTimeout(
      client.send(new HeadBucketCommand({ Bucket: connection.bucket })),
      testTimeoutMs(),
    )
    steps.push(step('authentication', 'اعتبارنامه معتبر', true))
    steps.push(step('bucket', 'باکت در دسترس', true))
  } catch (error) {
    const normalised = normaliseStorageError(error)
    steps.push(
      step(
        normalised.category === 'AUTHENTICATION' ? 'authentication' : 'bucket',
        normalised.category === 'AUTHENTICATION' ? 'اعتبارنامه معتبر' : 'باکت در دسترس',
        false,
        normalised.operatorMessage,
      ),
    )
    return {
      authenticationOk: normalised.category !== 'AUTHENTICATION',
      bucketAccessible: false,
      deleteAccessOk: false,
      endpointReachable: normalised.category !== 'NETWORK',
      errorCategory: normalised.category,
      errorCode: normalised.code,
      errorMessage: normalised.operatorMessage,
      healthStatus: 'failed',
      latencyMs: Date.now() - started,
      mode: 'quick',
      ok: false,
      readAccessOk: false,
      steps,
      writeAccessOk: false,
    }
  }

  const latencyMs = Date.now() - started
  return {
    authenticationOk: true,
    bucketAccessible: true,
    deleteAccessOk: false,
    endpointReachable: true,
    healthStatus: 'healthy',
    latencyMs,
    mode: 'quick',
    ok: true,
    readAccessOk: false,
    steps,
    writeAccessOk: false,
  }
}

/** Put → Head → Get (byte check) → Delete under `_system/health-check/`. */
export const runFullStorageTest = async (
  connection: StorageConnection,
  client: S3Client = buildStorageClient(connection),
): Promise<StorageTestResult> => {
  const quick = await runQuickStorageTest(connection, client)
  if (!quick.ok) return { ...quick, mode: 'full' }

  const started = Date.now()
  const steps = [...quick.steps]
  const key = diagnosticKey()
  const payload = Buffer.from(`eshobe-storage-health:${randomUUID()}`, 'utf8')

  let writeAccessOk = false
  let readAccessOk = false
  let deleteAccessOk = false

  try {
    await withTimeout(
      client.send(
        new PutObjectCommand({
          Body: payload,
          Bucket: connection.bucket,
          ContentType: 'application/octet-stream',
          Key: key,
        }),
      ),
      testTimeoutMs(),
    )
    writeAccessOk = true
    steps.push(step('write', 'مجوز نوشتن (PutObject)', true))
  } catch (error) {
    const normalised = normaliseStorageError(error)
    steps.push(step('write', 'مجوز نوشتن (PutObject)', false, normalised.operatorMessage))
    return finishFull(steps, started, {
      ...quick,
      deleteAccessOk: false,
      errorCategory: normalised.category === 'PERMISSION' ? 'WRITE_FAILED' : normalised.category,
      errorCode: normalised.code,
      errorMessage: normalised.operatorMessage,
      readAccessOk: false,
      writeAccessOk: false,
    })
  }

  try {
    await withTimeout(
      client.send(new HeadObjectCommand({ Bucket: connection.bucket, Key: key })),
      testTimeoutMs(),
    )
  } catch (error) {
    const normalised = normaliseStorageError(error)
    steps.push(step('read', 'خواندن و تطبیق بایت‌ها', false, normalised.operatorMessage))
    await tryDelete(client, connection.bucket, key)
    return finishFull(steps, started, {
      ...quick,
      deleteAccessOk: false,
      errorCategory: 'READ_FAILED',
      errorCode: normalised.code,
      errorMessage: normalised.operatorMessage,
      readAccessOk: false,
      writeAccessOk,
    })
  }

  try {
    const object = await withTimeout(
      client.send(new GetObjectCommand({ Bucket: connection.bucket, Key: key })),
      testTimeoutMs(),
    )
    const bytes = await bodyToBuffer(object.Body)
    if (!bytes.equals(payload)) {
      steps.push(step('read', 'خواندن و تطبیق بایت‌ها', false, 'محتوای برگشتی با payload مطابقت ندارد.'))
      await tryDelete(client, connection.bucket, key)
      return finishFull(steps, started, {
        ...quick,
        deleteAccessOk: false,
        errorCategory: 'READ_FAILED',
        errorCode: 'ByteMismatch',
        errorMessage: 'خواندن شیء ناموفق بود: محتوا مطابقت ندارد.',
        readAccessOk: false,
        writeAccessOk,
      })
    }
    readAccessOk = true
    steps.push(step('read', 'خواندن و تطبیق بایت‌ها', true))
  } catch (error) {
    const normalised = normaliseStorageError(error)
    steps.push(step('read', 'خواندن و تطبیق بایت‌ها', false, normalised.operatorMessage))
    await tryDelete(client, connection.bucket, key)
    return finishFull(steps, started, {
      ...quick,
      deleteAccessOk: false,
      errorCategory: 'READ_FAILED',
      errorCode: normalised.code,
      errorMessage: normalised.operatorMessage,
      readAccessOk: false,
      writeAccessOk,
    })
  }

  try {
    await withTimeout(
      client.send(new DeleteObjectCommand({ Bucket: connection.bucket, Key: key })),
      testTimeoutMs(),
    )
    deleteAccessOk = true
    steps.push(step('delete', 'مجوز حذف (DeleteObject)', true))
    steps.push(step('cleanup', 'پاک‌سازی شیء آزمایشی', true))
  } catch (error) {
    const normalised = normaliseStorageError(error)
    steps.push(step('delete', 'مجوز حذف (DeleteObject)', false, normalised.operatorMessage))
    steps.push(step('cleanup', 'پاک‌سازی شیء آزمایشی', false, 'شیء آزمایشی ممکن است در باکت باقی مانده باشد.'))
    return finishFull(steps, started, {
      ...quick,
      deleteAccessOk: false,
      errorCategory: 'DELETE_FAILED',
      errorCode: normalised.code,
      errorMessage: normalised.operatorMessage,
      readAccessOk,
      writeAccessOk,
    })
  }

  return {
    ...quick,
    deleteAccessOk,
    healthStatus: 'healthy',
    latencyMs: Date.now() - started,
    mode: 'full',
    ok: true,
    readAccessOk,
    steps,
    writeAccessOk,
  }
}

const finishFull = (
  steps: StorageHealthStep[],
  started: number,
  base: Omit<StorageTestResult, 'latencyMs' | 'mode' | 'ok' | 'steps' | 'healthStatus'> & {
    errorCategory?: StorageErrorCategory
    errorCode?: string
    errorMessage?: string
  },
): StorageTestResult => ({
  ...base,
  healthStatus: 'failed',
  latencyMs: Date.now() - started,
  mode: 'full',
  ok: false,
  steps,
})

const tryDelete = async (client: S3Client, bucket: string, key: string): Promise<void> => {
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } catch {
    // Best-effort; the caller already records cleanup failure.
  }
}

const bodyToBuffer = async (body: unknown): Promise<Buffer> => {
  if (!body) return Buffer.alloc(0)
  if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === 'function') {
    return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray())
  }
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Buffer | Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

/** Map a persisted row into a coarse health status for lists and overview. */
export const deriveHealthStatus = (row: {
  enabled?: boolean | null
  healthStatus?: string | null
  lastSelfTestOk?: boolean | null
}): StorageHealthStatus => {
  if (row.enabled === false) return 'disabled'
  if (row.healthStatus === 'retest_required') return 'retest_required'
  if (row.healthStatus === 'testing') return 'testing'
  if (row.healthStatus === 'degraded') return 'degraded'
  if (row.healthStatus === 'failed') return 'failed'
  if (row.healthStatus === 'healthy') return 'healthy'
  if (row.lastSelfTestOk === true) return 'healthy'
  if (row.lastSelfTestOk === false) return 'failed'
  return 'unknown'
}
