/**
 * Silent room sync — word travels digitally (PeerJS), never through the speaker.
 * Audio stays a pure meditation bed.
 */
const MindwhisperSync = (() => {
  const PREFIX = "mw-";

  function normalizeRoom(raw) {
    return String(raw || "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 6);
  }

  function randomRoom() {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let out = "";
    for (let i = 0; i < 4; i++) {
      out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }
    return out;
  }

  function peerId(room) {
    return PREFIX + normalizeRoom(room);
  }

  function createHost(room, onStatus) {
    const id = peerId(room);
    const peer = new Peer(id, { debug: 0 });
    const connections = new Set();
    let lastPayload = null;

    peer.on("open", () => onStatus && onStatus("ready", { room: normalizeRoom(room), id }));
    peer.on("error", (err) => onStatus && onStatus("error", { message: err.type || String(err) }));
    peer.on("connection", (conn) => {
      connections.add(conn);
      conn.on("open", () => {
        onStatus && onStatus("peer", { count: connections.size });
        if (lastPayload) conn.send(lastPayload);
      });
      conn.on("close", () => {
        connections.delete(conn);
        onStatus && onStatus("peer", { count: connections.size });
      });
    });

    return {
      room: normalizeRoom(room),
      publish(word, meta = {}) {
        lastPayload = {
          type: "whisper",
          word: String(word || "").toUpperCase(),
          at: Date.now(),
          ...meta,
        };
        connections.forEach((conn) => {
          try {
            if (conn.open) conn.send(lastPayload);
          } catch (_) {}
        });
      },
      destroy() {
        try { peer.destroy(); } catch (_) {}
        connections.clear();
      },
    };
  }

  function createListener(room, onWord, onStatus) {
    const id = peerId(room);
    const peer = new Peer({ debug: 0 });
    let conn = null;
    let destroyed = false;

    function attach(c) {
      conn = c;
      c.on("open", () => onStatus && onStatus("linked"));
      c.on("data", (data) => {
        if (data && data.type === "whisper" && data.word) {
          onWord(data.word, data);
        }
      });
      c.on("close", () => {
        onStatus && onStatus("closed");
        if (!destroyed) reconnect();
      });
      c.on("error", () => {
        if (!destroyed) reconnect();
      });
    }

    function reconnect() {
      if (destroyed) return;
      onStatus && onStatus("connecting");
      try {
        const c = peer.connect(id, { reliable: true });
        attach(c);
      } catch (_) {
        setTimeout(reconnect, 1200);
      }
    }

    peer.on("open", () => reconnect());
    peer.on("error", (err) => onStatus && onStatus("error", { message: err.type || String(err) }));

    return {
      room: normalizeRoom(room),
      destroy() {
        destroyed = true;
        try { if (conn) conn.close(); } catch (_) {}
        try { peer.destroy(); } catch (_) {}
      },
    };
  }

  return { normalizeRoom, randomRoom, createHost, createListener };
})();

if (typeof window !== "undefined") {
  window.MindwhisperSync = MindwhisperSync;
}
