"use strict";

// Unit tests for the announcement volume handling. They run without a Chromecast and
// without installed dependencies: the network modules are stubbed and the player status
// updates are fed in by hand.
//
// Run: node --test test-unit/

const { test } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const EventEmitter = require("events").EventEmitter;

// --- stub the modules that need the network or are not installed --------------------
const stubs = {
  "castv2-client": {
    DefaultMediaReceiver: { APP_ID: "CC1AD845" },
    Client: class { connect() {} once() {} on() {} close() {} },
  },
  "icy": {},
  "playlist-parser": {},
  "dev-null": function () {},
  "mime-types": { lookup() {} },
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return originalLoad.apply(this, arguments);
};

const logLines = [];
const log = {};
for (const level of ["debug", "info", "warn", "error"])
  log[level] = (...args) => logLines.push([level, args.join(" ")]);

const PersistentPlayer = require("../lib/persistentPlayer")(log);
const PersistentClient = require("../lib/persistentClient")(log);

// --- helpers ------------------------------------------------------------------------
const URL = "http://host/tts.mp3?ts=1";
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

// Stands in for PersistentClient. "device" is the real volume, "cache" what the cached
// status claims (undefined = no status yet).
class FakeClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.EVENT_STATUS = "clientStatus";
    this.EVENT_DISCONNECTED = "clientDisconnected";
    this.device = "device" in options ? options.device : 20;
    // An explicit "cache: undefined" means: no status received yet
    this.cache = "cache" in options ? options.cache : this.device;
    this.failRead = !!options.failRead;
    this.calls = [];
  }
  getStatus() { return this.cache === undefined ? undefined : { volume: { level: this.cache / 100 } }; }
  getVolume() { return this.cache === undefined ? 0 : this.cache; }
  getVolumePromise() {
    return this.failRead ? Promise.reject(new Error("not connected")) : Promise.resolve(this.device);
  }
  setVolumePromise(volume, force) {
    this.calls.push([volume, !!force]);
    this.device = volume;
    return Promise.resolve(volume);
  }
}

function setup(t, clientOptions) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const client = new FakeClient(clientOptions);
  const player = new PersistentPlayer("test", client);
  const loads = [];
  player.getDefaultPlayerPromise = () => Promise.resolve(player);
  player.playUrl = (url) => { loads.push(url); return Promise.resolve("loaded"); };
  const status = (playerState, extra = {}) => player._playerStatus(Object.assign({ playerState }, extra));
  const playing = (url = URL, duration = 2, currentTime = 0) =>
    status("PLAYING", { currentTime, media: { contentId: url, duration } });
  return { client, player, loads, status, playing };
}

// Tracks whether a promise has settled yet.
function track(promise) {
  const state = { settled: false, value: undefined, error: undefined };
  promise.then((v) => { state.settled = true; state.value = v; }, (e) => { state.settled = true; state.error = e; });
  return state;
}

const announcement = (volume, url = URL) => JSON.stringify({ url, volume });

// --- tests --------------------------------------------------------------------------
test("volume is kept for the whole announcement and restored afterwards", async (t) => {
  const { client, player, status, playing } = setup(t, { device: 20 });
  const result = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  assert.deepEqual(client.calls, [[55, true]]);

  // Loading: the player reports BUFFERING and IDLE before it plays. Not the end.
  status("BUFFERING", { media: { contentId: URL } });
  status("IDLE");
  await flush();
  assert.deepEqual(client.calls, [[55, true]], "must not restore while loading");
  assert.equal(result.settled, false);

  playing();
  await flush();
  assert.deepEqual(client.calls, [[55, true]], "must not restore while playing");

  status("IDLE", { idleReason: "FINISHED" });
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
  assert.equal(result.settled, true);
  assert.equal(result.value, "loaded");
  assert.equal(client.device, 20);
});

test("original volume comes from the device, not from a stale cache", async (t) => {
  const { client, player, status, playing } = setup(t, { device: 15, cache: 30 });
  player.playAnnouncementPromise(announcement(55));
  await flush();
  playing();
  status("IDLE");
  await flush();
  assert.deepEqual(client.calls, [[55, true], [15, true]]);
});

test("re-buffering during the announcement does not end it", async (t) => {
  const { client, player, status, playing } = setup(t);
  player.playAnnouncementPromise(announcement(55));
  await flush();
  playing();
  status("BUFFERING");
  await flush();
  assert.deepEqual(client.calls, [[55, true]]);
  status("PLAYING");
  status("IDLE");
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
});

test("other media loaded during the announcement ends it", async (t) => {
  const { client, player, status, playing } = setup(t);
  player.playAnnouncementPromise(announcement(55));
  await flush();
  playing();
  status("PLAYING", { media: { contentId: "http://radio/stream" } });
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
});

test("missing final status: restored when the duration has elapsed", async (t) => {
  const { client, player, playing } = setup(t);
  const result = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  playing(URL, 2, 0.5);           // 1.5 s left, plus 700 ms grace = 2200 ms
  t.mock.timers.tick(2199);
  await flush();
  assert.deepEqual(client.calls, [[55, true]], "one millisecond too early");
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
  assert.equal(result.settled, true);
});

test("announcement that never starts: volume restored after the start timeout", async (t) => {
  const { client, player, status } = setup(t);
  const result = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  status("BUFFERING", { media: { contentId: URL } });
  t.mock.timers.tick(14999);
  await flush();
  assert.deepEqual(client.calls, [[55, true]]);
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
  assert.equal(result.settled, true);
});

test("load error: volume restored and the error passed on", async (t) => {
  const { client, player } = setup(t);
  player.playUrl = () => Promise.reject(new Error("load failed"));
  const result = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
  assert.equal(result.error.message, "load failed");
});

test("restore waits for the reply to the announcement volume request", async (t) => {
  const { client, player } = setup(t);
  let releaseFirst;
  const original = client.setVolumePromise.bind(client);
  client.setVolumePromise = (volume, force) => {
    const reply = original(volume, force);
    if (client.calls.length > 1) return reply;
    return new Promise((resolve) => { releaseFirst = () => resolve(reply); });   // first reply is late
  };
  player.playUrl = () => Promise.reject(new Error("load failed"));
  const result = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  assert.deepEqual(client.calls, [[55, true]], "restore must not be sent before the first reply");
  assert.equal(result.settled, false);
  releaseFirst();
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
  assert.equal(result.error.message, "load failed");
});

test("device drops the restore request: sent again until the reply matches", async (t) => {
  const { client, player, status, playing } = setup(t);
  let dropped = 0;
  client.setVolumePromise = (volume, force) => {
    client.calls.push([volume, !!force]);
    if (volume === 20 && dropped < 1) { dropped++; return Promise.resolve(client.device); }  // ignored, replies old volume
    client.device = volume;
    return Promise.resolve(volume);
  };
  const result = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  playing();
  status("IDLE");
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
  assert.equal(result.settled, false, "not finished before the volume is confirmed");
  t.mock.timers.tick(299);
  await flush();
  assert.equal(client.calls.length, 2, "one millisecond too early for the retry");
  t.mock.timers.tick(1);
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true], [20, true]]);
  assert.equal(client.device, 20);
  assert.equal(result.settled, true);
});

test("device never takes the restore: gives up after 3 requests and still finishes", async (t) => {
  const { client, player, status, playing } = setup(t);
  client.setVolumePromise = (volume, force) => {
    client.calls.push([volume, !!force]);
    if (volume === 55) client.device = 55;
    return Promise.resolve(client.device);
  };
  const result = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  playing();
  status("IDLE");
  for (let i = 0; i < 5; i++) { await flush(); t.mock.timers.tick(300); }
  await flush();
  assert.deepEqual(client.calls, [[55, true], [20, true], [20, true], [20, true]]);
  assert.equal(result.settled, true);
});

test("second announcement waits and never takes the announcement volume as original", async (t) => {
  const { client, player, loads, status, playing } = setup(t, { device: 20 });
  const url2 = "http://host/tts.mp3?ts=2";
  const first = track(player.playAnnouncementPromise(announcement(55)));
  const second = track(player.playAnnouncementPromise(announcement(60, url2)));
  await flush();
  assert.deepEqual(loads, [URL], "second must not load while the first is active");

  playing();
  status("IDLE");
  await flush();
  assert.equal(first.settled, true);
  assert.deepEqual(loads, [URL, url2]);

  playing(url2);
  status("IDLE");
  await flush();
  assert.equal(second.settled, true);
  assert.deepEqual(client.calls, [[55, true], [20, true], [60, true], [20, true]]);
  assert.equal(client.device, 20);
});

test("failed announcement does not block the next one", async (t) => {
  const { client, player, status, playing } = setup(t);
  const bad = track(player.playAnnouncementPromise('{"volume":55}'));
  const good = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  assert.equal(bad.error, "json does not contain url field");
  playing();
  status("IDLE");
  await flush();
  assert.equal(good.settled, true);
  assert.deepEqual(client.calls, [[55, true], [20, true]]);
});

test("unknown original volume: the volume is not touched at all", async (t) => {
  const { client, player, status, playing } = setup(t, { cache: undefined, failRead: true });
  const result = track(player.playAnnouncementPromise(announcement(55)));
  await flush();
  playing();
  status("IDLE");
  await flush();
  assert.deepEqual(client.calls, []);
  assert.equal(result.settled, true);
});

test("device read fails but a cached status exists: cached volume is restored", async (t) => {
  const { client, player, status, playing } = setup(t, { cache: 25, failRead: true });
  player.playAnnouncementPromise(announcement(55));
  await flush();
  playing();
  status("IDLE");
  await flush();
  assert.deepEqual(client.calls, [[55, true], [25, true]]);
});

test("announcement without volume: no volume calls", async (t) => {
  const { client, player, status, playing } = setup(t);
  const result = track(player.playAnnouncementPromise(URL));
  await flush();
  playing();
  status("IDLE");
  await flush();
  assert.deepEqual(client.calls, []);
  assert.equal(result.settled, true);
});

test("client: forced volume is sent even if the cache already shows it", async () => {
  const client = new PersistentClient({ host: "h", name: "n", port: 1 });
  const sent = [];
  client._status = { volume: { level: 0.2 } };
  client._getConnectedClientPromise = () => Promise.resolve({});
  client._setVolumePromise = (c, volume) => { sent.push(volume); return Promise.resolve(volume); };

  await client.setVolumePromise(20);
  assert.deepEqual(sent, [], "unforced: same value as cache is skipped (unchanged behaviour)");
  await client.setVolumePromise(20, true);
  assert.deepEqual(sent, [20]);
  await client.setVolumePromise(30);
  assert.deepEqual(sent, [20, 30]);
});

// --- closing the connection ---------------------------------------------------------
// A Client double with the shape of castv2-client's PlatformSender: "client" is the castv2
// connection, which holds the socket. The device dropping the connection is replayed the way
// the two libraries do it: castv2 sets socket to null, castv2-client then sets client to null,
// and only after that the "close" listener of PersistentClient runs.
function closeSetup() {
  const client = new PersistentClient({ host: "h", name: "n", port: 1 });
  const calls = [];
  const socket = { destroy() { calls.push("socket.destroy"); } };
  const sender = new EventEmitter();
  sender.client = { socket };
  sender.close = () => { calls.push("sender.close"); };
  client._connecting_client = undefined;
  client._client = sender;
  let disconnected = 0;
  client.on(client.EVENT_DISCONNECTED, () => disconnected++);
  logLines.length = 0;
  return { client, sender, calls, disconnected: () => disconnected };
}
const errorsLogged = () => logLines.filter(([level]) => level === "error").map(([, text]) => text);

test("close: a live connection is closed, socket first", () => {
  const { client, calls, disconnected } = closeSetup();
  client._close();
  assert.deepEqual(calls, ["socket.destroy", "sender.close"]);
  assert.deepEqual(errorsLogged(), []);
  assert.equal(disconnected(), 1);
  assert.equal(client._client, undefined);
});

test("close: connection already released by the device -> no error, still disconnected", () => {
  const { client, sender, calls, disconnected } = closeSetup();
  sender.client.socket = null;
  sender.client = null;
  client._close();
  assert.deepEqual(calls, [], "nothing is closed twice");
  assert.deepEqual(errorsLogged(), [], "no 'Error disconnecting' line");
  assert.ok(logLines.some(([level, text]) => level === "debug" && /already closed/.test(text)), "noted at debug level");
  assert.equal(disconnected(), 1, "the disconnect event still fires, so the player notices");
  assert.equal(client._client, undefined, "and the client is cleared for the reconnect");
  assert.equal(client._status, undefined);
});

test("close: connection object left but its socket gone -> no error", () => {
  const { client, sender, calls, disconnected } = closeSetup();
  sender.client.socket = null;
  client._close();
  assert.deepEqual(calls, []);
  assert.deepEqual(errorsLogged(), []);
  assert.equal(disconnected(), 1);
});

test("close: an unexpected failure while closing is still logged as an error", () => {
  const { client, sender, disconnected } = closeSetup();
  sender.close = () => { throw new Error("boom"); };
  client._close();
  assert.equal(errorsLogged().length, 1);
  assert.match(errorsLogged()[0], /Error disconnecting.*boom/);
  assert.equal(disconnected(), 1);
});

test("close: nothing connected -> nothing happens", () => {
  const { client, calls, disconnected } = closeSetup();
  client._client = undefined;
  client._close();
  assert.deepEqual(calls, []);
  assert.deepEqual(errorsLogged(), []);
  assert.equal(disconnected(), 0);
});
