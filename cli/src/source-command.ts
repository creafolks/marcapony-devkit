import { CliError, EXIT } from './api.js'
import { readConfig } from './config.js'
import { planSourceFiles, type SourcePlan } from './source.js'

/**
 * `marcapony app source --dry-run`: what the next deploy would save, and which
 * rule skipped each other file (and from which file the rule came).
 */
export function runSourceDryRun(options: { cwd: string; log?: (m: string) => void }): SourcePlan {
  const log = options.log ?? console.log
  const config = readConfig(options.cwd)
  if (!config) {
    throw new CliError('No marcapony.json found. Run `marcapony app link` first.', {
      exitCode: EXIT.notLinked,
    })
  }
  const plan = planSourceFiles(options.cwd, config, true)
  log(`Would save ${plan.files.length} file(s):`)
  for (const f of plan.files) log(`  ${f}`)
  if (plan.skipped.length > 0) {
    log(`Skipped ${plan.skipped.length}:`)
    for (const s of plan.skipped) log(`  ${s.path.padEnd(40)} ${s.reason}`)
  }
  return plan
}
