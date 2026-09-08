import { execFile } from 'child_process'
import { accessSync, constants } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/** GUI apps inherit a minimal PATH from launchd, so resolve the binary ourselves. */
export const SEARCH_DIRS = [
  join(homedir(), '.local', 'bin'),
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
]

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function resolveBinary(configured: string): string | null {
  const expanded = configured.startsWith('~')
    ? join(homedir(), configured.slice(1))
    : configured
  if (expanded.includes('/')) {
    return isExecutable(expanded) ? expanded : null
  }
  const dirs = [...SEARCH_DIRS, ...(process.env.PATH ?? '').split(':').filter(Boolean)]
  for (const dir of dirs) {
    const candidate = join(dir, expanded)
    if (isExecutable(candidate)) {
      return candidate
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

export function quoteArgv(argv: string[]): string {
  return argv.map(a => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
}

export const MISSING_MARKER = '__asbutler_missing__'

/**
 * Presence is proved in stdout, not guessed from stderr: russh exposes no exit status,
 * and stderr wording is shell- and locale-dependent. `if` rather than `||`, so asbutler's
 * own non-zero exits are not mistaken for it being absent.
 */
export function remoteCommand(argv: string[]): string {
  return `if command -v asbutler >/dev/null 2>&1; then ${quoteArgv(argv)}; ` +
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
export function runOverSsh(
  client: any,
  argv: string[],
  where: string,
  timeoutMs = 10000,
): Promise<string> {
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
      if (failure) {
        reject(failure)
        return
      }
      try {
        resolve(interpretOutput(
          Buffer.concat(out).toString('utf8'),
          Buffer.concat(err).toString('utf8'),
          where,
        ))
      } catch (e: any) {
        reject(e)
      }
    }

    // Armed before opening the channel: a hang in activation left this pending forever.
    const timer = setTimeout(
      () => finish(new Error(`asbutler on ${where} did not respond within ${timeoutMs / 1000}s`)),
      timeoutMs,
    )

    try {
      channel = await client.activateChannel(await client.openSessionChannel())
      channel.data$?.subscribe((d: any) => out.push(Buffer.from(d)))
      channel.extendedData$?.subscribe((d: any) => err.push(Buffer.from(d?.data ?? d)))
      channel.eof$?.subscribe(() => finish())
      channel.closed$?.subscribe(() => finish())
      await channel.requestExec(remoteCommand(argv))
    } catch (e: any) {
      finish(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/**
 * Resolving asbutler's own path is not enough: it execs agent CLIs itself (deleting a Kiro
 * v1 session shells out to `kiro-cli`), and those inherit Tabby's launchd PATH. ADR-0002 D4.
 */
export function childPath(): string {
  const inherited = (process.env.PATH ?? '').split(':').filter(Boolean)
  // Dedupe the whole list: an inherited PATH commonly repeats entries.
  return [...new Set([...SEARCH_DIRS, ...inherited])].join(':')
}

/** Local runner; `rm` exits non-zero but still prints why, so stdout wins when present. */
export function localRunner(bin: string): Runner {
  return {
    remote: false,
    where: 'this machine',
    run: argv => new Promise((resolve, reject) => {
      const options = {
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: childPath() },
      }
      execFile(bin, argv, options, (err, stdout) => {
        stdout ? resolve(stdout) : reject(err ?? new Error('asbutler produced no output'))
      })
    }),
  }
}

export function remoteRunner(client: any, host: string): Runner {
  // Bare name: agentSessions.binary is a path on *this* machine, meaningless there.
  return {
    remote: true,
    where: host,
    run: argv => runOverSsh(client, ['asbutler', ...argv], host),
  }
}

/** asbutler owns session parsing; `--path` must narrow before it enriches. ADR-0002 D1/D2. */
export async function listSessions(runner: Runner, cwd: string): Promise<AgentSession[]> {
  const stdout = await runner.run(['list', '--path', cwd])
  try {
    return JSON.parse(stdout).sessions ?? []
  } catch {
    throw new Error(
      `asbutler on ${runner.where} returned non-JSON output — needs asbutler >= 0.8.1`,
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
): Promise<RemoveResult[]> {
  const byStore = new Map<string, string[]>()
  for (const t of targets) {
    byStore.set(t.store, [...(byStore.get(t.store) ?? []), t.id])
  }
  const results: RemoveResult[] = []
  for (const [store, ids] of byStore) {
    results.push(...await removeOneStore(runner, ids, store))
  }
  return results
}

async function removeOneStore(
  runner: Runner,
  ids: string[],
  store: string,
): Promise<RemoveResult[]> {
  const stdout = await runner.run(['rm', ...ids, ...storeArgs({ store })])
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
