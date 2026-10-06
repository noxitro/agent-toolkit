// Minimal ZIP reader for the output bundles: walks the central directory, supports
// method 0 (store) and 8 (deflate). Refuses encryption, ZIP64 and unknown methods.

import { inflateRawSync } from 'node:zlib'
import { crc32 } from './zip.mjs'

/** Output bundles are small; anything bigger than the Agent Builder package limit is suspect. */
const MAX_ENTRY_BYTES = 64 * 1024 * 1024

/**
 * @param {Buffer} buf
 * @returns {{ name: string, data: Buffer, method: number, isDir: boolean }[]}
 */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf)
  // EOCD is the last 22 bytes plus an optional comment of up to 65535 bytes.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd === -1) throw new Error('zip: end of central directory not found (not a ZIP file?)')
  const count = buf.readUInt16LE(eocd + 10)
  const cdSize = buf.readUInt32LE(eocd + 12)
  const cdOffset = buf.readUInt32LE(eocd + 16)
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error('zip: ZIP64 archives are not supported')

  const entries = []
  const seen = new Set()
  let p = cdOffset
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`zip: bad central directory entry at ${p}`)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const compSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOffset = buf.readUInt32LE(p + 42)
    const name = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen

    if (flags & 0x0001) throw new Error(`zip: ${name} is encrypted`)
    if (method !== 0 && method !== 8) throw new Error(`zip: ${name} uses unsupported method ${method}`)

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`zip: bad local header for ${name}`)
    const lNameLen = buf.readUInt16LE(localOffset + 26)
    const lExtraLen = buf.readUInt16LE(localOffset + 28)
    const localName = buf.toString(flags & 0x0800 ? 'utf8' : 'latin1', localOffset + 30, localOffset + 30 + lNameLen)
    if (localName !== name) throw new Error(`zip: local header name "${localName}" does not match central directory "${name}"`)
    if (seen.has(name)) throw new Error(`zip: duplicate entry ${name}`)
    seen.add(name)
    const start = localOffset + 30 + lNameLen + lExtraLen
    if (start + compSize > buf.length) throw new Error(`zip: ${name} payload runs past the end of the file`)
    const payload = buf.subarray(start, start + compSize)
    const isDir = name.endsWith('/')
    if (size > MAX_ENTRY_BYTES) throw new Error(`zip: ${name} declares ${size} bytes (limit ${MAX_ENTRY_BYTES})`)
    let data = isDir ? Buffer.alloc(0) : method === 8 ? inflateRawSync(payload, { maxOutputLength: Math.max(size, 1) }) : Buffer.from(payload)
    if (!isDir && data.length !== size) throw new Error(`zip: ${name} size mismatch`)
    if (!isDir && crc32(data) !== crc) throw new Error(`zip: ${name} CRC mismatch`)
    entries.push({ name, data, method, isDir })
  }
  return entries
}
