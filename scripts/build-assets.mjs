/**
 * Regenerates every branded binary asset from source:
 *   build/icon.svg            -> build/icon.png, build/icon.ico, build/icon.icns,
 *                                resources/icon.png, src/renderer/assets/app-icon.png,
 *                                docs/icon.png, docs/favicon.png
 *   branding/social-card.html -> docs/social-preview.png (1280x640, GitHub social preview;
 *                                uses docs/screenshots/app.png, so render screenshots first)
 *
 * Usage: npm run assets   (uses playwright-core's Chromium; set CHROME_PATH to override)
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const r = (...p) => path.join(root, ...p)
const svg = fs.readFileSync(r('build/icon.svg'), 'utf8')
const svgDataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`

const browser = await chromium.launch(
  process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}
)
const page = await browser.newPage({ deviceScaleFactor: 1 })

async function renderIcon(size) {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="${svgDataUrl}" width="${size}" height="${size}" style="display:block"></body></html>`
  )
  await page.waitForLoadState('load')
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
const png = {}
for (const s of sizes) png[s] = await renderIcon(s)

const write = (rel, buf) => {
  fs.mkdirSync(path.dirname(r(rel)), { recursive: true })
  fs.writeFileSync(r(rel), buf)
  console.log('wrote', rel, `${buf.length} bytes`)
}

write('build/icon.png', png[1024])
write('resources/icon.png', png[512])
write('src/renderer/assets/app-icon.png', png[256])
write('docs/icon.png', png[256])
write('docs/favicon.png', png[64])

// ICO: header + directory + embedded PNGs (supported since Windows Vista).
function ico(list) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(list.length, 4)
  const dir = Buffer.alloc(16 * list.length)
  let offset = 6 + dir.length
  list.forEach(([size, data], i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(data.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += data.length
  })
  return Buffer.concat([header, dir, ...list.map(([, d]) => d)])
}
write('build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256].map((s) => [s, png[s]])))

// ICNS: 'icns' + length, then typed PNG chunks.
function icns(list) {
  const chunks = list.map(([type, data]) => {
    const h = Buffer.alloc(8)
    h.write(type, 0, 'ascii')
    h.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([h, data])
  })
  const body = Buffer.concat(chunks)
  const h = Buffer.alloc(8)
  h.write('icns', 0, 'ascii')
  h.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([h, body])
}
write(
  'build/icon.icns',
  icns([
    ['icp4', png[16]],
    ['icp5', png[32]],
    ['icp6', png[64]],
    ['ic07', png[128]],
    ['ic08', png[256]],
    ['ic09', png[512]],
    ['ic10', png[1024]]
  ])
)

// Social preview card
// Loaded from disk so the card can use relative paths (icon, fonts, screenshot).
await page.setViewportSize({ width: 1280, height: 640 })
await page.goto(pathToFileURL(r('branding/social-card.html')).href, { waitUntil: 'load' })
await page.evaluate(() => document.fonts.ready)
write('docs/social-preview.png', await page.screenshot({ clip: { x: 0, y: 0, width: 1280, height: 640 } }))

await browser.close()
