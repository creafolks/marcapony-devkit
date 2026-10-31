declare const apiPathBrand: unique symbol

/**
 * A request path built by `path`. The transport only accepts this type, so a
 * raw string with an unencoded id in it cannot reach the network by accident.
 */
export type ApiPath = string & { readonly [apiPathBrand]: true }

/**
 * Builds a request path from a template, encoding every interpolated value as
 * one path segment: path`/posts/${id}/translations/${locale}`.
 *
 * A value that is empty, `.` or `..` is refused, because a URL would resolve it
 * away and the request would reach a different route. Anything else (`/`, `?`,
 * `#`, `%`) is percent-encoded and stays inside its segment.
 */
export function path(strings: TemplateStringsArray, ...values: Array<string | number>): ApiPath {
  let out = strings[0] ?? ''
  values.forEach((value, i) => {
    out += segment(value) + (strings[i + 1] ?? '')
  })
  return out as ApiPath
}

function segment(value: string | number): string {
  const text = String(value)
  if (text === '' || text === '.' || text === '..') {
    throw new Error(`marcapony-sdk: invalid record id ${JSON.stringify(text)}`)
  }
  return encodeURIComponent(text)
}
