// Generates build/icon.ico (and icon.png) — a tartan sett, drawn in code so there is
// no binary asset to lose and no image dependency to install.
import zlib from 'node:zlib'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

const CRC = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return (buf) => {
    let c = -1
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ -1) >>> 0
  }
})()

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(CRC(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]

const BASE = hex('#1d1016') // near-black plum, so the red reads as red
const RED = hex('#c41230') // CMU red
const DEEP = hex('#8d0f24')
const GOLD = hex('#e0a63c')
const CREAM = hex('#f0e4d4')

/**
 * A tartan sett is a repeating sequence of coloured bands, applied identically to
 * warp and weft; where two bands cross, the colours mix. That crossing is what makes
 * plaid look like plaid rather than like a grid.
 */
const SETT = [
  [BASE, 22],
  [DEEP, 10],
  [BASE, 6],
  [GOLD, 3],
  [BASE, 6],
  [DEEP, 10],
  [BASE, 22],
  [RED, 30],
  [CREAM, 3],
  [RED, 30],
]
const PERIOD = SETT.reduce((n, [, w]) => n + w, 0)

function bandAt(u) {
  let x = ((u % PERIOD) + PERIOD) % PERIOD
  for (const [colour, w] of SETT) {
    if (x < w) return colour
    x -= w
  }
  return BASE
}

function render(size) {
  const out = Buffer.alloc(size * size * 4)
  const scale = PERIOD / size // exactly one sett across the icon
  const r = size * 0.22 // corner radius
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const warp = bandAt((x + 0.5) * scale)
      const weft = bandAt((y + 0.5) * scale)
      // Half-and-half twill mix, biased by a diagonal so the weave is visible.
      const t = ((x + y) >> 1) % 2 === 0 ? 0.62 : 0.38
      let cr = warp[0] * t + weft[0] * (1 - t)
      let cg = warp[1] * t + weft[1] * (1 - t)
      let cb = warp[2] * t + weft[2] * (1 - t)

      // Subtle top-left sheen so the tile is not perfectly flat.
      const sheen = 1 + 0.1 * (1 - (x + y) / (2 * size))
      cr = Math.min(255, cr * sheen)
      cg = Math.min(255, cg * sheen)
      cb = Math.min(255, cb * sheen)

      // Rounded-rect coverage with 1px antialiasing.
      const dx = Math.max(r - x - 0.5, x + 0.5 - (size - r), 0)
      const dy = Math.max(r - y - 0.5, y + 0.5 - (size - r), 0)
      const dist = Math.hypot(dx, dy)
      const alpha = Math.max(0, Math.min(1, r - dist + 0.5)) * 255

      const i = (y * size + x) * 4
      out[i] = cr
      out[i + 1] = cg
      out[i + 2] = cb
      out[i + 3] = dx === 0 && dy === 0 ? 255 : alpha
    }
  }
  return out
}

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const pngs = SIZES.map((s) => ({ size: s, buf: encodePng(s, render(s)) }))

// ICO: 6-byte header, then a 16-byte directory entry per image, then the PNG payloads.
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2) // type: icon
header.writeUInt16LE(pngs.length, 4)

let offset = 6 + pngs.length * 16
const entries = []
for (const { size, buf } of pngs) {
  const e = Buffer.alloc(16)
  e[0] = size === 256 ? 0 : size // 0 means 256
  e[1] = size === 256 ? 0 : size
  e[2] = 0 // palette
  e[4] = 1 // colour planes
  e.writeUInt16LE(32, 6) // bits per pixel
  e.writeUInt32LE(buf.length, 8)
  e.writeUInt32LE(offset, 12)
  entries.push(e)
  offset += buf.length
}

fs.writeFileSync(path.join(dir, 'icon.ico'), Buffer.concat([header, ...entries, ...pngs.map((p) => p.buf)]))
fs.writeFileSync(path.join(dir, 'icon.png'), pngs.find((p) => p.size === 256).buf)
console.log('wrote icon.ico (' + SIZES.join(', ') + ') and icon.png')
