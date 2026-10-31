import { path } from '../path.js'
import { get, type Transport } from '../transport.js'
import type { Country, SiteInfo } from '../types/index.js'

export function siteResource(t: Transport) {
  return {
    /** The account's site: name, domain, locales and default currency. */
    get: (): Promise<SiteInfo> => get(t, path`/site`),
  }
}

export function regionsResource(t: Transport) {
  return {
    /** Every country the platform knows, with its currency, phone code and locale. */
    list: (): Promise<Country[]> => get(t, path`/regions`),
  }
}

export type SiteResource = ReturnType<typeof siteResource>
export type RegionsResource = ReturnType<typeof regionsResource>
