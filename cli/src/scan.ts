import { readConfig, type MarcaponyConfig } from './config.js'
import { blockingFindings, formatFinding, planSourceFiles, scanForSecrets } from './source.js'
import type { ScanFinding } from './scan-rules.js'

export interface ScanResult {
  /** How many files were scanned (the files a deploy would save). */
  files: number
  /** Findings that would stop the source push. */
  findings: ScanFinding[]
  /** Matches an allow comment or the test-fixture rule let through. */
  allowed: ScanFinding[]
}

/**
 * `marcapony scan`: the deploy's secret scan on its own, over the same files
 * a deploy would save, for a pre-commit hook or a CI step. A project that is
 * not linked yet is scanned with the default ignore rules.
 */
export function runScan(options: { cwd: string; log?: (m: string) => void }): ScanResult {
  const log = options.log ?? console.log
  const config: MarcaponyConfig = readConfig(options.cwd) ?? { app: 'app', build: '' }
  const { files } = planSourceFiles(options.cwd, config)
  const all = scanForSecrets(options.cwd, files)
  const findings = blockingFindings(all)
  const allowed = all.filter((f) => f.allowed)

  if (findings.length > 0) {
    log(`Possible secrets in ${files.length} scanned file(s):`)
    for (const f of findings) log(`  ${formatFinding(f)}`)
  } else {
    log(`No secrets found in ${files.length} file(s).`)
  }
  if (allowed.length > 0) {
    log(`Allowed (${allowed.length}):`)
    for (const f of allowed) log(`  ${formatFinding(f)}`)
  }
  return { files: files.length, findings, allowed }
}
