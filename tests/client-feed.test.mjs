/**
 * Client-half invariants that only exist in the browser bundle.
 *
 * `lib/client.js` is a hand-written loader factory (no JSX, no build step), and
 * the Feed view needs a live session projection to render, so these tests pin
 * the SOURCE-LEVEL guarantees the host side cannot cover:
 *
 * - a failed feed request is NOT reported as "this workspace has no .agi/";
 * - the 5s poller does not run while the tab is hidden;
 * - a settings save that fails midway rolls back what it already wrote;
 * - a truncated feed payload says so.
 */

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

test('feed failures are separated from an absent .agi/ directory', () => {
  assert.match(
    source,
    /res\.status === 400 \|\| res\.status === 404\) return \{ missing: true, status: res\.status \}/,
    'only 400/404 mean "no state"; everything else is a failure',
  )
  assert.match(source, /if \(!res\.ok\) return \{ failed: true, status: res\.status \}/)
  assert.match(source, /setFeedError\(value == null \|\| value\?\.failed === true\)/)
  // The error state names the HTTP status instead of guessing.
  assert.match(source, /HTTP \$\{feed\.status\}/)
})

test('the Feed poller pauses while the tab is hidden', () => {
  assert.match(source, /document\.visibilityState === 'hidden'/)
  assert.match(source, /addEventListener\('visibilitychange', onVisible\)/)
  assert.match(source, /removeEventListener\('visibilitychange', onVisible\)/)
})

test('a truncated feed payload is surfaced, not silently dropped', () => {
  assert.match(source, /feed\?\.truncated/)
  assert.match(source, /truncated\.workers === undefined \? \[\] : /)
  assert.match(source, /部分内容已截断/)
})

test('a partially failed settings save rolls back what it already wrote', () => {
  assert.match(source, /const applied = \[\]/)
  assert.match(source, /for \(const key of applied\.reverse\(\)\)/)
  assert.match(source, /await scope\.set\(key, value\[key\]\)/)
  // Silent host-floor clamps now explain themselves.
  assert.match(source, /按宿主下限由 \$\{next\} 调整为 \$\{minimum\}/)
})
