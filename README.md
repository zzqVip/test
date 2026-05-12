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
3. 在仓库根目录执行 `npm run serve:gaea`，浏览器打开（JWT 说明见下一步）  
   `http://localhost:9090/meeting/cmoxw20dd0007qm0d3ffepgk8?token=<从 Network 复制的 JWT>&numClients=5&clientInterval=300`  
   参数名也可用 `jwt=`，与脚本内等价；hash 里也支持同名键（后与前者合并时 hash 覆盖 search）。
4. **`token` / `jwt`（必选）**：若在控制台看到 **`connection.passwordRequired`**，说明 XMPP 走 **JWT 认证**。在正式入会页面的 **Network → 选中 `xmpp-websocket` → Headers** 里，WebSocket URL 形如  
   `wss://rtc.gaea-labs.com/xmpp-websocket?room=<id>&token=<jwt>`，把 `token=` 后的整段 JWT 粘到本地负载页 URL。**JWT 有过期时间**，失效后重新复制。
5. 参数 `numClients`、`clientInterval`：`channelLastN=-1` 时人数一大客户端压力很高，请酌情调小并发。

**配置对齐**：请以线上实际 WS/BOSH/MUC 为准（示例页默认为根路径 **`/xmpp-websocket`、`/http-bind`**、`muc.rtc.gaea-labs.com`）。若你与 Network 里的 URL 不一致，请直接改 [`meeting/cmoxw20dd0007qm0d3ffepgk8/index.html`](meeting/cmoxw20dd0007qm0d3ffepgk8/index.html) 内嵌 `config`。

**注意**：仅应在已授权的环境中调节并发；不要把长期有效的 JWT 写进可被提交的文档或仓库。

### 若仍为 `connection.passwordRequired`

- **未带或带错 JWT**（最常见）：对照 Network 里 `token=`。
- **`JitsiConnection` 需要 appId**：示例 `config.appId` 已与你们 `gaealabs_jitsi` 对齐；若签发方要求变更，与服务端保持一致。
- **WebSocket Origin**：浏览器发 `Origin: http://localhost:…`；若网关仅允许 `https://meeting.gaea-labs.com`，需在网关放行或同源部署负载页。
