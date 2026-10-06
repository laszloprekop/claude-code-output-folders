import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FolderCheck, FolderKind, OutputFolder } from '../types'
import { classify, dirname, outputsOf, resolvePath, shorten } from './paths'
import type { Found } from './paths'

const PANE = 'output-folders'
const MAX_FOLDERS = 200
const MAX_LINKS = 50

const folders = atom({ plugin: 'output-folders', key: 'folders' } as const, [])
const links = atom({ plugin: 'output-folders', key: 'links' } as const, [])
const checks = atom({ plugin: 'output-folders', key: 'checks' } as const, [])
const checkedAt = atom({ plugin: 'output-folders', key: 'checkedAt' } as const, 0)

const KIND_COLOR: Record<FolderKind, string> = {
  temp: 'warning',
  cache: 'suggestion',
  public: 'success',
  config: 'remember',
  project: 'text',
  other: 'inactive',
}

const pad = (n: number) => String(n).padStart(2, '0')

const clock = (ms: number) => {
  const d = new Date(ms)

  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Notes the folders and links one finished tool call wrote to.
async function record($: EngineInterface, found: Found, tool: string) {
  if (found.files.length + found.dirs.length + found.links.length === 0) {
    return
  }

  const cwd = await $.session.cwd()
  const home = (await $.env.get('HOME')) ?? ''
  const at = await $.clock.now()
  const placed = (path: string) => {
    const resolved = resolvePath(path, cwd, home)

    return resolved === undefined ? [] : [resolved]
  }
  const paths = [...found.files.flatMap(placed).map(dirname), ...found.dirs.flatMap(placed)]

  if (paths.length > 0) {
    await update($, folders, list => {
      const byPath = new Map(list.map(folder => [folder.path, folder]))

      for (const path of paths) {
        const known = byPath.get(path)
        byPath.set(path, {
          path,
          kind: classify(path, cwd, home),
          writes: (known?.writes ?? 0) + 1,
          lastAt: at,
          lastBy: tool,
          seenMtimeMs: known?.seenMtimeMs ?? 0,
        })
      }

      return [...byPath.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, MAX_FOLDERS)
    })
  }

  if (found.links.length > 0) {
    await update($, links, list =>
      [
        ...found.links.map(url => ({ url, at })),
        ...list.filter(link => !found.links.includes(link.url)),
      ].slice(0, MAX_LINKS),
    )
  }
}

// Looks into each folder: its newest change and how many files it holds.
async function check($: EngineInterface) {
  const looked: FolderCheck[] = []

  for (const folder of await read($, folders)) {
    try {
      const own = await $.fs.stat(folder.path)
      const entries = await $.fs.list(folder.path)
      const files = entries.filter(entry => entry.kind === 'file')

      looked.push({
        path: folder.path,
        newestMs: Math.max(own.mtimeMs, ...files.map(file => file.mtimeMs)),
        files: files.length,
        isMissing: false,
      })
    } catch {
      looked.push({ path: folder.path, newestMs: 0, files: 0, isMissing: true })
    }
  }

  const at = await $.clock.now()
  await update($, checks, () => looked)
  await update($, checkedAt, () => at)
}

// Opens a folder or a link with the system's opener, since a terminal does
// not always pass a hyperlink's click on.
async function openTarget($: EngineInterface, target: string) {
  try {
    const ran = await $.process
      .run(['open', target])
      .catch(() => $.process.run(['xdg-open', target]))

    if (ran.exitCode !== 0) {
      $.ui.toast(`Could not open ${target}: ${ran.stderr.trim().split('\n')[0] ?? ''}`)
    }
  } catch {
    $.ui.toast(`Could not open ${target}`)
  }
}

// Keeps a long path's start and end.
const fit = (text: string, room: number) =>
  text.length <= room
    ? text
    : `${text.slice(0, Math.ceil((room - 1) / 2))}…${text.slice(text.length - Math.floor((room - 1) / 2))}`

// Marks every folder's newest change as seen.
async function markSeen($: EngineInterface) {
  const looked = new Map((await read($, checks)).map(one => [one.path, one.newestMs]))

  await update($, folders, list =>
    list.map(folder => ({ ...folder, seenMtimeMs: looked.get(folder.path) ?? folder.seenMtimeMs })),
  )
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'outputs',
      description: 'Show the folders that tools, scripts and agents wrote into this session',
    })

    return next(e)
  })

  on('command.run', { command: 'outputs' }, async $ => {
    await check($)
    await $.ui.open({ id: PANE, title: 'Output folders', focus: true, closeOnEscape: true })

    return { text: `Output folders: ${(await read($, folders)).length} tracked.` }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)

    try {
      if (ran.deny === undefined && ran.isError !== true) {
        await record($, outputsOf(e.tool, e, ran.result), e.tool)
      }
    } catch {
      // The call's answer stands whether or not its folders were noted.
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const room = Math.max(20, e.props.bodyColumns - 16)
    const list = await read($, folders)
    const looked = new Map((await read($, checks)).map(one => [one.path, one]))
    const at = await read($, checkedAt)
    const urls = await read($, links)
    const home = (await $.env.get('HOME')) ?? ''
    const changed = list.filter(f => (looked.get(f.path)?.newestMs ?? 0) > f.seenMtimeMs).length

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="refresh" hotkey="r" label="refresh" onPress={() => check($)} />
          <Text> </Text>
          <Button key="seen" hotkey="s" label="mark all seen" onPress={() => markSeen($)} />
          <Text> </Text>
          <Button
            key="clear"
            hotkey="c"
            label="clear list"
            onPress={async () => {
              await update($, folders, () => [])
              await update($, links, () => [])
              await update($, checks, () => [])
            }}
          />
        </Box>
        <Text dimColor>
          {list.length} folders, {changed} changed since seen
          {at === 0 ? '' : `, checked ${clock(at)}`}
        </Text>
        {list.length === 0 ? <Text dimColor>Nothing has been written yet.</Text> : ''}
        {list.length + urls.length === 0 ? (
          ''
        ) : (
          <Text dimColor>Click a path or a link, or press its number, to open it.</Text>
        )}
        {list.map((folder, i) => {
          const now = looked.get(folder.path)
          const isChanged = (now?.newestMs ?? 0) > folder.seenMtimeMs

          return (
            <Box flexDirection="column">
              <Box>
                <Text color="warning">{isChanged ? '● ' : '  '}</Text>
                <Text color={KIND_COLOR[folder.kind]}>{folder.kind.padEnd(8)}</Text>
                <Button
                  key={`open-${i}`}
                  plain
                  hotkey={i < 9 ? String(i + 1) : undefined}
                  label={fit(shorten(folder.path, home), room)}
                  onPress={() => openTarget($, folder.path)}
                />
              </Box>
              <Text dimColor wrap="truncate-end">
                {'             '}
                {folder.writes} {folder.writes === 1 ? 'write' : 'writes'}, last by {folder.lastBy} at{' '}
                {clock(folder.lastAt)}
                {now === undefined
                  ? ''
                  : now.isMissing
                    ? ', folder is gone'
                    : `, ${now.files} files, newest change ${clock(now.newestMs)}`}
              </Text>
            </Box>
          )
        })}
        {urls.length === 0 ? '' : <Text bold>Artifact links</Text>}
        {urls.map((link, i) => (
          <Box>
            <Text dimColor>{clock(link.at)} </Text>
            <Button
              key={`link-${i}`}
              plain
              hotkey={list.length + i < 9 ? String(list.length + i + 1) : undefined}
              label={fit(link.url, room)}
              onPress={() => openTarget($, link.url)}
            />
          </Box>
        ))}
      </Box>
    )
  })
}
