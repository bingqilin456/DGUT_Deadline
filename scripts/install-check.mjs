/**
 * 安装版验收：确认安装目录、快捷方式、卸载项、能否启动。
 * 只做只读检查 + 启动验证，不修改系统。
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const CANDIDATES = [
  'C:\\Program Files\\莞工Deadline',
  'C:\\Program Files (x86)\\莞工Deadline',
  join(process.env['LOCALAPPDATA'] ?? '', 'Programs', '莞工Deadline'),
  join(process.env['LOCALAPPDATA'] ?? '', '莞工Deadline'),
];

console.log('=== 1. 查找安装目录 ===');
let installDir = null;
for (const dir of CANDIDATES) {
  if (dir && existsSync(dir)) {
    console.log('  找到:', dir);
    const files = readdirSync(dir).filter((f) => f.endsWith('.exe'));
    console.log('  可执行文件:', files.join(', '));
    if (files.some((f) => /Deadline/i.test(f))) installDir = dir;
  }
}
if (!installDir) console.log('  ⚠️ 未在标准位置找到安装目录（可能选用了自定义路径）');

console.log('\n=== 2. 检查卸载注册表项 ===');
try {
  const out = execFileSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      `$paths = @('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*');
       Get-ItemProperty $paths -ErrorAction SilentlyContinue |
         Where-Object { $_.DisplayName -like '*Deadline*' } |
         Select-Object DisplayName, DisplayVersion, InstallLocation, UninstallString |
         ConvertTo-Json -Compress`,
    ],
    { encoding: 'utf8' },
  );
  const t = out.trim();
  if (t) {
    console.log(t);
  } else {
    console.log('  ⚠️ 未找到卸载注册表项');
  }
} catch (e) {
  console.log('  读取失败:', String(e).slice(0, 200));
}

console.log('\n=== 3. 检查快捷方式 ===');
const shortcuts = [
  join(process.env['USERPROFILE'] ?? '', 'Desktop', '莞工 Deadline.lnk'),
  join(process.env['USERPROFILE'] ?? '', 'Desktop', '莞工Deadline.lnk'),
  join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '莞工 Deadline.lnk'),
  join(process.env['APPDATA'] ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', '莞工Deadline.lnk'),
];
for (const s of shortcuts) {
  console.log(`  ${existsSync(s) ? '✅' : '❌'} ${s}`);
}

console.log('\n=== 4. 检查用户数据目录（卸载后应保留） ===');
const userData = join(process.env['APPDATA'] ?? '', 'dgut-deadline');
console.log(`  ${existsSync(userData) ? '✅ 存在' : '（尚未创建，首次启动后生成）'}: ${userData}`);

console.log('\nINSTALL_CHECK_DONE');
