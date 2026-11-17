import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { clipboard } from 'electron'

function run(cmd: string, args: string[], stdin?: string): Promise<boolean> {
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawn(cmd, args, { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] })
    } catch {
      return resolve(false)
    }
    proc.on('error', () => resolve(false))
    proc.on('close', (code) => resolve(code === 0))
    if (stdin !== undefined) {
      proc.stdin.end(stdin)
    } else {
      proc.stdin.end()
    }
  })
}

/**
 * Put a FILE (not its path as text) on the system clipboard so Ctrl+V in a chat app attaches it.
 */
export async function copyFileToClipboard(filePath: string): Promise<boolean> {
  const url = pathToFileURL(filePath).href

  if (process.platform === 'win32') {
    const escaped = filePath.replace(/'/g, "''")
    return run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Set-Clipboard -LiteralPath '${escaped}'`
    ])
  }

  if (process.platform === 'darwin') {
    const escaped = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
    if (await run('osascript', ['-e', `set the clipboard to (POSIX file "${escaped}")`])) {
      return true
    }
    clipboard.writeBuffer('public.file-url', Buffer.from(url))
    return true
  }

  // Linux: Chromium-based apps read pasted files from text/uri-list.
  // External tools keep owning the clipboard even after this app closes.
  const uriList = `${url}\r\n`
  if (process.env.WAYLAND_DISPLAY && (await run('wl-copy', ['--type', 'text/uri-list'], uriList))) {
    return true
  }
  if (await run('xclip', ['-selection', 'clipboard', '-t', 'text/uri-list', '-i'], uriList)) {
    return true
  }
  try {
    clipboard.writeBuffer('text/uri-list', Buffer.from(uriList))
    return true
  } catch {
    return false
  }
}
