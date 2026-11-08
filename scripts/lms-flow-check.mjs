import { spawn } from "node:child_process";
import { join } from "node:path";
const EXE = join(process.env.LOCALAPPDATA, "Programs", "dgut-deadline", "莞工Deadline.exe");
const child = spawn(EXE, ["--remote-debugging-port=9341"], { stdio: ["ignore","pipe","pipe"], env: { ...process.env, NODE_OPTIONS: "" } });
await new Promise(r => setTimeout(r, 7000));
const { chromium } = await import("playwright-core");
const b = await chromium.connectOverCDP("http://127.0.0.1:9341");
const ctx = b.contexts()[0];
const page = ctx.pages().find(p => !p.url().startsWith("devtools://")) ?? ctx.pages()[0];
await page.waitForTimeout(2500);
const r = await page.evaluate(async () => {
  try {
    const s = await window.dgut.login("ulearning");
    const l = s.sources.find(x => x.source === "ulearning");
    return { ok: true, state: l?.session?.state, message: (l?.session?.message ?? "").slice(0, 250) };
  } catch (e) { return { ok: false, error: String(e).slice(0, 250) }; }
});
console.log("LMS_LOGIN:", JSON.stringify(r, null, 2));
await new Promise(r2 => setTimeout(r2, 4000));
// 检查受控 Edge 打开了什么页面
const { execFileSync } = await import("node:child_process");
try {
  const out = execFileSync("powershell", ["-NoProfile","-Command",
    `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*dgut-deadline*' } | Select-Object -First 1 -ExpandProperty CommandLine`],
    { encoding: "utf8" });
  console.log("受控 Edge 使用 profile:", /--user-data-dir="?([^" ]+)/.exec(out)?.[1] ?? "未找到");
} catch {}
await b.close().catch(()=>{});
child.kill();
process.exit(0);
