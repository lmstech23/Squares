const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789' // no l/o/0/1

export function slugifyTitle(title: string): string {
  const base = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '')
  return base.length >= 2 ? base : 'event'
}

export function randomSuffix(len = 5, rand: () => number = Math.random): string {
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return out
}

export function candidateSlug(title: string, rand?: () => number): string {
  return `${slugifyTitle(title)}-${randomSuffix(5, rand)}`
}
