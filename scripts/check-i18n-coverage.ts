#!/usr/bin/env bun
/**
 * check-i18n-coverage.ts — CI-safe i18n callsite coverage check.
 *
 * Scans source for literal translation references and verifies each resolves
 * against en.json:
 *   - t('key') / t("key")            (React useTranslation)
 *   - i18n.t('key') / i18n.t("key")  (non-React)
 *   - <Trans i18nKey="key">          (JSX)
 *
 * Only complete string-literal keys are checked. Dynamic keys — template
 * literals (t(`status.${id}`)) and concatenations (t('a.' + x)) — are skipped,
 * matching i18next's runtime missing-key warnings for those.
 *
 * To stay false-positive-free (a bad callsite check would block every PR), a
 * key is only reported when it (a) has i18n dot-notation shape and (b) sits in
 * a namespace that already exists in en.json — a missing key in a known
 * category is a real typo/stale reference; an unknown category is left alone.
 *
 * Exits 0 when every checked key resolves; 1 with a diagnostic otherwise.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'

const ROOT = resolve(import.meta.dir ?? new URL('.', import.meta.url).pathname, '..')
const EN_PATH = resolve(ROOT, 'packages', 'shared', 'src', 'i18n', 'locales', 'en.json')
const SCAN_DIRS = ['apps', 'packages']
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'build', '.git', 'out', 'coverage'])
const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'])

/** t('key') | t("key") | i18n.t('key') — literal must be the whole first arg. */
const CALL_RE = /(?:\bi18n\.t|\bt)\(\s*(['"])([^'"]+)\1\s*[,)]/g
/** <Trans i18nKey="key"> */
const TRANS_RE = /\bi18nKey\s*=\s*(['"])([^'"]+)\1/g
/** i18n dot-notation: lowercase category + at least one more segment. */
const KEY_SHAPE = /^[a-z][a-zA-Z0-9]*(?:\.[A-Za-z0-9_-]+)+$/
/** i18next plural forms: t('key', { count }) resolves to key_one / key_other / … */
const PLURAL_SUFFIXES = ['_zero', '_one', '_two', '_few', '_many', '_other']

const en = JSON.parse(readFileSync(EN_PATH, 'utf-8')) as Record<string, string>
const enKeys = new Set(Object.keys(en))
const enCategories = new Set([...enKeys].map((k) => k.slice(0, k.indexOf('.'))))

/** A callsite key resolves if it exists verbatim or via any plural variant. */
const resolvesInEn = (key: string): boolean =>
  enKeys.has(key) || PLURAL_SUFFIXES.some((s) => enKeys.has(key + s))

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) yield* walk(full)
    else if (SOURCE_EXT.has(extname(entry)) && !entry.endsWith('.d.ts')) yield full
  }
}

interface Miss {
  key: string
  file: string
}
const misses: Miss[] = []
const seen = new Set<string>()

for (const base of SCAN_DIRS) {
  const dir = resolve(ROOT, base)
  let exists = true
  try {
    statSync(dir)
  } catch {
    exists = false
  }
  if (!exists) continue

  for (const file of walk(dir)) {
    const text = readFileSync(file, 'utf-8')
    const rel = file.slice(ROOT.length + 1)
    for (const re of [CALL_RE, TRANS_RE]) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        const key = m[2]
        if (!KEY_SHAPE.test(key)) continue
        const category = key.slice(0, key.indexOf('.'))
        if (!enCategories.has(category)) continue // unknown namespace — not our concern
        if (resolvesInEn(key)) continue
        const dedup = `${key}@${rel}`
        if (seen.has(dedup)) continue
        seen.add(dedup)
        misses.push({ key, file: rel })
      }
    }
  }
}

if (misses.length) {
  console.error(`i18n coverage check failed: ${misses.length} callsite key(s) missing from en.json:`)
  for (const { key, file } of misses.sort((a, b) => a.key.localeCompare(b.key))) {
    console.error(`  ${key}  (${file})`)
  }
  process.exit(1)
}

console.log(`i18n coverage OK (all literal t()/i18n.t()/<Trans> keys resolve against en.json)`)
