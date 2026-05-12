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
3. 在仓库根目录执行 `npm run serve:gaea`，浏览器打开  
   `http://localhost:9090/meeting/cmoxw20dd0007qm0d3ffepgk8`
4. 参数 `numClients`、`clientInterval` 等：可用 **查询串**（`?numClients=5&clientInterval=300`）或 **hash**（`#numClients=5&clientInterval=300`），同名键时 hash 优先。`channelLastN=-1` 时人数一大客户端压力很高，请酌情调小并发。

**注意**：仅应在已授权的环境中调节并发；`locationURL` 等字段不会被本 load-test 脚本读取，房间名完全由当前浏览器 URL 路径决定。

### 若 WebSocket 能连一会儿但控制台出现 `_sasl_failure_cb` / `Connection Failed`

常见原因是 **租户路径（path 前缀)** 下的 **`bosh` / `websocket` / `hosts.muc` 与线上一致**：

- URL 形如 `…/meeting/<会议 id>` 时，许多部署会使用  
  **`wss://<rtc-host>/meeting/xmpp-websocket`**、**`…/meeting/http-bind`**，且  
  **`muc` 为 `muc.meeting.<XMPP_DOMAIN>`**（租户名与路径第一段一致），而不是根路径的 `/xmpp-websocket` + `muc.<主域>`。  
  本仓库示例页 [`meeting/cmoxw20dd0007qm0d3ffepgk8/index.html`](meeting/cmoxw20dd0007qm0d3ffepgk8/index.html) 已按 **租户 `meeting`** 改过；若你们线上租户前缀不同请同步修改。
- 仍失败时请在**真实开会**的那一标签页开发者工具 Network 中选 **WS**，对照请求 URL、`config.hosts`、`config.bosh` 与本页内嵌是否一致。
- 从 **`http://localhost:…`** 连生产 XMPP 时，若服务端限制 **WebSocket Origin / CORS**，也可能表现为认证失败；可临时把负载页同源部署到 `meeting.gaea-labs.com`（推荐）或由运维放行本地 Origin。
