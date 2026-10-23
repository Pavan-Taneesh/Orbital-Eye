/* ============================================================
   CLIENT-SIDE CATALOG SEARCH (pure)
   ------------------------------------------------------------
   buildSearchIndex() normalizes every name / NORAD / COSPAR once.
   searchCatalog() is then a single linear pass with integer
   scores dropped into fixed buckets, so only the buckets needed to
   fill `limit` are ever sorted (never the whole hit list).

   Queries shorter than 2 characters return nothing unless they
   are digits (a NORAD ID).

   Ranking (lower is better):
     0  NORAD ID exact            (digit-only query)
     1  COSPAR exact              "1998-067A", "98067A"
     2  name exact
     3  NORAD ID prefix           (digit-only query)
     4  COSPAR prefix             "1998-067", "98067", "067A"
     5  name prefix
     6  any word in the name starts with the query
     7  name contains the query
     8  name contains it once punctuation and spaces are ignored
   Ties: payloads first, then shorter name, then lower NORAD ID.
   ============================================================ */

import type { CatalogObject } from '../engine/contract'

export interface SearchIndex {
  readonly objects: readonly CatalogObject[]
  readonly names: readonly string[] // "CZ 4B R B"
  readonly compact: readonly string[] // "CZ4BRB"
  readonly norads: readonly string[]
  readonly cospars: readonly string[] // "1998067A"
  readonly cosparShort: readonly string[] // "98067A"
  readonly cosparTail: readonly string[] // "067A"
}

export type SearchField = 'norad' | 'cospar' | 'name'

export interface SearchHit {
  readonly object: CatalogObject
  readonly score: number
  readonly field: SearchField
}

export interface SearchResult {
  readonly hits: readonly SearchHit[]
  /** Total matches before the limit was applied. */
  readonly total: number
}

const NON_ALNUM = /[^A-Z0-9]+/g
const BUCKETS = 9

export function normalizeText(value: string): string {
  return value.toUpperCase().replace(NON_ALNUM, ' ').trim()
}

function compactText(value: string): string {
  return value.toUpperCase().replace(NON_ALNUM, '')
}

export function buildSearchIndex(objects: readonly CatalogObject[]): SearchIndex {
  const n = objects.length
  const names = new Array<string>(n)
  const compact = new Array<string>(n)
  const norads = new Array<string>(n)
  const cospars = new Array<string>(n)
  const cosparShort = new Array<string>(n)
  const cosparTail = new Array<string>(n)
  for (let i = 0; i < n; i += 1) {
    const o = objects[i]
    names[i] = normalizeText(o.name)
    compact[i] = compactText(o.name)
    norads[i] = String(o.norad)
    const c = o.cospar ? compactText(o.cospar) : ''
    cospars[i] = c
    cosparShort[i] = c.length > 4 ? c.slice(2) : ''
    cosparTail[i] = c.length > 4 ? c.slice(4) : ''
  }
  return { objects, names, compact, norads, cospars, cosparShort, cosparTail }
}

const EMPTY: SearchResult = { hits: [], total: 0 }

const typeRank = (o: CatalogObject) => (o.objectType === 'PAY' ? 0 : 1)

const compareHits = (a: SearchHit, b: SearchHit) =>
  typeRank(a.object) - typeRank(b.object) ||
  a.object.name.length - b.object.name.length ||
  a.object.norad - b.object.norad

export function searchCatalog(index: SearchIndex, rawQuery: string, limit = 50): SearchResult {
  const query = normalizeText(rawQuery.slice(0, 100))
  const q = compactText(query)
  const digitsOnly = /^\d+$/.test(q)
  if (!q || (q.length < 2 && !digitsOnly)) return EMPTY

  // COSPAR shapes: full "1998067A", short "98067A", launch+piece "067A".
  const cosparFull = q.length >= 5 && /^\d{5,7}[A-Z]{0,3}$/.test(q)
  const cosparShort = /^\d{5}[A-Z]{0,3}$/.test(q)
  const cosparTail = /^\d{3}[A-Z]{1,3}$/.test(q)
  const wordPrefix = ` ${query}`

  const buckets: SearchHit[][] = Array.from({ length: BUCKETS }, () => [])
  const { objects, names, compact, norads, cospars } = index
  let total = 0

  for (let i = 0; i < objects.length; i += 1) {
    let score = -1
    let field: SearchField = 'name'

    if (digitsOnly) {
      const norad = norads[i]
      if (norad === q) score = 0
      else if (norad.startsWith(q)) score = 3
      if (score >= 0) field = 'norad'
    }

    if (score < 0 && cospars[i]) {
      if (cosparFull && cospars[i].startsWith(q)) score = cospars[i] === q ? 1 : 4
      else if (cosparShort && index.cosparShort[i].startsWith(q)) score = index.cosparShort[i] === q ? 1 : 4
      else if (cosparTail && index.cosparTail[i].startsWith(q)) score = 4
      if (score >= 0) field = 'cospar'
    }

    if (score < 0) {
      const name = names[i]
      if (name === query) score = 2
      else if (name.startsWith(query)) score = 5
      else if (name.includes(wordPrefix)) score = 6
      else if (name.includes(query)) score = 7
      else if (q.length >= 3 && compact[i].includes(q)) score = 8
    }

    if (score >= 0) {
      total += 1
      buckets[score].push({ object: objects[i], score, field })
    }
  }

  const hits: SearchHit[] = []
  for (const bucket of buckets) {
    if (hits.length >= limit) break
    if (!bucket.length) continue
    const need = limit - hits.length
    hits.push(...(bucket.length <= need ? bucket.sort(compareHits) : topK(bucket, need)))
  }
  return { hits, total }
}

/** The `k` best hits of a large bucket, sorted, without sorting the whole bucket. */
function topK(bucket: SearchHit[], k: number): SearchHit[] {
  const best: SearchHit[] = []
  for (const hit of bucket) {
    if (best.length === k && compareHits(hit, best[k - 1]) >= 0) continue
    let lo = 0
    let hi = best.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (compareHits(best[mid], hit) <= 0) lo = mid + 1
      else hi = mid
    }
    best.splice(lo, 0, hit)
    if (best.length > k) best.pop()
  }
  return best
}
