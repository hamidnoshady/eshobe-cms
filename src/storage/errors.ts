/** Normalised failure categories for operator-facing storage diagnostics. */
export type StorageErrorCategory =
  | 'AUTHENTICATION'
  | 'BUCKET_NOT_FOUND'
  | 'CONFIGURATION'
  | 'DELETE_FAILED'
  | 'NETWORK'
  | 'PERMISSION'
  | 'PROVIDER'
  | 'READ_FAILED'
  | 'TIMEOUT'
  | 'TLS'
  | 'UNKNOWN'
  | 'WRITE_FAILED'

export type NormalisedStorageError = {
  category: StorageErrorCategory
  code: string
  message: string
  operatorMessage: string
}

const nameOf = (error: unknown): string =>
  error && typeof error === 'object' && 'name' in error ? String((error as { name: unknown }).name) : ''

const codeOf = (error: unknown): string => {
  if (error && typeof error === 'object') {
    if ('Code' in error && typeof (error as { Code: unknown }).Code === 'string') {
      return (error as { Code: string }).Code
    }
    if ('code' in error && typeof (error as { code: unknown }).code === 'string') {
      return (error as { code: string }).code
    }
  }
  return nameOf(error) || 'UnknownError'
}

export const normaliseStorageError = (error: unknown): NormalisedStorageError => {
  const code = codeOf(error)
  const rawMessage =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'خطای ناشناخته'

  const lower = `${code} ${rawMessage}`.toLowerCase()

  if (code === 'TimeoutError' || lower.includes('timeout')) {
    return {
      category: 'TIMEOUT',
      code,
      message: rawMessage,
      operatorMessage: 'مهلت اتصال به پایان رسید. endpoint و شبکه را بررسی کنید.',
    }
  }

  if (lower.includes('certificate') || lower.includes('tls') || lower.includes('ssl')) {
    return {
      category: 'TLS',
      code,
      message: rawMessage,
      operatorMessage: 'گواهی TLS معتبر نیست یا زنجیرهٔ اعتماد برقرار نشد.',
    }
  }

  if (
    code === 'InvalidAccessKeyId' ||
    code === 'SignatureDoesNotMatch' ||
    code === 'InvalidClientTokenId' ||
    lower.includes('access key')
  ) {
    return {
      category: 'AUTHENTICATION',
      code,
      message: rawMessage,
      operatorMessage: 'احراز هویت ناموفق بود. Access Key و Secret Key را بررسی کنید.',
    }
  }

  if (code === 'NoSuchBucket' || lower.includes('nosuchbucket')) {
    return {
      category: 'BUCKET_NOT_FOUND',
      code,
      message: rawMessage,
      operatorMessage: 'باکت پیدا نشد. نام باکت و region/endpoint را بررسی کنید.',
    }
  }

  if (code === 'AccessDenied' || lower.includes('accessdenied') || lower.includes('403')) {
    return {
      category: 'PERMISSION',
      code,
      message: rawMessage,
      operatorMessage:
        'اعتبارنامه معتبر است اما مجوز لازم برای این عملیات وجود ندارد (مثلاً PutObject یا DeleteObject).',
    }
  }

  if (lower.includes('econnrefused') || lower.includes('enotfound') || lower.includes('network')) {
    return {
      category: 'NETWORK',
      code,
      message: rawMessage,
      operatorMessage: 'به endpoint دسترسی شبکه‌ای برقرار نشد.',
    }
  }

  return {
    category: 'UNKNOWN',
    code,
    message: rawMessage,
    operatorMessage: 'خطا در ارتباط با ذخیره‌سازی شیء. جزئیات فنی در لاگ سرور ثبت می‌شود.',
  }
}
