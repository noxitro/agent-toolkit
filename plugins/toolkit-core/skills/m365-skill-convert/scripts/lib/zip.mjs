// Minimal ZIP writer with no dependencies: local headers + central directory + EOCD,
// method 8 (deflate, via node:zlib) or method 0 (store). No ZIP64, no encryption, no
// data descriptors. Entry names are forward-slash, flagged as UTF-8 (bit 11).
//
// Why not a package: the generated skill ships these scripts next to SKILL.md and they
// run from wherever the harness installed the skill, with no node_modules.

import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** MS-DOS date/time pair. Dates before 1980 clamp to 1980-01-01 00:00:00. */
export function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date)
  const year = Math.max(1980, d.getUTCFullYear())
  const time = ((d.getUTCHours() & 0x1f) << 11) | ((d.getUTCMinutes() & 0x3f) << 5) | ((d.getUTCSeconds() >> 1) & 0x1f)
  const day = (((year - 1980) & 0x7f) << 9) | (((d.getUTCMonth() + 1) & 0x0f) << 5) | (d.getUTCDate() & 0x1f)
  return { time: year === 1980 && d.getUTCFullYear() < 1980 ? 0 : time, date: d.getUTCFullYear() < 1980 ? (1 << 5) | 1 : day }
}

/**
 * @param {{ name: string, data: Buffer | Uint8Array }[]} entries
 * @param {{ store?: boolean, wrap?: string | null, mtime?: Date | number }} [opts]
 * @returns {Buffer}
 */
export function writeZip(entries, opts = {}) {
  const { store = false, wrap = null, mtime = Date.UTC(1980, 0, 1) } = opts
  const { time, date } = dosDateTime(mtime)
  const locals = []
  const centrals = []
  let offset = 0

  for (const entry of entries) {
    const name = wrap ? `${wrap.replace(/\/+$/, '')}/${entry.name}` : entry.name
    if (name.includes('\\') || name.startsWith('/')) throw new Error(`zip: bad entry name ${name}`)
    const nameBuf = Buffer.from(name, 'utf8')
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data)
    const crc = crc32(raw)
    let method = 0
    let payload = raw
    if (!store && raw.length > 0) {
      const packed = deflateRawSync(raw, { level: 9 })
      if (packed.length < raw.length) {
        method = 8
        payload = packed
      }
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(0x0800, 6) // flags: UTF-8 names
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, nameBuf, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // version made by: MS-DOS, 2.0
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30) // extra
    central.writeUInt16LE(0, 32) // comment
    central.writeUInt16LE(0, 34) // disk
    central.writeUInt16LE(0, 36) // internal attrs
    central.writeUInt32LE(0, 38) // external attrs
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const cdSize = centrals.reduce((n, b) => n + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)

  if (entries.length > 0xffff || offset + cdSize > 0xffffffff) throw new Error('zip: archive exceeds the non-ZIP64 limits')
  return Buffer.concat([...locals, ...centrals, eocd])
}
