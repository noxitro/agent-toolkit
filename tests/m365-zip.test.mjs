import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { inflateRawSync } from 'node:zlib'
import { crc32, writeZip } from '../shared/skills/m365-skill-pack/scripts/lib/zip.mjs'
import { readZip } from '../shared/skills/m365-skill-pack/scripts/lib/unzip.mjs'

const entries = [
  { name: 'SKILL.md', data: Buffer.from('---\nname: demo\ndescription: d\n---\n\nbody\n') },
  { name: 'scripts/x.py', data: Buffer.from('print("hi")\n'.repeat(40)) },
  { name: 'resources/empty.txt', data: Buffer.alloc(0) },
]

function centralDirectory(buf) {
  const eocd = buf.length - 22
  assert.equal(buf.readUInt32LE(eocd), 0x06054b50, 'EOCD signature')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out = []
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50, 'central header signature')
    const nameLen = buf.readUInt16LE(p + 28)
    out.push({ flags: buf.readUInt16LE(p + 8), method: buf.readUInt16LE(p + 10), crc: buf.readUInt32LE(p + 16), compSize: buf.readUInt32LE(p + 20), size: buf.readUInt32LE(p + 24), offset: buf.readUInt32LE(p + 42), name: buf.toString('utf8', p + 46, p + 46 + nameLen) })
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

test('zip writer: headers, flags, crc and round trip', () => {
  const zip = writeZip(entries)
  const cd = centralDirectory(zip)
  assert.deepEqual(cd.map((e) => e.name), ['SKILL.md', 'scripts/x.py', 'resources/empty.txt'])
  for (const [i, e] of cd.entries()) {
    assert.equal(e.flags & 0x0800, 0x0800, 'UTF-8 name flag')
    assert.equal(zip.readUInt32LE(e.offset), 0x04034b50, 'local header at offset')
    const raw = entries[i].data
    assert.equal(e.crc, crc32(raw))
    assert.equal(e.size, raw.length)
    const nameLen = zip.readUInt16LE(e.offset + 26)
    const extraLen = zip.readUInt16LE(e.offset + 28)
    const payload = zip.subarray(e.offset + 30 + nameLen + extraLen, e.offset + 30 + nameLen + extraLen + e.compSize)
    const data = e.method === 8 ? inflateRawSync(payload) : payload
    assert.ok(data.equals(raw), `payload of ${e.name}`)
  }
  assert.equal(cd[1].method, 8, 'repetitive file is deflated')
  assert.equal(cd[2].method, 0, 'empty file is stored')
  const back = readZip(zip)
  assert.deepEqual(back.map((e) => e.name), cd.map((e) => e.name))
  for (const [i, e] of back.entries()) assert.ok(e.data.equals(entries[i].data))
})

test('zip writer: --store uses method 0 everywhere and --wrap prefixes names', () => {
  const zip = writeZip(entries, { store: true, wrap: 'demo' })
  const cd = centralDirectory(zip)
  assert.ok(cd.every((e) => e.method === 0))
  assert.deepEqual(cd.map((e) => e.name), ['demo/SKILL.md', 'demo/scripts/x.py', 'demo/resources/empty.txt'])
})

test('zip writer: rejects backslashes and absolute names', () => {
  assert.throws(() => writeZip([{ name: 'a\\b.txt', data: Buffer.alloc(0) }]))
  assert.throws(() => writeZip([{ name: '/abs.txt', data: Buffer.alloc(0) }]))
})

test('zip reader: refuses encrypted entries', () => {
  const zip = writeZip(entries)
  const eocd = zip.length - 22
  const cdOffset = zip.readUInt32LE(eocd + 16)
  zip.writeUInt16LE(zip.readUInt16LE(cdOffset + 8) | 0x0001, cdOffset + 8)
  assert.throws(() => readZip(zip), /encrypted/)
})

test('zip writer: external extractor accepts the archive', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'm365zip-'))
  const file = join(dir, 'demo.zip')
  writeFileSync(file, writeZip(entries))
  const candidates = [
    ['python', ['-m', 'zipfile', '-t', file]],
    ['py', ['-3', '-m', 'zipfile', '-t', file]],
    ['unzip', ['-t', file]],
    ['pwsh', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${file}' -DestinationPath '${join(dir, 'x')}' -Force; Get-ChildItem -Recurse '${join(dir, 'x')}' | Measure-Object | Select-Object -ExpandProperty Count`]],
  ]
  let ran = 0
  for (const [cmd, args] of candidates) {
    const r = spawnSync(cmd, args, { encoding: 'utf8' })
    if (r.error || (r.status !== 0 && /not recognized|not found|No such file/i.test(r.stderr ?? ''))) continue
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}\n${r.stdout}${r.stderr}`)
    ran++
  }
  if (!ran) t.skip('no external zip tool available')
})
