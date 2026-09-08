// Unit tests for the asbutler layer. Possible only because it no longer imports Angular.
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import assert from 'assert'

const out = mkdtempSync(join(tmpdir(), 'asb-test-'))
execFileSync('./node_modules/typescript/bin/tsc', [
  'src/asbutler.ts', '--outDir', out,
  '--target', 'es2020', '--module', 'commonjs', '--skipLibCheck',
], { stdio: 'inherit' })

const asb = await import(join(out, 'asbutler.js'))
let passed = 0
// await, or an async body's assertion becomes an unhandled rejection instead of a failure.
const check = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ok  ${name}`)
}
const throws = (fn, re, name) => check(name, () => assert.throws(fn, re))

await check('quoteArgv quotes plainly', () =>
  assert.strictEqual(asb.quoteArgv(['list', '--path', '/a b']), `'list' '--path' '/a b'`))

await check('quoteArgv survives an embedded single quote', () => {
  // A path like /tmp/it's must not break out of the quoting and inject shell.
  const cmd = asb.quoteArgv([`/tmp/it's`])
  assert.ok(!/[^\\]';/.test(cmd), cmd)
  const echoed = execFileSync('sh', ['-c', `printf %s ${cmd}`]).toString()
  assert.strictEqual(echoed, `/tmp/it's`)
})

await check('remoteCommand probes with command -v and an if, not ||', () => {
  const cmd = asb.remoteCommand(['list'])
  assert.ok(cmd.startsWith('if command -v asbutler'), cmd)
  assert.ok(!cmd.includes('||'), 'must not use ||: a non-zero exit is not absence')
  assert.ok(cmd.includes(asb.MISSING_MARKER))
})

await check('interpretOutput passes real output through', () =>
  assert.strictEqual(asb.interpretOutput('{"sessions":[]}', '', 'h'), '{"sessions":[]}'))

await throws(() => asb.interpretOutput(asb.MISSING_MARKER + '\n', '', 'devclient'),
  /not installed on devclient/, 'interpretOutput detects the marker')

await throws(() => asb.interpretOutput('', 'bash: asbutler: command not found', 'sbox'),
  /not installed on sbox/, 'interpretOutput falls back to stderr wording')

await throws(() => asb.interpretOutput('', '', 'sbox'),
  /produced no output/, 'interpretOutput reports empty output')

await check('humanSize crosses units correctly', () => {
  assert.strictEqual(asb.humanSize(0), '0 B')
  assert.strictEqual(asb.humanSize(1023), '1023 B')
  assert.strictEqual(asb.humanSize(1024), '1.0 KiB')
  assert.strictEqual(asb.humanSize(17060063), '16.3 MiB')
})

const fake = (stdout) => ({ remote: true, where: 'h', run: async () => stdout })

await check('listSessions narrows with --path', async () => {
  let seen
  await asb.listSessions({ remote: false, where: 'h', run: async a => { seen = a; return '{"sessions":[]}' } }, '/x')
  assert.deepStrictEqual(seen, ['list', '--path', '/x'])
})

await check('listSessions tolerates a missing sessions key', async () =>
  assert.deepStrictEqual(await asb.listSessions(fake('{}'), '/x'), []))

await assert.rejects(() => asb.listSessions(fake('not json'), '/x'), /non-JSON/)
console.log('  ok  listSessions rejects non-JSON')
passed++

await check('removeSessions passes every id in one call', async () => {
  let seen
  await asb.removeSessions({ remote: false, where: 'h', run: async a => { seen = a; return '[]' } }, ['a', 'b'])
  assert.deepStrictEqual(seen, ['rm', 'a', 'b'])
})

console.log(`\n${passed} passed`)
