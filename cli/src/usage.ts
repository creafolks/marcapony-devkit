import type { SourceUsage } from './api.js'

/** `tr` when the terminal's locale is Turkish, else `en`. */
export function usageLocale(env: NodeJS.ProcessEnv = process.env): 'tr' | 'en' {
  const value = env.LC_ALL || env.LC_MESSAGES || env.LANG || ''
  return /^tr([_.-]|$)/i.test(value) ? 'tr' : 'en'
}

function mb(bytes: number, locale: 'tr' | 'en', fixed: boolean): string {
  return new Intl.NumberFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
    minimumFractionDigits: fixed ? 1 : 0,
    maximumFractionDigits: 1,
  }).format(bytes / 1024 / 1024)
}

/**
 * The source repo's usage line, as the dashboard shows it:
 * "Source repo: 12.4 / 50 MB (37.6 MB left)", or in Turkish
 * "Kaynak deposu: 12,4 / 50 MB (37,6 MB kaldı)".
 */
export function formatSourceUsage(usage: SourceUsage, locale: 'tr' | 'en' = usageLocale()): string {
  const used = mb(usage.usedBytes, locale, true)
  const limit = mb(usage.limitBytes, locale, false)
  const left = usage.limitBytes - usage.usedBytes
  if (locale === 'tr') {
    return left > 0
      ? `Kaynak deposu: ${used} / ${limit} MB (${mb(left, locale, true)} MB kaldı)`
      : `Kaynak deposu: ${used} / ${limit} MB (sınırda ya da üzerinde)`
  }
  return left > 0
    ? `Source repo: ${used} / ${limit} MB (${mb(left, locale, true)} MB left)`
    : `Source repo: ${used} / ${limit} MB (at or over the limit)`
}

export function isOverSourceLimit(usage: SourceUsage | null | undefined): boolean {
  return !!usage && usage.usedBytes >= usage.limitBytes
}
