/**
 * Local static server + /api/v1 → https://api.gaea-labs.com proxy (avoids browser CORS).
 * Rewrites ACAO on responses; forwards Origin/Referer like meeting.gaea-labs.com for API checks.
 */
/* eslint-disable no-console */
const path = require('path');
const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');

const PORT = Number(process.env.PORT) || 5173;
const ROOT = path.resolve(__dirname, '..');
const API_ORIGIN = process.env.GAEA_API_ORIGIN || 'https://api.gaea-labs.com';

const app = express();

const proxyApi = createProxyMiddleware({
    target: API_ORIGIN,
    changeOrigin: true,
    secure: true,
    /** Mounted at /api/v1 — forwarded path lacks prefix; restore it for upstream. */
    pathRewrite: pathname => `/api/v1${pathname}`,
    onProxyReq(proxyReq, req) {
        proxyReq.setHeader('Origin', 'https://meeting.gaea-labs.com');
        proxyReq.setHeader('Referer', 'https://meeting.gaea-labs.com/');
    },
    onProxyRes(proxyRes, req) {
        const origin = req.headers.origin;

        proxyRes.headers['access-control-allow-origin'] = origin || '*';
        proxyRes.headers['access-control-allow-credentials'] = 'true';
        proxyRes.headers['access-control-allow-methods']
            = 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS';
        proxyRes.headers['access-control-allow-headers'] = req.headers['access-control-request-headers']
            || 'Accept,Accept-Language,Content-Type';
        proxyRes.headers['access-control-max-age'] = '86400';
    },
    logLevel: 'warn'
});

app.use('/api/v1', proxyApi);

/**
 * One HTML shell for every room id: client reads room from pathname.
 * Avoids copying meeting/<roomId>/ for each conference.
 * /meeting and /meeting/ — control panel only (meeting id from form).
 */
const MEETING_LOAD_SHELL = path.join(ROOT, 'meeting', 'cmoxw20dd0007qm0d3ffepgk8', 'index.html');

app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
        return next();
    }
    if (req.path === '/meeting' || req.path === '/meeting/') {
        return res.sendFile(MEETING_LOAD_SHELL, err => (err ? next() : undefined));
    }
    const ok = /^\/meeting\/[^/]+\/?$/.test(req.path);
    if (!ok) {
        return next();
    }
    res.sendFile(MEETING_LOAD_SHELL, err => (err ? next() : undefined));
});

app.use(express.static(ROOT, {
    index: [ 'index.html' ],
    extensions: [ 'html' ]
}));

/** Fallback: …/meeting/<room> → …/meeting/<room>/index.html */
app.get(/^\/(?!api\/).*/, (req, res, next) => {
    try {
        const rel = path.normalize(decodeURIComponent(req.path)).replace(/^(\.\.[\\/])+/, '');
        const candidate = path.join(ROOT, rel, 'index.html');

        if (!candidate.startsWith(ROOT)) {
            return next();
        }

        res.sendFile(candidate, err => {
            if (err) {
                next();
            }
        });
    } catch (e) {
        next();
    }
});

app.listen(PORT, () => {
    console.log(`Static root: ${ROOT}`);
    console.log(`Listening http://localhost:${PORT}`);
    console.log(`Proxy /api/v1 → ${API_ORIGIN}/api/v1 (Origin spoof meeting.gaea-labs.com)`);
});
