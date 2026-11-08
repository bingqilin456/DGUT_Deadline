# 优学院 LMS 登录故障报告

> 供向**东莞理工学院 现代教育技术中心**反馈使用。
> 报告内容全部来自实际测试，不含任何个人账号信息。
>
> 测试时间：2026-11-08
> 测试环境：Windows 11 x64 · Microsoft Edge 156.0.4314.58 · 校内网络（`莞工全光无线`）
> 测试方式：浏览器直接访问 + 前端代码静态分析 + 完整登录链路抓包

---

## 一、问题概述

**优学院（Ulearning）平台当前无法正常登录**，且经中央认证（CAS）登录后，
SSO 授权无法传递到优学院，导致用户无法进入课程与作业。

影响范围：所有需要通过优学院查看课程与作业的学生。

---

## 二、具体现象与证据

### 2.1 平台自身的登录入口返回 404

优学院页面右上角的「登录 / 注册」按钮，点击后跳转到：

```
https://lms.dgut.edu.cn/sld/pc.html#/login
```

该地址在服务端直接返回 **HTTP 404**（nginx 错误页，548 字节）。

实测所有相关登录路径：

| 路径 | HTTP 状态 |
|---|---|
| `/sld/pc.html` | **404** |
| `/sld/` | **404** |
| `/sld/index.html` | **404** |
| `/portal/login.html` | **404** |
| `/courseapi/login` | **404** |
| `/courseweb/ulearning/index.html` | 200（外壳正常） |

**即：优学院页面本身能打开，但点"登录"直接得到 404 页面。**

### 2.2 绕过它走中央认证也不行：授权不传递给优学院

`auth.dgut.edu.cn`（中央认证）本身工作正常，登录页可正常打开并能完成认证。
但**认证成功后，授权不会传递到优学院**。

实测链路：

```
访问优学院
  → 被引导到 application.dgut.edu.cn（应用中心/融合门户）
  → 跳转到 auth.dgut.edu.cn（中央认证）
  → 用户完成认证（成功，拿到 CASTGC 票据）
  → 被跳回 application.dgut.edu.cn（应用中心）
  ✗ 到此为止，不再跳回优学院
  ✗ lms.dgut.edu.cn 域下的 AUTHORIZATION cookie 始终未被写入
```

结果：用户"已经登录了中央认证"，但再访问优学院仍然显示「登录 / 注册」。

### 2.3 登录按钮的跳转目标已失效

从优学院前端 `index.html` 的登录按钮事件可确认，其目标地址就是上文 2.1 中返回 404 的
`/sld/pc.html#/login`。该路径在当前部署下已不存在。

### 2.4 作业子系统对外不可达

优学院前端配置文件（`/courseweb/common/js/config.js`）中定义：

```js
var HOMEWORK_WEB_HOST = protocol + "homework" + hostDomain;      // homework.dgut.edu.cn
var HOMEWORK_API_HOST = protocol + "homeworkapi" + hostDomain;   // homeworkapi.dgut.edu.cn
```

实测：

| 域名 | 结果 |
|---|---|
| `homework.dgut.edu.cn` | HTTP 302 → `https://nic.dgut.edu.cn/ymwzd404.htm`（404） |
| `homeworkapi.dgut.edu.cn` | HTTP 302 → 同上 |

即作业子系统域名当前**未正确发布或仅限特定网络**。

### 2.5 疑似与 11 月初的系统维护有关

2026-11-04 至 11-08 期间，优学院整站返回 HTTP 503，并展示维护公告：

> 莞工融合式教学平台（优学院）技术团队将于 **11 月 4 日 — 11 月 8 日** 对系统开展更新与测试，
> 本次更新主要针对 **考试、作业板块**，更新期间将 **暂停服务**。

维护结束后站点恢复 200，但上述登录入口 404 与 SSO 不回跳问题随之出现。

---

## 三、已确认可用的替代路径（供参考）

经分析，DGUT 的认证中心**只接受来自应用中心 `application.dgut.edu.cn` 的 CAS 请求**，
因此存在一条可用链路：

```
1. 访问 CAS，service 参数指向应用中心：
   https://auth.dgut.edu.cn/authserver/login
     ?service=https%3A%2F%2Fapplication.dgut.edu.cn%2Fappapi%2Fcas%2Ffromcas
2. 完成中央认证（此步会成功，并签发 .dgut.edu.cn 域下的 AUTHORIZATION 与 token）
3. 在应用中心内点击「优学院」图标
   → 门户会在跳转 URL 中携带 ?AUTHORIZATION=<token>
   → 优学院前端据此完成登录
```

**实测**：执行第 1、2 步能正确拿到 `AUTHORIZATION` 与 `token`（32 位十六进制）；
执行第 3 步后优学院页面标题变为「我的首页」并显示用户名。

**但**：调用优学院 API 时仍返回

```json
{"code":2001,"message":"缺少访问token"}
```

说明 `token` cookie 未被正确写入 `lms.dgut.edu.cn` 域，SSO 的最后一段仍未打通。

---

## 四、希望协助确认/修复的问题

1. **`/sld/pc.html` 登录页返回 404**
   请确认该路径是否已在 11 月维护中变更；若是，请提供新的登录入口，或修复该路径。

2. **CAS 登录后不跳回优学院**
   请检查中央认证与优学院之间的 SSO 信任配置与会话传递是否正常。

3. **`token` cookie 未写入 `lms.dgut.edu.cn` 域**
   请确认应用中心跳转优学院时，`token` / `AUTHORIZATION` 的 cookie domain 配置是否正确。

4. **`homework.dgut.edu.cn` / `homeworkapi.dgut.edu.cn` 对外 404**
   请确认作业子系统是否已发布，或是否仅限特定网络（如校园网/VPN）访问。
   若仅限内网，请在学生端给出明确提示。

---

## 五、复现步骤（供技术人员验证）

1. 浏览器打开 `https://lms.dgut.edu.cn/courseweb/ulearning/index.html`
2. 点击右上角「登录 / 注册」
3. 观察：跳转到 `https://lms.dgut.edu.cn/sld/pc.html#/login`，页面显示 **404 Not Found**
4. 或：直接访问
   `https://auth.dgut.edu.cn/authserver/login?service=https%3A%2F%2Flms.dgut.edu.cn%2F`
   完成认证后观察：被跳转到 `application.dgut.edu.cn`，**不再回到优学院**
5. 再次访问优学院，仍显示「登录 / 注册」

---

## 六、附带说明

本报告由一个学生自用的桌面作业提醒程序在开发过程中产生。
该程序**仅做只读同步**（读取作业名称、课程、截止时间、提交状态），
**不提交作业、不修改任何学校系统数据、不采集账号密码、不绕过验证码或 MFA**。

因无法通过正常路径登录优学院，该程序的优学院接入已被阻塞，故提交此报告协助排查。
如需进一步的技术细节（如具体请求/响应样例，均已脱敏），可随时提供。
