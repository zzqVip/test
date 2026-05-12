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
3. 在仓库根目录执行 `npm run serve:gaea`，浏览器打开  
   `http://localhost:8080/meeting/cmoxw20dd0007qm0d3ffepgk8`
4. 参数 `numClients`、`clientInterval` 等：可用 **查询串**（`?numClients=5&clientInterval=300`）或 **hash**（`#numClients=5&clientInterval=300`），同名键时 hash 优先。`channelLastN=-1` 时人数一大客户端压力很高，请酌情调小并发。

**注意**：仅应在已授权的环境中调节并发；`locationURL` 等字段不会被本 load-test 脚本读取，房间名完全由当前浏览器 URL 路径决定。
