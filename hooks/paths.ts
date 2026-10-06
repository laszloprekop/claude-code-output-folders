import type { FolderKind } from '../types'

export type Found = { files: string[]; dirs: string[]; links: string[] }

const isString = (value: unknown): value is string => typeof value === 'string' && value !== ''

export const dirname = (path: string) => {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, '') : path
  const cut = trimmed.lastIndexOf('/')

  return cut <= 0 ? '/' : trimmed.slice(0, cut)
}

// Folds `.` and `..` and makes the path absolute; undefined for a path that
// cannot be placed (an unexpanded variable, a glob, a device).
export const resolvePath = (path: string, cwd: string, home: string) => {
  if (/[$`*?{}]/.test(path) || path === '' || path === '-') {
    return undefined
  }

  const expanded = path === '~' ? home : path.startsWith('~/') ? `${home}${path.slice(1)}` : path
  const absolute = expanded.startsWith('/') ? expanded : `${cwd}/${expanded}`
  const parts: string[] = []

  for (const part of absolute.split('/')) {
    if (part === '..') {
      parts.pop()
    } else if (part !== '' && part !== '.') {
      parts.push(part)
    }
  }

  const folded = `/${parts.join('/')}`

  return folded.startsWith('/dev/') || folded === '/dev' ? undefined : folded
}

export const classify = (path: string, cwd: string, home: string): FolderKind => {
  const p = `${path}/`

  if (/^\/(private\/)?(tmp|var\/folders)\//.test(p) || /\/(tmp|temp|scratchpad)\//i.test(p)) {
    return 'temp'
  }

  if (/\/(\.cache|cache|caches|\.next|\.turbo|\.parcel-cache|\.vite)\//i.test(p)) {
    return 'cache'
  }

  if (/\/(public|dist|build|out|static|site|_site)\//.test(p)) {
    return 'public'
  }

  if (p.startsWith(`${home}/.`) || p.startsWith(`${home}/Library/`)) {
    return 'config'
  }

  return p.startsWith(`${cwd}/`) ? 'project' : 'other'
}

// A path names a file when its last part has an extension.
export const isFileLike = (path: string) =>
  !path.endsWith('/') && /\.[A-Za-z0-9]+$/.test(path.slice(path.lastIndexOf('/') + 1))

const tokenize = (line: string) => {
  const tokens: string[] = []
  const pattern = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(&&|\|\||[;|]|\d*>>?&?\d*|[^\s"';|&<>]+)/g

  for (const match of line.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }

  return tokens
}

const OUTPUT_FLAGS = new Set(['-o', '--output', '--out', '--out-dir', '--outdir', '--output-dir'])
const COPYING = new Set(['cp', 'mv', 'rsync', 'ln'])
const CREATING = new Set(['touch', 'tee'])

// The files and folders a shell command writes, as far as its text says: its
// redirects, `mkdir`, `touch`, `tee`, the target of a copy, an output flag.
export const shellOutputs = (command: string): Pick<Found, 'files' | 'dirs'> => {
  const files: string[] = []
  const dirs: string[] = []
  const vars = new Map<string, string>()
  const text = command.replace(/<<-?\s*['"]?(\w+)['"]?[\s\S]*?\n\1\b/g, ' ')
  const expand = (token: string) =>
    token.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (whole, name: string) => vars.get(name) ?? whole)
  const add = (token: string | undefined, isDir?: boolean) => {
    if (token === undefined || token.startsWith('-')) {
      return
    }

    const path = expand(token)
    ;((isDir ?? !isFileLike(path)) ? dirs : files).push(path)
  }

  let words: string[] = []
  const flush = () => {
    const name = words[0]?.slice(words[0].lastIndexOf('/') + 1)
    const args = words.slice(1).filter(word => !word.startsWith('-'))

    if (name === 'mkdir') {
      args.forEach(arg => add(arg, true))
    } else if (name !== undefined && CREATING.has(name)) {
      args.forEach(arg => add(arg, false))
    } else if (name !== undefined && COPYING.has(name) && args.length > 1) {
      add(args.at(-1))
    }

    words.forEach((word, i) => {
      if (OUTPUT_FLAGS.has(word)) {
        add(words[i + 1])
      } else if (/^--(output|out|out-dir|outdir|output-dir)=/.test(word)) {
        add(word.slice(word.indexOf('=') + 1))
      }
    })
    words = []
  }

  const tokens = tokenize(text)

  tokens.forEach((token, i) => {
    const assignment = /^([A-Za-z_]\w*)=(.+)$/.exec(token)

    if (['&&', '||', ';', '|'].includes(token)) {
      flush()
    } else if (/^\d*>>?$/.test(token)) {
      add(tokens[i + 1], false)
    } else if (assignment !== null && words.length === 0) {
      vars.set(assignment[1] ?? '', expand(assignment[2] ?? ''))
    } else if (!/^\d*>/.test(token) && !/^\d*>>?$/.test(tokens[i - 1] ?? '')) {
      words.push(token)
    }
  })
  flush()

  return { files, dirs }
}

const ARTIFACT_LINK = /https:\/\/claude\.ai\/[^\s"'\\)]*artifact[^\s"'\\)]*/g

// What a finished tool call wrote, read from its input and its result.
export const outputsOf = (tool: string, input: Readonly<Record<string, unknown>>, result: unknown): Found => {
  const found: Found = { files: [], dirs: [], links: [] }
  const answer = (typeof result === 'object' && result !== null ? result : {}) as Readonly<
    Record<string, unknown>
  >

  if (tool === 'Write' || tool === 'Edit') {
    found.files.push(...[input.file_path].filter(isString))
  } else if (tool === 'NotebookEdit') {
    found.files.push(...[input.notebook_path].filter(isString))
  } else if (tool === 'Bash') {
    const shell = shellOutputs(isString(input.command) ? input.command : '')
    found.files.push(...shell.files, ...[answer.rawOutputPath].filter(isString))
    found.dirs.push(...shell.dirs)
  } else if (tool === 'Agent') {
    found.files.push(...[answer.outputFile].filter(isString))
  } else if (tool === 'Artifact') {
    const isPublish = input.action === undefined || input.action === 'publish'
    const paths = Array.isArray(input.file_paths) ? input.file_paths : []

    if (isPublish) {
      found.files.push(...[input.file_path, ...paths].filter(isString))
    }

    found.dirs.push(...[input.out_dir].filter(isString))
    found.links.push(...(JSON.stringify(result ?? '').match(ARTIFACT_LINK) ?? []))
  }

  return found
}

export const shorten = (path: string, home: string) =>
  path === home ? '~' : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
