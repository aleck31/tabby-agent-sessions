import { execFile } from 'child_process'
import { accessSync, constants } from 'fs'
import { homedir, userInfo } from 'os'
import { delimiter, join, posix, win32 } from 'path'

export const IS_WINDOWS = process.platform === 'win32'

/** Fallback only: used when the login-shell PATH cannot be resolved. ADR-0002 D4. */
export const SEARCH_DIRS = IS_WINDOWS
  ? [
    join(homedir(), '.local', 'bin'),
    join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Programs'),
  ]
  : [
    join(homedir(), '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ]

/** X_OK is a no-op on Windows, where being on PATH with a PATHEXT suffix is what counts. */
function isExecutable(p: string): boolean {
  try {
    accessSync(p, IS_WINDOWS ? constants.F_OK : constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * `asbutler` must become `asbutler.exe` on Windows; an explicit suffix is left alone.
 * `win` is a parameter so both branches are testable from either platform.
 */
export function executableNames(
  name: string,
  win = IS_WINDOWS,
  pathext = process.env.PATHEXT,
): string[] {
  if (!win) {
    return [name]
  }
  const exts = (pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
  if (exts.some(e => name.toLowerCase().endsWith(e.toLowerCase()))) {
    return [name]
  }
  return [...exts.map(e => name + e.toLowerCase()), name]
}

/** True when the value names a location rather than a bare command to look up on PATH. */
export function looksLikePath(value: string, win = IS_WINDOWS): boolean {
  return win
    ? win32.isAbsolute(value) || value.includes('\\') || value.includes('/')
    : posix.isAbsolute(value) || value.includes('/')
}

export function resolveBinary(configured: string, path: string): string | null {
  const expanded = configured.startsWith('~')
    ? join(homedir(), configured.slice(1))
    : configured
  if (looksLikePath(expanded)) {
    return executableNames(expanded).find(isExecutable) ?? null
  }
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const name of executableNames(expanded)) {
      const candidate = join(dir, name)
      if (isExecutable(candidate)) {
        return candidate
      }
    }
  }
  return null
}

export interface AgentSession {
  id: string
  /** `v1`/`v2` for Kiro, empty for single-store agents. Kiro reuses ids across stores. */
  store: string
  agent: string
  cwd: string
  profile: string
  orphan: boolean
  title: string
  messageCount: number
  fileSize: number
  sizeHuman: string
  modifiedAt: string
  locked: boolean
  /** argv that resumes this row, bare binary name; absent when the agent has none. asbutler#5 */
  resume?: string[]
}

export interface RemoveResult {
  id: string
  deleted: boolean
  error?: string
}

/** Runs asbutler wherever the terminal actually is — this machine, or the host it is on. */
export interface Runner {
  remote: boolean
  where: string
  run(argv: string[]): Promise<string>
}

/**
 * Rows are identified by id **and** store: opening a Kiro v1 session copies it into v2
 * under the same id, so an id alone can name two different sessions.
 */
export function rowKey(s: { id: string, store: string }): string {
  return s.store ? `${s.id}:${s.store}` : s.id
}

/** asbutler refuses an ambiguous id rather than guessing, so pass the store when we have one. */
export function storeArgs(s: { store: string }): string[] {
  return s.store ? ['--store', s.store] : []
}

/** Brackets the probe's output, so anything a profile prints around it is ignored. */
export const PATH_MARK = '__asbutler_path__'

/** Asks `-i -l` because PATH may be set in rc files (interactive) or profiles (login). */
export const PATH_PROBE = `printf %s ${PATH_MARK}; printf %s "$PATH"; printf %s ${PATH_MARK}`

export function extractMarked(stdout: string): string | null {
  const parts = stdout.split(PATH_MARK)
  return parts.length >= 3 && parts[1].trim() ? parts[1].trim() : null
}

/** One line to type into the user's shell; quotes only the args that need it, so it stays readable. */
export function resumeLine(s: { resume?: string[] }): string | null {
  if (!s.resume?.length) {
    return null
  }
  return s.resume.map(a => /^[A-Za-z0-9._\/:=@%+-]+$/.test(a) ? a : quoteArgv([a])).join(' ')
}

export function quoteArgv(argv: string[]): string {
  return argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
}

export const MISSING_MARKER = '__asbutler_missing__'

/**
 * Presence is proved in stdout, not guessed from stderr: russh exposes no exit status,
 * and stderr wording is shell- and locale-dependent. `if` rather than `||`, so asbutler's
 * own non-zero exits are not mistaken for it being absent.
 */
export function remoteCommand(argv: string[], path: string | null = null): string {
  const env = path ? `export PATH=${quoteArgv([path])}; ` : ''
  return `${env}if command -v asbutler >/dev/null 2>&1; then ${quoteArgv(argv)}; ` +
    `else echo ${MISSING_MARKER}; fi`
}

/** Shared by both transports so a missing binary reads the same either way. */
export function interpretOutput(stdout: string, stderr: string, where: string): string {
  if (stdout.includes(MISSING_MARKER) || /not found|No such file/i.test(stderr)) {
    throw new Error(`asbutler is not installed on ${where}`)
  }
  if (!stdout.trim()) {
    throw new Error(stderr.trim() || `asbutler on ${where} produced no output`)
  }
  return stdout
}

/**
 * Execs over Tabby's already-authenticated russh connection, so there is no second
 * login and no key prompt. Reads until eof/close, since exec has no other end marker.
 */
export function execOverSsh(
  client: any,
  command: string,
  where: string,
  timeoutMs = 10000,
): Promise<{ stdout: string, stderr: string }> {
  return new Promise(async (resolve, reject) => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let channel: any
    let done = false

    const finish = (failure?: Error) => {
      if (done) {
        return
      }
      done = true
      clearTimeout(timer)
      channel?.close?.()?.catch?.(() => {})
      failure
        ? reject(failure)
        : resolve({ stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    }

    // Armed before opening the channel: a hang in activation left this pending forever.
    const timer = setTimeout(
      () => finish(new Error(`${where} did not respond within ${timeoutMs / 1000}s`)),
      timeoutMs,
    )

    try {
      channel = await client.activateChannel(await client.openSessionChannel())
      channel.data$?.subscribe((d: any) => out.push(Buffer.from(d)))
      channel.extendedData$?.subscribe((d: any) => err.push(Buffer.from(d?.data ?? d)))
      channel.eof$?.subscribe(() => finish())
      channel.closed$?.subscribe(() => finish())
      await channel.requestExec(command)
    } catch (e: any) {
      finish(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

let localPath: Promise<string | null> | null = null

/**
 * The user's login-shell PATH on this machine, resolved once; null if the shell misbehaves.
 * Skipped on Windows: there is no launchd stripping the environment, so the process already
 * has the user's PATH, and `$SHELL -i -l -c` has no meaning there.
 */
export function loginPath(timeoutMs = 10000): Promise<string | null> {
  if (IS_WINDOWS) {
    return Promise.resolve(null)
  }
  localPath ??= new Promise(resolve => {
    const shell = process.env.SHELL || userInfo().shell || '/bin/zsh'
    const child = execFile(shell, ['-i', '-l', '-c', PATH_PROBE], { timeout: timeoutMs }, (_, stdout) =>
      resolve(extractMarked(String(stdout ?? ''))))
    child.stdin?.end()
  })
  return localPath
}

const remotePaths = new WeakMap<object, Promise<string | null>>()

/** Same probe on the remote host, resolved once per SSH connection. */
export function remoteLoginPath(client: any, where: string): Promise<string | null> {
  let cached = remotePaths.get(client)
  if (!cached) {
    const probe = `"\${SHELL:-/bin/sh}" -i -l -c ${quoteArgv([PATH_PROBE])} </dev/null`
    cached = execOverSsh(client, probe, where)
      .then(({ stdout }) => extractMarked(stdout))
      .catch(() => null)
    remotePaths.set(client, cached)
  }
  return cached
}

/** Login-shell PATH first, then the fallback dirs, then whatever Tabby inherited; deduped. */
export async function childPath(): Promise<string> {
  const split = (p: string | null | undefined) => (p ?? '').split(delimiter).filter(Boolean)
  return [...new Set([...split(await loginPath()), ...SEARCH_DIRS, ...split(process.env.PATH)])]
    .join(delimiter)
}

/** Local runner; `rm` exits non-zero but still prints why, so stdout wins when present. */
export function localRunner(bin: string, path: string): Runner {
  return {
    remote: false,
    where: 'this machine',
    run: argv => new Promise((resolve, reject) => {
      const options = { maxBuffer: 32 * 1024 * 1024, env: { ...process.env, PATH: path } }
      execFile(bin, argv, options, (err, stdout) => {
        stdout ? resolve(stdout) : reject(err ?? new Error('asbutler produced no output'))
      })
    }),
  }
}

/** Bare `asbutler`, found via the remote login PATH; agentSessions.binary is a local path. */
export function remoteRunner(client: any, host: string): Runner {
  return {
    remote: true,
    where: host,
    run: async argv => {
      const path = await remoteLoginPath(client, host)
      const { stdout, stderr } = await execOverSsh(client, remoteCommand(['asbutler', ...argv], path), host)
      return interpretOutput(stdout, stderr, host)
    },
  }
}

/** asbutler owns session parsing; `--path` must narrow before it enriches. ADR-0002 D1/D2. */
export async function listSessions(runner: Runner, cwd: string): Promise<AgentSession[]> {
  const stdout = await runner.run(['list', '--path', cwd])
  try {
    return JSON.parse(stdout).sessions ?? []
  } catch {
    throw new Error(
      `asbutler on ${runner.where} returned non-JSON output — needs asbutler >= 0.8.5`,
    )
  }
}

/**
 * `rename` returns one object, not an array, and exits 0 even when it fails — the `error`
 * field is the only signal. Writes the title into the agent's own metadata.
 */
export async function renameSession(
  runner: Runner,
  s: { id: string, store: string },
  title: string,
): Promise<void> {
  const stdout = await runner.run(['rename', s.id, title, ...storeArgs(s)])
  let result: { error?: string }
  try {
    result = JSON.parse(stdout)
  } catch {
    throw new Error(`asbutler rename on ${runner.where} returned non-JSON output`)
  }
  if (result.error) {
    throw new Error(result.error)
  }
}

/** asbutler synthesises this for a session with no title of its own; never commit it back. */
export function isPlaceholderTitle(session: { id: string, title: string }): boolean {
  return session.title === `(untitled · ${session.id.slice(0, 8)})`
}

/**
 * One call per store, because `--store` applies to the whole invocation. Ids without a
 * store go together; asbutler errors on an ambiguous id rather than deleting a coin flip.
 */
export async function removeSessions(
  runner: Runner,
  targets: { id: string, store: string }[],
  allWithId = false,
): Promise<RemoveResult[]> {
  const byStore = new Map<string, string[]>()
  for (const t of targets) {
    byStore.set(t.store, [...(byStore.get(t.store) ?? []), t.id])
  }
  const results: RemoveResult[] = []
  for (const [store, ids] of byStore) {
    results.push(...await removeOneStore(runner, ids, store, allWithId))
  }
  return results
}

/** asbutler's refusal when one Kiro v1 id names conversations in several cwds; they can only go together. */
export function needsAllWithId(error: string | undefined): boolean {
  return !!error?.includes('--all-with-id')
}

async function removeOneStore(
  runner: Runner,
  ids: string[],
  store: string,
  allWithId: boolean,
): Promise<RemoveResult[]> {
  const argv = ['rm', ...ids, ...storeArgs({ store }), ...(allWithId ? ['--all-with-id'] : [])]
  let stdout: string
  try {
    stdout = await runner.run(argv)
  } catch (e: any) {
    // The refusal may arrive as a failed run instead of a JSON result; treat it as a per-id answer.
    if (!needsAllWithId(e?.message)) {
      throw e
    }
    return ids.map(id => ({ id, deleted: false, error: String(e.message) }))
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw new Error(`asbutler rm on ${runner.where} returned non-JSON output`)
  }
}

/** Only for summing a batch; single rows use asbutler's own sizeHuman. */
export function humanSize(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${i === 0 ? n : n.toFixed(1)} ${units[i]}`
}
