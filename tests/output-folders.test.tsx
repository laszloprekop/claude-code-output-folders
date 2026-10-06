import { expect, mock, test } from 'claude-code/testing'

import { classify, dirname, outputsOf, resolvePath, shellOutputs } from '../hooks/paths'

const HOME = '/Users/me'
const CWD = '/Users/me/dev/app'

test('places and classifies paths', () => {
  expect(dirname('/a/b/c.txt')).toBe('/a/b')
  expect(resolvePath('out/../dist/x.js', CWD, HOME)).toBe('/Users/me/dev/app/dist/x.js')
  expect(resolvePath('~/notes', CWD, HOME)).toBe('/Users/me/notes')
  expect(resolvePath('$OUT/x', CWD, HOME)).toBeUndefined()
  expect(resolvePath('/dev/null', CWD, HOME)).toBeUndefined()

  expect(classify('/private/tmp/claude-501/scratchpad', CWD, HOME)).toBe('temp')
  expect(classify('/Users/me/dev/app/node_modules/.cache/x', CWD, HOME)).toBe('cache')
  expect(classify('/Users/me/dev/app/public/img', CWD, HOME)).toBe('public')
  expect(classify('/Users/me/.claude/themes', CWD, HOME)).toBe('config')
  expect(classify('/Users/me/dev/app/src', CWD, HOME)).toBe('project')
  expect(classify('/opt/data', CWD, HOME)).toBe('other')
})

test('reads what a shell command writes', () => {
  expect(shellOutputs('npm run build > logs/build.log 2>&1 && mkdir -p dist/assets')).toEqual({
    files: ['logs/build.log'],
    dirs: ['dist/assets'],
  })
  expect(shellOutputs('M=/tmp/work; cp a.txt $M/copy.txt; curl -s x -o "$M/page.html"')).toEqual({
    files: ['/tmp/work/copy.txt', '/tmp/work/page.html'],
    dirs: [],
  })
  expect(shellOutputs("cat > /tmp/a.json <<'EOF'\n{ \"x\": \"> /nope\" }\nEOF\nls -la")).toEqual({
    files: ['/tmp/a.json'],
    dirs: [],
  })
  expect(shellOutputs('grep -rn foo src | head -5')).toEqual({ files: [], dirs: [] })
})

test('reads what a tool call wrote', () => {
  expect(outputsOf('Write', { file_path: '/a/b.txt', content: '' }, {}).files).toEqual(['/a/b.txt'])
  expect(outputsOf('Read', { file_path: '/a/b.txt' }, {})).toEqual({ files: [], dirs: [], links: [] })
  expect(outputsOf('Agent', {}, { status: 'async_launched', outputFile: '/tmp/t/a.output' }).files).toEqual([
    '/tmp/t/a.output',
  ])
  expect(
    outputsOf('Artifact', { file_path: '/s/page.html' }, { text: 'at https://claude.ai/code/artifact/abc-1 now' }),
  ).toEqual({ files: ['/s/page.html'], dirs: [], links: ['https://claude.ai/code/artifact/abc-1'] })
})

test('the pane lists a written folder and marks it changed until seen', async ($, on) => {
  mock.clock(on, { now: Date.UTC(2026, 9, 6, 12, 0, 0) })
  mock.env(on, { HOME })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: CWD }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('fs.stat', () => ({ value: { kind: 'dir', size: 0, mtimeMs: 5_000, isLink: false } }))
  on('fs.list', () => ({
    value: [{ name: 'build.log', kind: 'file', size: 10, mtimeMs: 9_000, isLink: false }],
  }))
  on('tool.call', () => ({ result: { stdout: '', stderr: '' } }) as never)

  await $.session.start({ cwd: CWD, surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c1', command: 'npm run build > /tmp/logs/build.log' })
  await $.command.run({
    command: 'outputs',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

  const pane = await $.ui.mount({
    plugin: 'output-folders',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'output-folders',
    props: {
      title: 'Output folders',
      isFocused: true,
      bodyColumns: 100,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })

  expect(await pane.find({ type: 'Text', text: /temp\s+\/tmp\/logs/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 folders, 1 changed/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /1 write, last by Bash/ })).toBeDefined()

  await pane.press({ key: 'seen' })
  expect(await pane.find({ type: 'Text', text: /1 folders, 0 changed/ })).toBeDefined()
  await pane.unmount()
})
