/*
 * inject.js — runs in the PAGE (MAIN) world at document_start.
 * Wraps window.WebSocket to (a) cache the game's poke snapshots and (b) expose
 * an outbound bridge so the content script can send game commands (teleport)
 * over the game's own live socket. Never opens a second socket.
 *
 * Bridge protocol (window.postMessage, same-origin):
 *   page -> content : { __pokeRoute: true, dir: "p2c", kind: "pokes", list: [...] }
 *   content -> page : { __pokeRoute: true, dir: "c2p", cmd: "send", payload: {...} }
 */
(function () {
  "use strict";
  if (window.__pokeRouteInjected) return;
  window.__pokeRouteInjected = true;

  var liveSocket = null;
  var NativeWS = window.WebSocket;

  function post(kind, data) {
    try {
      window.postMessage(Object.assign({ __pokeRoute: true, dir: "p2c", kind: kind }, data), window.location.origin);
    } catch (e) { /* ignore */ }
  }

  function handleFrame(raw) {
    if (typeof raw !== "string") return;
    if (raw.indexOf("pokes") === -1 && raw.indexOf("boosts") === -1) return; // cheap pre-filter
    var msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    if (!msg) return;
    if (msg.type === "pokes" && Array.isArray(msg.list)) post("pokes", { list: msg.list });
    else if (msg.type === "boosts" && Array.isArray(msg.boosts)) post("boosts", { boosts: msg.boosts });
  }

  function WrappedWS(url, protocols) {
    var ws = protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
    // only track the game socket (its URL carries a token + ws shard)
    if (typeof url === "string" && url.indexOf("/ws") !== -1) {
      liveSocket = ws;
      ws.addEventListener("message", function (ev) { handleFrame(ev.data); });
      ws.addEventListener("close", function () { if (liveSocket === ws) liveSocket = null; });
      post("socket", { ready: true });
    }
    return ws;
  }
  WrappedWS.prototype = NativeWS.prototype;
  WrappedWS.CONNECTING = NativeWS.CONNECTING;
  WrappedWS.OPEN = NativeWS.OPEN;
  WrappedWS.CLOSING = NativeWS.CLOSING;
  WrappedWS.CLOSED = NativeWS.CLOSED;
  window.WebSocket = WrappedWS;

  // outbound bridge: content script asks us to send a command over the live socket
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.__pokeRoute !== true || d.dir !== "c2p") return;
    if (d.cmd === "send" && d.payload) {
      if (liveSocket && liveSocket.readyState === NativeWS.OPEN) {
        try {
          liveSocket.send(JSON.stringify(d.payload));
          post("send-result", { ok: true, requestId: d.requestId });
        } catch (e) {
          post("send-result", { ok: false, error: String(e), requestId: d.requestId });
        }
      } else {
        post("send-result", { ok: false, error: "socket-not-open", requestId: d.requestId });
      }
    } else if (d.cmd === "engine" && d.method) {
      // call a method on the game's world engine (e.g. loadMap) in the page context
      var eng = window.__engine;
      if (!eng || typeof eng[d.method] !== "function") {
        post("send-result", { ok: false, error: "engine-unavailable", requestId: d.requestId });
        return;
      }
      try {
        Promise.resolve(eng[d.method].apply(eng, d.args || []))
          .then(function () { post("send-result", { ok: true, requestId: d.requestId }); })
          .catch(function (err) { post("send-result", { ok: false, error: String(err), requestId: d.requestId }); });
      } catch (err) {
        post("send-result", { ok: false, error: String(err), requestId: d.requestId });
      }
    }
  });
})();
