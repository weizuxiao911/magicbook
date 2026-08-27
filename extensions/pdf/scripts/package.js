/**
 * 打包 PDF extension 为 .vsix
 * vsix = zip, 结构:
 *   extension/
 *     package.json
 *     dist/extension.js
 *   [Content_Types].xml
 */
const fs = require('fs')
const path = require('path')
const AdmZip = require('/Users/weizuxiao/Documents/开源项目/workspace-dev/registry/node_modules/adm-zip')

const ROOT = path.resolve(__dirname, '..')
const SRC_DIST = path.join(ROOT, 'dist')           // 源 dist
const PKG_PATH = path.join(ROOT, 'package.json')
const STAGE = path.join(ROOT, '.vsix-stage')       // 临时打包目录
const PKG = JSON.parse(fs.readFileSync(PKG_PATH, 'utf-8'))
const OUT = path.resolve(
  __dirname,
  '../../../registry/vsix',  // extensions/pdf/scripts → extensions/pdf → extensions → workspace-dev/registry/vsix
  `${PKG.publisher || 'numas'}.${PKG.name}-${PKG.version}.vsix`,
)

console.log('[pdf] packaging:', OUT)

// 1. 准备 staging 目录 (extension/ 内)
fs.rmSync(STAGE, { recursive: true, force: true })
fs.mkdirSync(path.join(STAGE, 'extension'), { recursive: true })

// 2. 复制 package.json + dist
fs.copyFileSync(PKG_PATH, path.join(STAGE, 'extension', 'package.json'))
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true })
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name)
    const d = path.join(dst, e.name)
    if (e.isDirectory()) copyDir(s, d)
    else fs.copyFileSync(s, d)
  }
}
copyDir(SRC_DIST, path.join(STAGE, 'extension', 'dist'))

// 3. [Content_Types].xml
fs.writeFileSync(
  path.join(STAGE, '[Content_Types].xml'),
  '<?xml version="1.0" encoding="utf-8"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '  <Default Extension="json" ContentType="application/json"/>\n' +
    '  <Default Extension="js" ContentType="application/javascript"/>\n' +
    '</Types>\n',
)

// 4. zip
fs.mkdirSync(path.dirname(OUT), { recursive: true })
const zip = new AdmZip()
zip.addLocalFolder(STAGE)
zip.writeZip(OUT)

// 5. 清理 staging
fs.rmSync(STAGE, { recursive: true, force: true })

console.log('[pdf] packaged:', OUT, '(' + (fs.statSync(OUT).size / 1024).toFixed(1) + ' KB)')
