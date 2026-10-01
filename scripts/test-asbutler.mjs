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
  await asb.removeSessions({ remote: false, where: 'h', run: async a => { seen = a; return '[]' } },
    [{ id: 'a', store: '' }, { id: 'b', store: '' }])
  assert.deepStrictEqual(seen, ['rm', 'a', 'b'])
})

await check('renameSession passes the store so an ambiguous id is not guessed', async () => {
  let seen
  const runner = { remote: false, where: 'h', run: async a => { seen = a; return '{"id":"x","title":"t"}' } }
  await asb.renameSession(runner, { id: 'x', store: 'v2' }, 't')
  assert.deepStrictEqual(seen, ['rename', 'x', 't', '--store', 'v2'])
  await asb.renameSession(runner, { id: 'x', store: '' }, 't')
  assert.deepStrictEqual(seen, ['rename', 'x', 't'], 'single-store agents send no --store')
})

await check('rowKey separates the same id in different stores', () => {
  assert.notStrictEqual(asb.rowKey({ id: 'x', store: 'v1' }), asb.rowKey({ id: 'x', store: 'v2' }))
  assert.strictEqual(asb.rowKey({ id: 'x', store: '' }), 'x')
})

await check('removeSessions groups one call per store', async () => {
  const calls = []
  const runner = { remote: false, where: 'h', run: async a => { calls.push(a); return '[]' } }
  await asb.removeSessions(runner, [
    { id: 'a', store: 'v2' }, { id: 'b', store: 'v1' }, { id: 'c', store: 'v2' },
  ])
  // --store applies to the whole invocation, so mixed stores cannot share one call.
  assert.deepStrictEqual(calls, [['rm', 'a', 'c', '--store', 'v2'], ['rm', 'b', '--store', 'v1']])
})

// rename exits 0 on failure, so only the error field distinguishes success.
await assert.rejects(
  () => asb.renameSession(fake('{"id":"x","title":"t","error":"no session with id \\"x\\""}'), { id: 'x', store: '' }, 't'),
  /no session with id/)
console.log('  ok  renameSession surfaces the error field despite exit 0')
passed++

await check('isPlaceholderTitle matches only the synthesised form', () => {
  const id = 'e9545db7-0b50-4140-a359-c18981a51d5e'
  assert.ok(asb.isPlaceholderTitle({ id, title: '(untitled · e9545db7)' }))
  assert.ok(!asb.isPlaceholderTitle({ id, title: 'a real title' }))
  // A different id's placeholder is somebody's real title as far as this session knows.
  assert.ok(!asb.isPlaceholderTitle({ id, title: '(untitled · deadbeef)' }))
})

await check('extractMarked ignores whatever a profile prints around the probe', () => {
  const m = asb.PATH_MARK
  assert.strictEqual(asb.extractMarked(`Welcome!\nconda init…\n${m}/a:/b${m}\nbye`), '/a:/b')
  assert.strictEqual(asb.extractMarked('no marks here'), null)
  assert.strictEqual(asb.extractMarked(`${m}${m}`), null, 'empty PATH is not a result')
})

await check('remoteCommand pins a resolved PATH before probing, quoted', () => {
  const cmd = asb.remoteCommand(['asbutler', 'list'], "/home/u/.local/bin:/it's/bin")
  assert.ok(cmd.indexOf('export PATH=') < cmd.indexOf('command -v'), cmd)
  const echoed = execFileSync('sh', ['-c', cmd.split(';')[0] + '; printf %s "$PATH"']).toString()
  assert.strictEqual(echoed, "/home/u/.local/bin:/it's/bin")
  assert.ok(!asb.remoteCommand(['x']).includes('export PATH'), 'no prefix when unresolved')
})

await check('loginPath recovers the real PATH from a launchd-minimal environment', () => {
  // Tabby's own env: launchd hands GUI apps only these four directories.
  const script = `import(${JSON.stringify(join(out, 'asbutler.js'))}).then(m => m.loginPath()).then(p => process.stdout.write(p ?? ''))`
  const resolved = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { HOME: process.env.HOME, SHELL: process.env.SHELL, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  }).toString()
  // Baseline from the same clean env: this test may itself run inside a terminal that injected extra dirs.
  const real = execFileSync(process.env.SHELL, ['-ilc', 'printf %s "$PATH"'], {
    env: { HOME: process.env.HOME, SHELL: process.env.SHELL, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    stdio: ['ignore', 'pipe', 'ignore'],
  }).toString()
  assert.ok(resolved.split(':').length > 4, `resolved only: ${resolved}`)
  assert.deepStrictEqual(resolved.split(':'), real.split(':'))
})

await check('childPath leads with the login PATH, keeps the fallbacks, has no duplicates', async () => {
  const p = (await asb.childPath()).split(':')
  const login = (await asb.loginPath()).split(':')
  assert.deepStrictEqual(p.slice(0, new Set(login).size), [...new Set(login)])
  assert.ok(asb.SEARCH_DIRS.every(d => p.includes(d)))
  assert.strictEqual(new Set(p).size, p.length)
})

await check('resumeLine uses asbutler argv verbatim, absent means no resume', () => {
  const r = ['kiro-cli', 'chat', '--resume-id', '8c4f0f8b-26eb-42f8-b4b9-c9b443daf872', '--agent-engine', 'v1']
  assert.strictEqual(asb.resumeLine({ resume: r }), r.join(' '), 'plain args stay unquoted')
  assert.strictEqual(asb.resumeLine({}), null)
  assert.strictEqual(asb.resumeLine({ resume: [] }), null)
})

await check('resumeLine quotes anything a shell would reinterpret', () => {
  const nasty = ['echo', "it's", 'a b', '$(touch /tmp/x)', '`id`']
  const line = asb.resumeLine({ resume: nasty })
  const out = execFileSync('sh', ['-c', `printf '%s\\n' ${line.slice('echo '.length)}`]).toString().trimEnd().split('\n')
  assert.deepStrictEqual(out, nasty.slice(1))
})

const refusal = 'id matches more than one session: "x" names 2 different conversations in the v1 store (/a, /b), and Kiro deletes by id — they can only go together; pass --all-with-id to confirm'

await check('removeSessions appends --all-with-id only when asked', async () => {
  const calls = []
  const runner = { remote: false, where: 'h', run: async a => { calls.push(a); return '[]' } }
  await asb.removeSessions(runner, [{ id: 'x', store: 'v1' }])
  await asb.removeSessions(runner, [{ id: 'x', store: 'v1' }], true)
  assert.deepStrictEqual(calls, [['rm', 'x', '--store', 'v1'], ['rm', 'x', '--store', 'v1', '--all-with-id']])
})

await check('the refusal is recognised as a JSON result', async () => {
  const r = await asb.removeSessions(fake(JSON.stringify([{ id: 'x', deleted: false, error: refusal }])), [{ id: 'x', store: 'v1' }])
  assert.ok(asb.needsAllWithId(r[0].error))
})

await check('the refusal is recognised as a failed run, other failures still throw', async () => {
  const failing = msg => ({ remote: false, where: 'h', run: async () => { throw new Error(msg) } })
  const r = await asb.removeSessions(failing(refusal), [{ id: 'x', store: 'v1' }, { id: 'y', store: 'v1' }])
  assert.deepStrictEqual(r.map(x => [x.id, x.deleted, asb.needsAllWithId(x.error)]), [['x', false, true], ['y', false, true]])
  await assert.rejects(() => asb.removeSessions(failing('disk on fire'), [{ id: 'x', store: 'v1' }]), /disk on fire/)
})

await check('executableNames appends PATHEXT on Windows only', () => {
  assert.deepStrictEqual(asb.executableNames('asbutler', false), ['asbutler'])
  const win = asb.executableNames('asbutler', true, '.COM;.EXE;.CMD')
  assert.deepStrictEqual(win, ['asbutler.com', 'asbutler.exe', 'asbutler.cmd', 'asbutler'])
  // An explicit suffix is already a full name; do not build asbutler.exe.exe.
  assert.deepStrictEqual(asb.executableNames('asbutler.exe', true, '.EXE'), ['asbutler.exe'])
  assert.deepStrictEqual(asb.executableNames('ASBUTLER.EXE', true, '.exe'), ['ASBUTLER.EXE'])
})

await check('looksLikePath recognises Windows locations', () => {
  // The screenshot's case: a drive-letter path must not be treated as a bare command.
  assert.ok(asb.looksLikePath('C:\\Users\\xxs_e\\.local\\bin\\asbutler.exe', true))
  assert.ok(asb.looksLikePath('C:/Users/xxs_e/asbutler.exe', true))
  assert.ok(!asb.looksLikePath('asbutler', true))
  assert.ok(asb.looksLikePath('/usr/local/bin/asbutler', false))
  assert.ok(!asb.looksLikePath('asbutler', false))
})

await check('a Windows PATH survives splitting, which ":" destroyed', () => {
  // Why Windows never found it: splitting on ':' turned C:\Users\… into "C" and "\Users\…".
  const winPath = 'C:\\Users\\xxs_e\\.local\\bin;C:\\Windows\\system32'
  assert.deepStrictEqual(winPath.split(';'), ['C:\\Users\\xxs_e\\.local\\bin', 'C:\\Windows\\system32'])
  assert.ok(winPath.split(':').length > 2, 'splitting on ":" shatters drive letters')
})

await check('SEARCH_DIRS carries no paths from the other platform', () => {
  const unixish = asb.SEARCH_DIRS.filter(d => d.startsWith('/'))
  assert.strictEqual(asb.IS_WINDOWS ? unixish.length : 0, 0, asb.SEARCH_DIRS.join(' '))
  assert.ok(asb.SEARCH_DIRS.every(d => d.length > 0))
})

console.log(`\n${passed} passed`)
