// The production export of m365-skill-pack: a standalone repository that holds only the
// skill, as a Claude Code plugin (with its own one-plugin marketplace) and as a GitHub
// Copilot skill directory. Nothing else from this repository goes in - no other assets, no
// test tooling, no OpenCode output, no GitHub workflows - because adding a Claude Code
// marketplace puts the whole marketplace repository on the machine, not just one plugin.
//
// Every exported file is scanned before anything is written: names of third-party model
// routes, network APIs and URLs outside an allow-list fail the export.

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

export const SKILL = 'm365-skill-pack'
export const MARKETPLACE = 'm365-skill-pack'

/** Hosts a production file may mention. Text only: no exported code fetches anything. */
export const URL_HOSTS = ['learn.microsoft.com', 'support.microsoft.com', 'www.microsoft.com']

/** Words that only belong to test tooling or to model routes the workplace forbids. */
export const FORBIDDEN = [
  /\bopencode\b/i, /\bopenrouter\b/i, /\bnemotron\b/i, /\bmimo-v/i, /\bbig-pickle\b/i,
  /\bM365_EMU/, /\bm365-emu\b/, /\bfake-(agent|human)\b/,
  /\banthropic\.com\b/i, /\bclaude\.ai\b/i, /\bapi\.openai\.com\b/i,
]

/** Calls that open a network connection, in the languages the skill ships. */
export const NETWORK = [
  /\bfetch\s*\(/, /\bhttps?\.(request|get)\s*\(/, /\bXMLHttpRequest\b/, /\bnew\s+WebSocket\b/,
  /\bnet\.(connect|createConnection)\s*\(/, /\burlopen\s*\(/, /\brequests\.(get|post|put|delete|head|request)\s*\(/,
  /\bhttp\.client\b/, /\bsocket\.(create_connection|socket)\s*\(/, /\bInvoke-(WebRequest|RestMethod)\b/, /\b(curl|wget)\s+-/,
]

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : [p]
  })
}

function copyTree(src, destPrefix) {
  return walk(src).map((p) => ({ path: `${destPrefix}/${relative(src, p).replace(/\\/g, '/')}`, data: readFileSync(p) }))
}

/** Problems found in the files; an empty list means the export may be written. */
export function scanFiles(files) {
  const problems = []
  for (const f of files) {
    if (f.path === 'EXPORT.json') continue
    const text = f.data.toString('utf8')
    for (const re of FORBIDDEN) if (re.test(text)) problems.push(`${f.path}: forbidden word ${re}`)
    for (const re of NETWORK) if (re.test(text)) problems.push(`${f.path}: network call ${re}`)
    for (const m of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/([^/\s)"'`>\]]+)/gi)) {
      const host = m[1].toLowerCase().replace(/:\d+$/, '')
      if (!URL_HOSTS.includes(host)) problems.push(`${f.path}: URL host not allowed: ${host}`)
    }
  }
  return problems
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Everything the production repository contains, as { path, data } with "/" paths.
 * `root` is this repository; `version` and `commit` describe the source.
 */
export function buildExport({ root, version, commit }) {
  const pluginSkill = join(root, 'plugins', 'toolkit-core', 'skills', SKILL)
  const copilotSkill = join(root, 'dist', 'copilot', 'skills', SKILL)
  const files = [
    ...copyTree(pluginSkill, `plugins/${SKILL}/skills/${SKILL}`),
    ...copyTree(copilotSkill, `copilot/skills/${SKILL}`),
  ]
  const json = (path, value) => files.push({ path, data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) })
  const text = (path, value) => files.push({ path, data: Buffer.from(value) })
  const description = 'Delegate implement-audit loops to Microsoft 365 Copilot custom agents (Agent Builder): task contract, input bundle, output ingest.'
  json('.claude-plugin/marketplace.json', {
    name: MARKETPLACE,
    owner: { name: 'nitro' },
    metadata: { description: 'Production-only distribution of m365-skill-pack.', version },
    plugins: [{ name: SKILL, source: `./plugins/${SKILL}`, description, version, category: 'productivity', keywords: ['microsoft-365-copilot', 'agent-builder', 'delegation'] }],
  })
  json(`plugins/${SKILL}/.claude-plugin/plugin.json`, { name: SKILL, description, version, author: { name: 'nitro' }, license: 'MIT', keywords: ['microsoft-365-copilot', 'agent-builder', 'delegation'] })
  text('.gitattributes', '* text=auto eol=lf\n*.zip binary\n')
  text('.gitignore', '# per-task working files of the m365-skill-pack skill (input/output bundles, reports)\n.m365/\n')
  files.push({ path: 'LICENSE', data: readFileSync(join(root, 'LICENSE')) })
  text('README.md', readmeText(version))
  files.sort((a, b) => a.path.localeCompare(b.path))
  const manifest = { source: 'agent-toolkit', sourceCommit: commit, version, files: Object.fromEntries(files.map((f) => [f.path, sha256(f.data)])) }
  files.push({ path: 'EXPORT.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) })
  return files
}

function readmeText(version) {
  return `# m365-skill-pack(本番用配布)

実装と監査の反復を Microsoft 365 Copilot のカスタムエージェント(Agent Builder)に任せ、
GitHub Copilot / Claude Code 側は「タスク契約を書く・入力バンドルを作る・結果を取り込む」だけにする
スキル \`m365-skill-pack\` の、本番用の配布物です(版 ${version})。

**このリポジトリは生成物です。直接編集しないでください。** 正本は agent-toolkit リポジトリの
\`shared/skills/m365-skill-pack\` で、\`npm run export:m365 -- <このリポジトリのパス>\` で作り直します。
\`EXPORT.json\` に、元のコミットと全ファイルの SHA-256 が入っています。

## 入っているもの

| 場所 | 内容 |
| --- | --- |
| \`plugins/m365-skill-pack/\` | Claude Code 用プラグイン(スキル 1 つだけ) |
| \`.claude-plugin/marketplace.json\` | 上のプラグインだけを載せたマーケットプレイス |
| \`copilot/skills/m365-skill-pack/\` | GitHub Copilot 用のスキル(中身は同じ) |

スキルの中身は、手順(\`SKILL.md\`)、日本語の手引き(\`README.md\`、\`m365/SETUP.md\`)、Agent Builder に貼る
エージェント定義シート、Agent Builder 用スキルの素材(Python、標準ライブラリのみ)、手元のスクリプト
(Node、標準モジュールのみ)、制約と規約の文書です。

## 入っていないもの

テスト用の模擬環境、第三者のモデル提供元(無料モデルなど)を使う経路、GitHub Actions のワークフロー、
その他のスキルやコマンドは入っていません。書き出し時に、外部のモデル提供元の名前、ネットワーク通信を行う API、
Microsoft の文書以外の URL が含まれていないことを検査しています。スキルのスクリプトはどれも
ネットワークに接続しません。

## 導入

**GitHub Copilot**: \`copilot/skills/m365-skill-pack\` を、使うリポジトリの \`.github/skills/m365-skill-pack\`、
または個人用の \`~/.copilot/skills/m365-skill-pack\` に置きます。

**Claude Code**: このリポジトリをマーケットプレイスとして追加し、プラグインを入れます。

\`\`\`text
/plugin marketplace add <このリポジトリ>
/plugin install m365-skill-pack@m365-skill-pack
\`\`\`

その後の初回セットアップ(Agent Builder でのエージェント作成と probe)は、スキル内の \`README.md\` と
\`m365/SETUP.md\` を見てください。

## データの行き先

| 何が | どこへ |
| --- | --- |
| リポジトリのファイル一式と \`_m365/TASK.md\`、\`CLAUDE.md\` / \`AGENTS.md\` / \`.github/copilot-instructions.md\` | Microsoft 365 Copilot(職場・学校アカウント、企業向けデータ保護あり)に、人が添付したときだけ |
| 入力・出力バンドルの写し | 環境変数 \`M365_DROP_DIR\` を設定したときだけ、そのフォルダ(職場の OneDrive を指すこと) |
| タスク契約、判定、差分 | 呼び出し元(GitHub Copilot / Claude Code) |

入力バンドルからは、\`.git\`・\`node_modules\`・ビルド出力・\`.env\` 類・鍵や証明書・資格情報ファイル
(\`.ssh/\` \`.aws/\` \`.azure/\` \`.npmrc\` \`.netrc\` \`*.tfstate\` など)を自動で除外します。プロジェクト固有の
秘密は \`make-input.mjs --exclude <glob>\` で足し、最初の数回はバンドルの中身を人が確認してください。
個人向けの無料 Copilot には企業向けデータ保護が無いので、バンドルを添付しないでください。
`
}

/** Compare an export with what is on disk: { missing, changed, extra } (paths). */
export function diffExport(files, outDir, onDisk) {
  const want = new Map(files.map((f) => [f.path, f.data]))
  const missing = []
  const changed = []
  for (const [p, data] of want) {
    if (!onDisk.has(p)) missing.push(p)
    else if (p !== 'EXPORT.json' && !onDisk.get(p).equals(data)) changed.push(p)
  }
  const extra = [...onDisk.keys()].filter((p) => !want.has(p))
  return { missing, changed, extra }
}
