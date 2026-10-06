// Minimal zero-dependency RFC6455 WebSocket client over TLS.
// Exists because Node's global WebSocket cannot set handshake headers (we mirror
// the YonZone renderer: Origin file:// + subprotocol "xmpp"; auth itself is NOT
// a handshake cookie but the first application frame, see coach_headless.js).
//
// Deliberately NOT supported: permessage-deflate / any RSV extension. The real
// renderer advertises permessage-deflate, but the IM server does not negotiate
// it; if it ever did, our frame reader would mis-parse silently, so we now fail
// fast on a negotiated extension or an RSV bit instead of hanging until timeout.
'use strict';
const https = require('node:https');
const crypto = require('node:crypto');

const GUID_TAIL = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = null; // {opcode, chunks: []}
    this.onMessage = null;  // (data: Buffer, opcode: number) => void
    this.onClose = null;    // (code, reason) => void
    this.closed = false;
    socket.on('data', d => this._feed(d));
    const fail = e => this._closed(1006, String(e && e.message || e));
    socket.on('error', fail);
    socket.on('close', () => this._closed(1006, 'socket closed'));
    socket.on('end', () => this._closed(1006, 'socket end'));
  }

  _closed(code, reason) {
    if (this.closed) return;
    this.closed = true;
    try { this.socket.destroy(); } catch {}
    if (this.onClose) this.onClose(code, reason);
  }

  _feed(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (true) {
      const f = this._readFrame();
      if (!f) break;
      const { fin, rsv, opcode, payload } = f;
      if (rsv) { this._closed(1002, 'received RSV bit set (compressed frame?) - permessage-deflate is not implemented'); return; }
      if (opcode === 8) { // close
        this._sendFrame(8, payload.subarray(0, 2));
        this._closed(payload.length >= 2 ? payload.readUInt16BE(0) : 1005, 'server close');
        return;
      }
      if (opcode === 9) { this._sendFrame(10, payload); continue; } // ping -> pong
      if (opcode === 10) continue; // pong
      if (opcode === 1 || opcode === 2) {
        if (!fin) { this.fragments = { opcode, chunks: [payload] }; continue; }
        this.onMessage && this.onMessage(payload, opcode);
      } else if (opcode === 0 && this.fragments) {
        this.fragments.chunks.push(payload);
        if (fin) {
          const full = Buffer.concat(this.fragments.chunks);
          const op = this.fragments.opcode;
          this.fragments = null;
          this.onMessage && this.onMessage(full, op);
        }
      }
    }
  }

  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = (b[0] & 0x80) !== 0;
    const rsv = (b[0] & 0x70) !== 0;
    const opcode = b[0] & 0x0f;
    const masked = (b[1] & 0x80) !== 0;
    let len = b[1] & 0x7f, off = 2;
    if (len === 126) { if (b.length < off + 2) return null; len = b.readUInt16BE(off); off += 2; }
    else if (len === 127) { if (b.length < off + 8) return null; len = Number(b.readBigUInt64BE(off)); off += 8; }
    let mask = null;
    if (masked) { if (b.length < off + 4) return null; mask = b.subarray(off, off + 4); off += 4; }
    if (b.length < off + len) return null;
    let payload = b.subarray(off, off + len);
    if (mask) {
      const un = Buffer.from(payload);
      for (let i = 0; i < un.length; i++) un[i] ^= mask[i & 3];
      payload = un;
    }
    this.buf = b.subarray(off + len);
    return { fin, rsv, opcode, payload };
  }

  _sendFrame(opcode, payload) {
    if (this.closed) return;
    const mask = crypto.randomBytes(4);
    let header;
    const len = payload.length;
    if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
    else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
    else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
    header[0] = 0x80 | opcode; // FIN + opcode
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  sendBinary(buf) { this._sendFrame(2, buf); }
  sendText(str) { this._sendFrame(1, Buffer.from(str, 'utf8')); }
  close() {
    if (this.closed) return;
    this._sendFrame(8, Buffer.from([0x03, 0xe8]));
    setTimeout(() => this._closed(1000, 'local close'), 500);
  }
}

// wss://host:port/path with extra handshake headers and subprotocols.
function wsConnect(url, { headers = {}, protocols = [] } = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== 'wss:') return reject(new Error('only wss supported'));
    const key = crypto.randomBytes(16).toString('base64');
    const reqHeaders = {
      Host: u.host,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...headers,
    };
    if (protocols.length) reqHeaders['Sec-WebSocket-Protocol'] = protocols.join(', ');
    const req = https.request({
      host: u.hostname, port: u.port || 443, path: u.pathname + u.search,
      method: 'GET', headers: reqHeaders, servername: u.hostname,
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('ws handshake timeout')));
    req.on('upgrade', (res, socket, head) => {
      const expect = crypto.createHash('sha1').update(key + GUID_TAIL).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy();
        return reject(new Error('bad Sec-WebSocket-Accept'));
      }
      const ext = res.headers['sec-websocket-extensions'];
      if (ext) { // we implement no extension; refuse rather than mis-parse frames
        socket.destroy();
        return reject(new Error('server negotiated unsupported extension "' + ext + '" (permessage-deflate is not implemented)'));
      }
      const conn = new WsConn(socket);
      if (head && head.length) conn._feed(head);
      resolve(conn);
    });
    req.on('response', res => reject(new Error('ws handshake rejected: ' + res.statusCode)));
    req.on('error', reject);
    req.end();
  });
}

module.exports = { wsConnect, WsConn };
