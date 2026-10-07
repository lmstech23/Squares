/**
 * The public origin, validated.
 *
 * An unset APP_URL used to fall back to '' and ship every manage link as a
 * relative path — dead in an email client. It never errored; it just quietly
 * sent a broken email. A missing origin is a configuration failure and must
 * surface as one.
 */
export type AppUrlResult =
  | { ok: true; origin: string }
  | { ok: false; error: string }

export function resolveAppUrl(raw: string | undefined = process.env.APP_URL): AppUrlResult {
  const value = raw?.trim()
  if (!value) return { ok: false, error: 'APP_URL is not set' }

  let url: URL
  try {
    url = new URL(value)
  } catch {
    return { ok: false, error: `APP_URL is not a valid URL: ${value}` }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: `APP_URL must be http or https, got ${url.protocol}` }
  }
  if (!url.hostname) return { ok: false, error: `APP_URL has no host: ${value}` }

  // Normalize away a trailing slash so callers can concatenate paths safely.
  return { ok: true, origin: url.origin }
}
