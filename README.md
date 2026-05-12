# Jitsi Meet load testing utility

## Build and run
```
npm install
npm run build
```

To run it enable the nginx config by uncommenting it:
https://github.com/jitsi/jitsi-meet/blob/f34dde3376e849859420aeabe41549db0915c613/doc/debian/jitsi-meet/jitsi-meet.example#L116

Create folder on the server: `/usr/share/jitsi-meet/load-test/`
Copy in it:
```
libs
index.html 
```

## Gaea Meet：本地压测固定会议

本仓库已包含与线上一致的路径（房间名取自 pathname 末段）：

- 会议对标：[https://meeting.gaea-labs.com/meeting/cmoxw20dd0007qm0d3ffepgk8](https://meeting.gaea-labs.com/meeting/cmoxw20dd0007qm0d3ffepgk8)
- 页面与内嵌配置：`meeting/cmoxw20dd0007qm0d3ffepgk8/index.html`

步骤：

1. `npm install && npm run build`（生成 `libs/load-test-participant.min.js`，`libs/` 在 `.gitignore` 中，仅本地构建产物）。
2. 将与你线上一致的 **`lib-jitsi-meet.min.js`** 拷贝到仓库根目录下的 `libs/`（与官方 load-test 相同，来自你们 Jitsi Meet 构建的 `libs/`）。  
   **`libs/` 被 `.gitignore` 忽略**，克隆仓库后默认不会有该文件；无痕模式下也不会命中旧缓存，若 Network 里 **`/libs/lib-jitsi-meet.min.js` 一直是 404**，就说明这一步还没做或拷错路径。示例：  
   `cp /path/to/your/jitsi-meet/libs/lib-jitsi-meet.min.js libs/`
3. 在仓库根目录执行 **`npm run serve:gaea`**（代理依赖已在步骤 1 安装）。会在 **`http://localhost:9090`**（可用环境变量 **`PORT`** 改端口）提供静态文件，并把 **`/api/v1/…`** 反向代理到 **`https://api.gaea-labs.com`**；代理会改写响应 CORS 头，并把发往 API 的 **`Origin`/`Referer`** 设为 **`https://meeting.gaea-labs.com`**（与真实访客入会请求一致）。浏览器打开例如  
   `http://localhost:9090/meeting/cmoxw20dd0007qm0d3ffepgk8?numClients=5&clientInterval=300`
4. **入会 JWT（join-guest）**：页面跑在 **`localhost` / `127.0.0.1` / `::1`** 时，脚本会请求同源 **`POST /api/v1/meetings/<会议 id>/join-guest`**（即走上述代理），body `{"displayName":"<随机>"}`，用响应里的 **`jitsiJwt`**。若你在 **`config.gaeaLoadTest.joinGuestApiBaseUrl`** 写了完整 API 地址，则会**绕过代理直连**（需自行解决 CORS）。
5. 参数 `numClients`、`clientInterval`：可用查询串或 hash（hash 优先）。`channelLastN=-1` 时人数一大客户端压力很高，请酌情调小并发。

**配置对齐**：`hosts` / `bosh` / `websocket` 请以线上实际为准（示例页默认为根路径 **`/xmpp-websocket`、`/http-bind`**，`muc.rtc.gaea-labs.com`）。

**注意**：仅应在已授权的环境中调节并发。

### 若仍为 `connection.passwordRequired` 或 join-guest 失败

- **join-guest 401/403**：会议策略或访客接口权限；检查 meeting id、环境、是否需要 Cookie。
- **未使用本地代理**：不要用普通静态服务器只发 HTML —— 必须 **`npm run serve:gaea`**（或自行配置等价 **`/api/v1` → api.gaea-labs.com** 代理）。
- **`JitsiConnection` appId**：示例 `config.appId` 为 `gaealabs_jitsi`，需与签发 JWT 的约定一致。
- **WebSocket Origin**：若 XMPP 网关限制 Origin，需在网关放行 `http://localhost:9090` 或将负载页部署到 meeting 同源。
