export interface SiteInfo {
  id: string
  name: string
  slug: string
  domain: string
  country: string
  defaultLocale: string
  supportedLocales: string[]
  defaultCurrency: string
}

export interface Country {
  code: string
  name: string
  regionCode: string
  currencyCode: string
  currencySymbol: string
  phoneCode: string
  languageCode: string
  localeCode: string
}
