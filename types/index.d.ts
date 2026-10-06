export type FolderKind = 'temp' | 'cache' | 'public' | 'config' | 'project' | 'other'

// A folder something wrote into. `seenMtimeMs` is the newest change the
// person has marked as seen.
export type OutputFolder = {
  path: string
  kind: FolderKind
  writes: number
  lastAt: number
  lastBy: string
  seenMtimeMs: number
}

export type OutputLink = { url: string; at: number }

// What a folder held when it was last looked at.
export type FolderCheck = { path: string; newestMs: number; files: number; isMissing: boolean }

declare module 'claude-code' {
  interface PluginState {
    'output-folders': {
      folders: OutputFolder[]
      links: OutputLink[]
      checks: FolderCheck[]
      checkedAt: number
    }
  }
}
