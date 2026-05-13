/* global $, config, JitsiMeetJS */

import jwtDecode from 'jwt-decode';
import _ from 'lodash';
import 'jquery';
import Logger, { getLogger } from '@jitsi/logger';

import { setConfigFromURLParams } from './configUtils';
import { parseURLParams } from './parseURLParams';
import { getBackendSafeRoomName, safeDecodeURIComponent } from './uri';
import { validateLastNLimits, limitLastN } from './lastN';
import JitsiMeetInMemoryLogStorage from './JitsiMeetInMemoryLogStorage';

const logger = getLogger('load-test-client');

setConfigFromURLParams(config, {}, {}, window.location);

/**
 * URL / hash 布尔参数（Bourne 可能解析成 boolean，也可能是字符串）。
 */
function parseUrlBool(value, defaultValue) {
    if (value === undefined || value === null) {
        return defaultValue;
    }
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'number') {
        return value !== 0;
    }
    const s = String(value).trim().toLowerCase();

    if (s === 'false' || s === '0' || s === 'no' || s === 'off') {
        return false;
    }
    if (s === 'true' || s === '1' || s === 'yes' || s === 'on') {
        return true;
    }

    return defaultValue;
}

// Load-test controls: allow both ?query and #hash (hash wins on same key).
// 默认模拟「听课端」：不采集本地音视频，但订阅远端（主讲码流）；轻量信令压测请设 isHuman=false 或 remoteVideo=false&remoteAudio=false。
const params = {
    ...parseURLParams(window.location, false, 'search'),
    ...parseURLParams(window.location, false, 'hash')
};

const hasIsHumanKey = Object.prototype.hasOwnProperty.call(params, 'isHuman');
let remoteVideoDefault = true;
let remoteAudioDefault = true;

if (hasIsHumanKey && !parseUrlBool(params.isHuman, false)) {
    remoteVideoDefault = false;
    remoteAudioDefault = false;
}

const {
    autoPlayVideo = config.testing.noAutoPlayVideo !== true,
    stageView = config.disableTileView
} = params;

const localVideo = parseUrlBool(params.localVideo, false);
const localAudio = parseUrlBool(params.localAudio, false);
const remoteVideo = parseUrlBool(params.remoteVideo, remoteVideoDefault);
const remoteAudio = parseUrlBool(params.remoteAudio, remoteAudioDefault);

/** 媒体行为（仍可由 URL 覆盖）；每次 Start 时传给 LoadTestClient */
const mediaOpts = {
    localVideo,
    localAudio,
    remoteVideo,
    remoteAudio,
    autoPlayVideo,
    stageView
};

function parsePositiveInt(value, fallback, max = Infinity) {
    const n = Number.parseInt(String(value), 10);

    if (!Number.isFinite(n) || n < 1) {
        return fallback;
    }

    return Math.min(n, max);
}

function parseNonNegativeInt(value, fallback) {
    const n = Number.parseInt(String(value), 10);

    if (!Number.isFinite(n) || n < 0) {
        return fallback;
    }

    return n;
}

/** 仅用于表单预填的 pathname 会议 id（例如 /meeting/abc/） */
function getMeetingIdPathHint() {
    const m = window.location.pathname.match(/^\/meeting\/([^/]+)\/?$/u);

    return m && m[1] && m[1] !== 'meeting' ? safeDecodeURIComponent(m[1]) : '';
}

/** 当前一次压测运行（点击「开始」时写入） */
let activeRoomName = '';
let activeMeetingApiId = '';
let activeNumClients = 1;
let activeClientInterval = 100;
/** true = 按固定间隔发起入会，不等待上一路成功；false = 上一路 CONFERENCE_JOINED 后再开下一路 */
let activeConcurrentMode = false;
let loadTestRunning = false;
let scheduleNextClientTimer = null;
/** 并发模式下按间隔发射 join 的定时器 */
let concurrentJoinIntervalId = null;

function clearLoadTestSchedulers() {
    if (scheduleNextClientTimer) {
        clearTimeout(scheduleNextClientTimer);
        scheduleNextClientTimer = null;
    }
    if (concurrentJoinIntervalId !== null) {
        clearInterval(concurrentJoinIntervalId);
        concurrentJoinIntervalId = null;
    }
}

function isLocalDevHostname(hostname) {
    return hostname === 'localhost'
        || hostname === '127.0.0.1'
        || hostname === '[::1]'
        || hostname === '::1';
}

/**
 * Join-guest URL prefix: full origin + /api/v1, or same-origin /api/v1 (local proxy).
 */
function getJoinGuestUrlPrefix() {
    const g = config.gaeaLoadTest || {};

    if (g.joinGuestApiBaseUrl != null && String(g.joinGuestApiBaseUrl).trim() !== '') {
        return `${String(g.joinGuestApiBaseUrl).replace(/\/$/, '')}/api/v1`;
    }

    const fallback = config.meetingHostAuth?.apiBaseUrl
        || config.gaeaMeetingConsole?.apiBaseUrl
        || 'https://api.gaea-labs.com';

    if (typeof window !== 'undefined' && isLocalDevHostname(window.location.hostname)) {
        return '/api/v1';
    }

    return `${String(fallback).replace(/\/$/, '')}/api/v1`;
}

/**
 * POST /api/v1/meetings/:id/join-guest — returns jitsiJwt for lib-jitsi.
 */
async function fetchGuestJwt(meetingId, displayName) {
    const prefix = getJoinGuestUrlPrefix();
    const url = `${prefix}/meetings/${encodeURIComponent(meetingId)}/join-guest`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ displayName }),
        mode: 'cors',
        credentials: 'omit'
    });
    const bodyText = await res.text();

    if (!res.ok) {
        throw new Error(`join-guest HTTP ${res.status}: ${bodyText.slice(0, 500)}`);
    }
    let data;

    try {
        data = JSON.parse(bodyText);
    } catch (e) {
        throw new Error(`join-guest: invalid JSON: ${bodyText.slice(0, 200)}`);
    }
    if (!data.jitsiJwt) {
        throw new Error('join-guest: response missing jitsiJwt');
    }

    return data.jitsiJwt;
}

function randomGuestDisplayName(participantId) {
    const r = Math.random().toString(36).slice(2, 10);
    const t = Date.now().toString(36).slice(-6);

    return `loadtest-p${participantId}-${t}-${r}`;
}

function appendURLParam(url, name, value) {
    const newUrl = new URL(url);

    newUrl.searchParams.append(name, value);

    return newUrl.toString();
}


function resolveMeetingFromUserInput(input) {
    const trimmed = String(input ?? '').trim();

    if (!trimmed) {
        return { ok: false, message: '请填写会议 ID' };
    }
    const meetingApiId = safeDecodeURIComponent(trimmed);
    const roomName = getBackendSafeRoomName(trimmed) || meetingApiId.toLowerCase();

    if (!roomName || !meetingApiId) {
        return { ok: false, message: '会议 ID 无效' };
    }

    return { ok: true, roomName, meetingApiId };
}


class LoadTestClient {
    constructor(id, config, run) {
        this.id = id;
        this.connection = null;
        this.dataChannelOpen = false;
        this.room = null;
        this.numParticipants = 1;
        this.localTracks = [];
        this.remoteTracks = {};
        this.onStageParticipant = null;
        this.config = config;
        this.roomName = run.roomName;
        this.meetingApiId = run.meetingApiId;
        this.localVideo = run.localVideo;
        this.localAudio = run.localAudio;
        this.remoteVideo = run.remoteVideo;
        this.remoteAudio = run.remoteAudio;
        this.autoPlayVideo = run.autoPlayVideo;
        this.stageView = run.stageView;
        this.visitor = false;
        /** 只在一轮压测里为「串行下一路」通知一次，避免 visitor 重连再次触发 */
        this._loadTestJoinNotified = false;
        this.receiverConstraints = { onStageSources: [], defaultConstraints: {} };

        this.updateConfig();
    }

    updateConfig() {
        const room = this.roomName || '';

        this.config.serviceUrl = this.config.bosh
            = appendURLParam(this.config.websocket || this.config.bosh, 'room', room.toLowerCase());
        if (this.config.websocketKeepAliveUrl) {
            this.config.websocketKeepAliveUrl = appendURLParam(this.config.websocketKeepAliveUrl, 'room', room.toLowerCase());
        }
    }

    /**
     * Simple emulation of jitsi-meet's receiver constraints behavior
     */
    updateReceiverConstraints(force = false) {
        if (!this.dataChannelOpen) {

            return;
        }

        let newMaxFrameHeight;

        if (this.stageView) {
            newMaxFrameHeight = 2160;
        }
        else {
            if (this.numParticipants <= 2) {
                newMaxFrameHeight = 720;
            } else if (this.numParticipants <= 4) {
                newMaxFrameHeight = 360;
            } else {
                newMaxFrameHeight = 180;
            }
        }

        let lastN = typeof this.config.channelLastN === 'undefined' ? -1 : this.config.channelLastN;

        const limitedLastN = limitLastN(this.numParticipants, validateLastNLimits(this.config.lastNLimits));

        if (limitedLastN !== undefined) {
            lastN = lastN === -1 ? limitedLastN : Math.min(limitedLastN, lastN);
        }

        let onStageSource;

        if (this.onStageParticipant) {
            const onStageParticipantTrack = this.room.jvbJingleSession?.peerconnection?.getRemoteTracks(this.onStageParticipant)?.find(track => track.getType() === 'video');
            if (onStageParticipantTrack) {
                onStageSource = onStageParticipantTrack.getSourceName();
            }
        }

        if (this.room) {
            if (force
                || this.receiverConstraints.lastN !== lastN
                || this.receiverConstraints.defaultConstraints.maxHeight !== newMaxFrameHeight
                || this.receiverConstraints.onStageSources[0] !== onStageSource) {
                    const newConstraints = _.cloneDeep(this.receiverConstraints);

                    newConstraints.lastN = lastN;
                    newConstraints.defaultConstraints.maxHeight = newMaxFrameHeight;
                    if (onStageSource) {
                        newConstraints.onStageSources[0] = onStageSource;
                    }
                    else {
                        newConstraints.onStageSources = [];
                    }

                    this.room.setReceiverConstraints(newConstraints);
                 }
        }
    }

    /**
     * Helper function to query whether a participant ID is a valid ID
     * for stage view.
     */
    isValidStageViewParticipant(id) {
        return (id !== this.room.myUserId() && this.room.getParticipantById(id));
    }

    /**
     * Simple emulation of jitsi-meet's stage view participant selection behavior.
     * Doesn't take into account pinning or screen sharing, and the initial behavior
     * is slightly different.
     * @returns Whether the on stage participant changed.
     */
    selectStageViewParticipant(selected, previous) {
        let newOnStageParticipant;

        if (this.isValidStageViewParticipant(selected)) {
            newOnStageParticipant = selected;
        }
        else {
            newOnStageParticipant = previous.find(pid => this.isValidStageViewParticipant(pid));
        }
        if (newOnStageParticipant && newOnStageParticipant !== this.onStageParticipant) {
            this.onStageParticipant = newOnStageParticipant;
            return true;
        }
        return false;
    }

    muteAudio(mute) {
        this.localAudio = !mute;

        let localAudioTrack = this.room.getLocalAudioTrack();

        if (mute) {
            localAudioTrack?.mute();
        }
        else {
            if (this.visitor) {
                logger.warn(`Participant ${this.id}: In visitor mode, not unmuting audio.`);
                return;
            }
            if (localAudioTrack) {
                localAudioTrack.unmute();
            }
            else {
                // See if we created it but haven't added it.
                localAudioTrack = this.localTracks.find(track => track.getType() === 'audio')
                if (localAudioTrack) {
                    localAudioTrack.unmute();
                    this.room.replaceTrack(null, localAudioTrack);
                }
                else {
                    JitsiMeetJS.createLocalTracks({ devices: ['audio'] })
                        .then(([audioTrack]) => audioTrack)
                        .catch(logger.error)
                        .then(audioTrack => {
                            return this.room.addTrack(audioTrack);
                        })
                }
            }
        }
    }

    /**
     * Called when number of participants changes.
     */
    setNumberOfParticipants() {
        if (this.id === 0) {
            $('#participants').text(this.numParticipants);
        }
        this.updateReceiverConstraints();
    }

    /**
     * Called when ICE connects
     */
    onDataChannelOpened() {
        this.dataChannelOpen = true;

        this.updateReceiverConstraints();
    }

    /**
     * Handles dominant speaker changed.
     * @param id
     */
    onDominantSpeakerChanged(selected, previous) {
        if (this.selectStageViewParticipant(selected, previous)) {
            this.updateReceiverConstraints();
        }
    }

    /**
     * Handles local tracks.
     * @param tracks Array with JitsiTrack objects
     */
    onLocalTracks(tracks = []) {
        this.localTracks = tracks;
        for (let i = 0; i < this.localTracks.length; i++) {
            if (this.localTracks[i].getType() === 'video') {
                if (this.id === 0) {
                    $('body').append(`<video ${this.autoPlayVideo ? 'autoplay="1" ' : ''}id='localVideo${i}' />`);
                    this.localTracks[i].attach($(`#localVideo${i}`)[0]);
                }

                this.room.addTrack(this.localTracks[i]);
            } else {
                if (this.localAudio) {
                    this.room.addTrack(this.localTracks[i]);
                } else {
                    this.localTracks[i].mute();
                }

                if (this.id === 0) {
                    $('body').append(
                        `<audio autoplay='1' muted='true' id='localAudio${i}' />`);
                    this.localTracks[i].attach($(`#localAudio${i}`)[0]);
                }
            }
        }
    }

    /**
     * Handles remote tracks
     * @param track JitsiTrack object
     */
    onRemoteTrack(track) {
        if (track.isLocal()
            || (track.getType() === 'video' && !this.remoteVideo) || (track.getType() === 'audio' && !this.remoteAudio)) {
            return;
        }
        const participant = track.getParticipantId();

        if (!this.remoteTracks[participant]) {
            this.remoteTracks[participant] = [];
        }

        if (this.id !== 0) {
            return;
        }

        const idx = this.remoteTracks[participant].push(track);
        const id = participant + track.getType() + idx;

        if (track.getType() === 'video') {
            $('body').append(`<video autoplay='1' id='${id}' />`);
        } else {
            $('body').append(`<audio autoplay='1' id='${id}' />`);
        }
        track.attach($(`#${id}`)[0]);
    }

    /**
     * That function is executed when the conference is joined
     */
    onConferenceJoined() {
        logger.log(`Participant ${this.id} Conference joined`);

        // Delay processing USER_JOINED events until the MUC is fully joined,
        // otherwise the apparent conference size will be wrong.
        this.numParticipants = this.room.getParticipantCount();
        this.setNumberOfParticipants();
        this.room.on(JitsiMeetJS.events.conference.USER_JOINED, this.onUserJoined.bind(this));
        this.room.on(JitsiMeetJS.events.conference._MEDIA_SESSION_STARTED, this.onMediaSessionStarted.bind(this));

        /* 串行压测：上一路 CONFERENCE_JOINED 后再启动下一路（visitor 二次入会不重复调度）；并发模式不按入会调度 */
        if (!activeConcurrentMode && !this._loadTestJoinNotified) {
            this._loadTestJoinNotified = true;
            scheduleNextClientAfterJoined(this.id);
        }
    }

    /**
     * Handles start muted events, when audio and/or video are muted due to
     * startAudioMuted or startVideoMuted policy.
     */
    onStartMuted() {
        // Give it some time, as it may be currently in the process of muting
        setTimeout(() => {
            const localAudioTrack = this.room.getLocalAudioTrack();

            if (this.localAudio && localAudioTrack && localAudioTrack.isMuted()) {
                localAudioTrack.unmute();
            }

            const localVideoTrack = this.room.getLocalVideoTrack();

            if (this.localVideo && localVideoTrack && localVideoTrack.isMuted()) {
                localVideoTrack.unmute();
            }
        }, 2000);
    }

    /**
     *
     * @param id
     */
    onUserJoined(id) {
        this.numParticipants++;
        this.setNumberOfParticipants();
        this.remoteTracks[id] = [];
    }

    /**
     * Media session started.
     */
    onMediaSessionStarted() {
        this.updateReceiverConstraints(true);
    }

    /**
     *
     * @param id
     */
    onUserLeft(id) {
        this.numParticipants--;
        this.setNumberOfParticipants();
        if (!this.remoteTracks[id]) {
            return;
        }

        if (this.id !== 0) {
            return;
        }

        const tracks = this.remoteTracks[id];

        for (let i = 0; i < tracks.length; i++) {
            const container = $(`#${id}${tracks[i].getType()}${i + 1}`)[0];

            if (container) {
                tracks[i].detach(container);
                container.parentElement.removeChild(container);
            }
        }
    }

    /**
     * Handles private messages.
     *
     * @param {string} id - The sender ID.
     * @param {string} text - The message.
     * @returns {void}
     */
    onPrivateMessage(id, text) {
        switch (text) {
            case 'video on':
                this.onVideoOnMessage();
                break;
        }
    }

    /**
     * Handles 'video on' private messages.
     *
     * @returns {void}
     */
    onVideoOnMessage() {
        if (this.visitor) {
            logger.warn(`Participant ${this.id}: In visitor mode, not turning video on.`);
            return;
        }

        logger.debug(`Participant ${this.id}: Turning my video on!`);

        const localVideoTrack = this.room.getLocalVideoTrack();

        if (localVideoTrack && localVideoTrack.isMuted()) {
            logger.debug(`Participant ${this.id}: Unmuting existing video track.`);
            localVideoTrack.unmute();
        } else if (!localVideoTrack) {
            JitsiMeetJS.createLocalTracks({ devices: ['video'] })
                .then(([videoTrack]) => videoTrack)
                .catch(logger.error)
                .then(videoTrack => {
                    return this.room.replaceTrack(null, videoTrack);
                })
                .then(() => {
                    logger.debug(`Participant ${this.id}: Successfully added a new video track for unmute.`);
                });
        } else {
            logger.log(`Participant ${this.id}: No-op! We are already video unmuted!`);
        }
    }

    onConferenceFailed(error, vnode, from) {
        if (error !== JitsiMeetJS.errors.conference.REDIRECTED) {
            logger.error(error);
            return;
        }
    }

    onConnectionRedirected(vnode, focusJid) {
        logger.log(`Participant ${this.id}: redirecting to visitor node ${vnode} with focusJid=${focusJid}`);
        this.connection.disconnect().then(() => {
            this.visitor = true;
            const oldDomain = this.config.hosts.domain;

            this.config.hosts.domain = `${vnode}.meet.jitsi`;
            //this.config.visitorTo = `${roomName.toLowerCase()}@${this.config.hosts.muc}`;
            this.config.hosts.muc = this.config.hosts.muc.replace(oldDomain, this.config.hosts.domain);
            this.config.focusUserJid = focusJid;
            this.config.disableFocus = true;

            this.config.bosh = appendURLParam(this.config.bosh, "vnode", vnode);
            this.config.websocket = appendURLParam(this.config.websocket, "vnode", vnode);
            this.config.websocketKeepAliveUrl = appendURLParam(this.config.websocketKeepAliveUrl, "vnode", vnode);

            this.localTracks.forEach((track) => track.mute());

            this.updateConfig();
            this.connect().catch(err => logger.error(`Participant ${this.id}: reconnect failed`, err));
        });
    }

    /**
     * This function is called to connect.
     */
    async connect() {
        this._onConnectionSuccess = this.onConnectionSuccess.bind(this)
        this._onConnectionFailed = this.onConnectionFailed.bind(this)
        this._onConnectionRedirected = this.onConnectionRedirected.bind(this)
        this._disconnect = this.disconnect.bind(this)

        let jwt;

        try {
            const displayName = randomGuestDisplayName(this.id);

            logger.info(`Participant ${this.id}: POST join-guest displayName=${displayName}`);
            jwt = await fetchGuestJwt(this.meetingApiId, displayName);
        } catch (e) {
            logger.error(`Participant ${this.id}: join-guest failed`, e);

            return;
        }

        let jwtPayload;

        try {
            jwtPayload = jwtDecode(jwt);
        } catch (e) {
            logger.error(e);
        }

        if (jwtPayload) {
            const { context } = jwtPayload;

            if (context?.user?.role === 'visitor') {
                this.config.preferVisitor = true;
            }
        }

        this.connection = new JitsiMeetJS.JitsiConnection(config.appId || null, jwt, this.config);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, this._onConnectionSuccess);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, this._onConnectionFailed);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED, this._disconnect);
        this.connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_REDIRECTED, this._onConnectionRedirected);
        this.connection.connect({ name: this.roomName });
    }

    /**
     * That function is called when connection is established successfully
     */
    onConnectionSuccess() {
        this.room = this.connection.initJitsiConference(this.roomName.toLowerCase(), this.config);
        this.room.on(JitsiMeetJS.events.conference.STARTED_MUTED, this.onStartMuted.bind(this));
        this.room.on(JitsiMeetJS.events.conference.TRACK_ADDED, this.onRemoteTrack.bind(this));
        this.room.on(JitsiMeetJS.events.conference.CONFERENCE_JOINED, this.onConferenceJoined.bind(this));
        this.room.on(JitsiMeetJS.events.conference.DATA_CHANNEL_OPENED, this.onDataChannelOpened.bind(this));
        this.room.on(JitsiMeetJS.events.conference.USER_LEFT, this.onUserLeft.bind(this));
        this.room.on(JitsiMeetJS.events.conference.PRIVATE_MESSAGE_RECEIVED, this.onPrivateMessage.bind(this));
        this.room.on(JitsiMeetJS.events.conference.CONFERENCE_FAILED, this.onConferenceFailed.bind(this));
        if (this.stageView) {
            this.room.on(JitsiMeetJS.events.conference.DOMINANT_SPEAKER_CHANGED, this.onDominantSpeakerChanged.bind(this));
        }

        const devices = [];

        if (!this.visitor) {
            if (this.localVideo) {
                devices.push('video');
            }

            if (!config.disableInitialGUM && this.localAudio) {
                devices.push('audio');
            }
        }

        if (devices.length > 0) {
            JitsiMeetJS.createLocalTracks({ devices })
                .then(this.onLocalTracks.bind(this))
                .then(() => {
                    this.room.join();
                })
                .catch(error => {
                    throw error;
                });
        } else {
            this.room.join();
        }
    }

    /**
     * This function is called when the connection fail.
     */
    onConnectionFailed(err) {
        logger.error(`Participant ${this.id}: Connection Failed`, err ?? '');
    }

    /**
     * This function is called when we disconnect.
     */
    disconnect() {
        logger.log('disconnect!');
        this.connection.removeEventListener(
            JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED,
            this._onConnectionSuccess);
        this.connection.removeEventListener(
            JitsiMeetJS.events.connection.CONNECTION_FAILED,
            this._onConnectionFailed);
        this.connection.removeEventListener(
            JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED,
            this._disconnect);
    }
}


let clients = [];

function buildRunOptions() {
    return {
        roomName: activeRoomName,
        meetingApiId: activeMeetingApiId,
        ...mediaOpts
    };
}

function disposeAllClients() {
    for (let j = 0; j < clients.length; j++) {
        for (let i = 0; i < clients[j].localTracks.length; i++) {
            clients[j].localTracks[i].dispose();
        }
        clients[j].room?.leave();
        clients[j].connection?.disconnect();
    }
    clients = [];
}

/**
 * 上一路已成功入会后再调度下一路；activeClientInterval 为入会后额外等待的 ms（缓解本机带宽）。
 */
function scheduleNextClientAfterJoined(completedIndex) {
    if (!loadTestRunning || activeConcurrentMode) {
        return;
    }
    if (completedIndex + 1 >= activeNumClients) {
        setLoadTestStatus(
            `运行中：已全部发起 ${activeNumClients} 路（串行：等上一路入会后再开下一路）`
        );

        return;
    }

    if (scheduleNextClientTimer) {
        clearTimeout(scheduleNextClientTimer);
        scheduleNextClientTimer = null;
    }

    scheduleNextClientTimer = setTimeout(() => {
        scheduleNextClientTimer = null;
        startClient(completedIndex + 1);
    }, activeClientInterval);
}

function startClient(i) {
    clients[i] = new LoadTestClient(i, JSON.parse(JSON.stringify(config)), buildRunOptions());

    clients[i].connect().catch(err => logger.error(`Participant ${i}: connect failed`, err));
    updateConnectedCountUi();
}

/**
 * 并发模式：每隔 activeClientInterval ms 调用一次 startClient（首路立即发起）；间隔 0 则在同一回合连续发起全部。
 */
function scheduleConcurrentClientLaunches() {
    let nextIndex = 0;

    startClient(nextIndex++);

    if (nextIndex >= activeNumClients) {
        setLoadTestStatus(`运行中：已发出入会请求 1 / ${activeNumClients}（并发模式）`);

        return;
    }

    const gapMs = activeClientInterval;

    if (gapMs <= 0) {
        while (nextIndex < activeNumClients) {
            startClient(nextIndex++);
        }
        setLoadTestStatus(
            `运行中：已在同一回合发出全部 ${activeNumClients} 路入会请求（并发模式；间隔 0 ms）`
        );

        return;
    }

    concurrentJoinIntervalId = setInterval(() => {
        if (!loadTestRunning) {
            clearInterval(concurrentJoinIntervalId);
            concurrentJoinIntervalId = null;

            return;
        }
        startClient(nextIndex++);

        if (nextIndex >= activeNumClients) {
            clearInterval(concurrentJoinIntervalId);
            concurrentJoinIntervalId = null;
            setLoadTestStatus(
                `运行中：已按每 ${gapMs} ms 发出全部 ${activeNumClients} 路入会请求（并发模式；不等待上一路成功）`
            );
        }
    }, gapMs);
}

function startLoadTest() {
    if (loadTestRunning) {
        return;
    }

    clearLoadTestSchedulers();
    if (clients.length > 0) {
        disposeAllClients();
    }

    const meetingEl = document.getElementById('lt-meeting-id');
    const resolved = resolveMeetingFromUserInput(meetingEl && meetingEl.value);

    if (!resolved.ok) {
        logger.warn(resolved.message);
        if (typeof window !== 'undefined' && window.alert) {
            window.alert(resolved.message);
        }

        return;
    }

    activeRoomName = resolved.roomName;
    activeMeetingApiId = resolved.meetingApiId;

    const nEl = document.getElementById('lt-num-clients');
    const iEl = document.getElementById('lt-interval');

    activeNumClients = parsePositiveInt(nEl && nEl.value, 1, 500);
    activeClientInterval = parseNonNegativeInt(iEl && iEl.value, 100);

    const concurrentRadio = document.getElementById('lt-mode-concurrent');

    activeConcurrentMode = Boolean(concurrentRadio && concurrentRadio.checked);

    loadTestRunning = true;
    updateLoadTestButtons();

    if (activeConcurrentMode) {
        setLoadTestStatus(
            `运行中：目标 ${activeNumClients} 路（并发；每 ${activeClientInterval} ms 发起一路入会，不等待成功）`
        );
        logger.info(
            `Load-test start room=${activeRoomName} numClients=${activeNumClients} concurrent=true intervalMs=${activeClientInterval}`
        );
        scheduleConcurrentClientLaunches();
    } else {
        setLoadTestStatus(`运行中：目标 ${activeNumClients} 路（串行；等第 0 路成功入会后再启动后续）`);
        logger.info(
            `Load-test start room=${activeRoomName} numClients=${activeNumClients} concurrent=false postJoinDelayMs=${activeClientInterval}`
        );
        startClient(0);
    }
}

function stopLoadTest() {
    clearLoadTestSchedulers();
    disposeAllClients();
    loadTestRunning = false;
    updateLoadTestButtons();
    setLoadTestStatus('已停止：所有客户端已断开');
}

function setLoadTestStatus(text) {
    const el = document.getElementById('lt-status');

    if (el) {
        el.textContent = text;
    }
}

function updateLoadTestButtons() {
    const start = document.getElementById('lt-start');
    const stop = document.getElementById('lt-stop');

    if (start) {
        start.disabled = loadTestRunning;
    }
    if (stop) {
        stop.disabled = !loadTestRunning;
    }
}

function updateConnectedCountUi() {
    if (!loadTestRunning) {
        return;
    }
    const launched = clients.filter(Boolean).length;

    if (activeConcurrentMode) {
        setLoadTestStatus(
            `运行中：已发起 ${launched} / ${activeNumClients} 路（并发；每隔 ${activeClientInterval} ms 发起一路，不等待成功）`
        );
    } else {
        setLoadTestStatus(
            `运行中：已发起 ${launched} / ${activeNumClients} 路（串行；入会后再开下一路，入会后间隔 ${activeClientInterval} ms）`
        );
    }
}

function initLoadTestPanel() {
    const mid = document.getElementById('lt-meeting-id');

    if (mid) {
        const fromPath = getMeetingIdPathHint();
        const pref = params.meetingId ?? params.room ?? fromPath;

        if (pref) {
            mid.value = String(pref);
        }
    }

    const nc = document.getElementById('lt-num-clients');

    if (nc != null && params.numClients !== undefined && params.numClients !== null && params.numClients !== '') {
        nc.value = String(parsePositiveInt(params.numClients, 1, 500));
    }

    const iv = document.getElementById('lt-interval');

    if (iv != null && params.clientInterval !== undefined && params.clientInterval !== null && params.clientInterval !== '') {
        iv.value = String(parseNonNegativeInt(params.clientInterval, 100));
    }

    const concurrent =
        params.concurrent === true
        || params.concurrent === '1'
        || params.concurrent === 'true'
        || String(params.loadTestMode ?? '').toLowerCase() === 'concurrent';
    const serialRadio = document.getElementById('lt-mode-serial');
    const concurrentRadio = document.getElementById('lt-mode-concurrent');

    if (concurrentRadio && serialRadio) {
        if (concurrent) {
            concurrentRadio.checked = true;
        } else {
            serialRadio.checked = true;
        }
    }

    const $start = $('#lt-start');
    const $stop = $('#lt-stop');

    if ($start.length) {
        $start.on('click', () => startLoadTest());
    }
    if ($stop.length) {
        $stop.on('click', () => stopLoadTest());
    }
    updateLoadTestButtons();
    setLoadTestStatus('就绪：填写会议 ID 后点击「开始压测」');
}

window.APP = {
    startLoadTest,
    stopLoadTest,

    getLoadTestState() {
        return {
            running: loadTestRunning,
            connected: clients.length,
            roomName: activeRoomName,
            meetingApiId: activeMeetingApiId,
            targetClients: activeNumClients,
            clientIntervalMs: activeClientInterval,
            concurrentMode: activeConcurrentMode
        };
    },

    conference: {
        getStats() {
            return clients[0]?.room?.connectionQuality.getStats();
        },
        getConnectionState() {
            return clients[0] && clients[0].room && clients[0].room.getConnectionState();
        },
        muteAudio(mute, num) {
            if (num === undefined) {
                for (let j = 0; j < clients.length; j++) {
                    clients[j].muteAudio(mute);
                }
            }
            else {
                clients[num].muteAudio(mute);
            }
        }
    },

    get room() {
        return clients[0]?.room;
    },
    get connection() {
        return clients[0]?.connection;
    },
    get numParticipants() {
        return clients[0]?.numParticipants;
    },
    get localTracks() {
        return clients[0]?.localTracks;
    },
    get remoteTracks() {
        return clients[0]?.remoteTracks;
    },
    get params() {
        return {
            roomName: activeRoomName,
            meetingApiId: activeMeetingApiId,
            localAudio: mediaOpts.localAudio,
            localVideo: mediaOpts.localVideo,
            remoteVideo: mediaOpts.remoteVideo,
            remoteAudio: mediaOpts.remoteAudio,
            autoPlayVideo: mediaOpts.autoPlayVideo,
            stageView: mediaOpts.stageView,
            numClients: activeNumClients,
            clientInterval: activeClientInterval,
            concurrent: activeConcurrentMode,
            loadTestMode: activeConcurrentMode ? 'concurrent' : 'serial'
        };
    }
};

/**
 *
 */
function unload() {
    clearLoadTestSchedulers();
    disposeAllClients();
    loadTestRunning = false;
}

$(window).bind('beforeunload', unload);
$(window).bind('unload', unload);

JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.TRACE);
APP.debugLogs = new JitsiMeetInMemoryLogStorage();
const debugLogCollector = new Logger.LogCollector(APP.debugLogs, { storeInterval: 1000 });

Logger.addGlobalTransport(debugLogCollector);
JitsiMeetJS.addGlobalLogTransport(debugLogCollector);
debugLogCollector.start();

JitsiMeetJS.init(config);

$(() => initLoadTestPanel());
