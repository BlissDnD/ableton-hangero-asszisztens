// Kapcsolat az Ableton Live-ban futó Remote Scripttel (AbletonMCP, 127.0.0.1:9877).
// A protokoll: egy nyers JSON kérés {"type": parancs, "params": {...}}, a válasz egy JSON
// {"status":"success","result":...} vagy {"status":"error","code":...,"message":...}.
// Minden kérés új kapcsolatot nyit, ugyanúgy, mint a felhasznált upstream kliens.
import net from 'node:net';

export class BridgeError extends Error {
  constructor(message, { code = 'BRIDGE', details, transient = false } = {}) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.details = details;
    this.transient = transient;
  }
}

function request(host, port, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let done = false;
    const socket = net.createConnection({ host, port });
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(
      () => finish(reject, new BridgeError(`Időtúllépés (${timeoutMs} ms) a válaszra.`, { code: 'TIMEOUT', transient: true })),
      timeoutMs
    );
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let parsed;
      try {
        parsed = JSON.parse(buffer);
      } catch {
        return; // a válasz még nem teljes
      }
      finish(resolve, parsed);
    });
    socket.on('error', (error) =>
      finish(
        reject,
        new BridgeError(`Nem sikerült csatlakozni (${host}:${port}): ${error.message}`, {
          code: error.code === 'ECONNREFUSED' ? 'REFUSED' : 'CONNECTION'
        })
      )
    );
    socket.on('close', () => {
      if (done) return;
      let parsed;
      try {
        parsed = JSON.parse(buffer);
      } catch {
        return finish(reject, new BridgeError('A kapcsolat válasz nélkül lezárult.', { code: 'CLOSED', transient: true }));
      }
      finish(resolve, parsed);
    });
  });
}

export class Bridge {
  constructor({ host, port = 9877, timeoutMs = 15000 } = {}) {
    this.hosts = host ? [host] : ['127.0.0.1', '::1'];
    this.port = port;
    this.timeoutMs = timeoutMs;
    this.calls = 0;
  }

  async send(type, params = {}) {
    const payload = JSON.stringify({ type, params });
    let lastError;
    for (const host of this.hosts) {
      try {
        const response = await request(host, this.port, payload, this.timeoutMs);
        this.hosts = [host]; // a működő címet megjegyezzük
        this.calls += 1;
        if (response.status === 'success') return response.result;
        throw new BridgeError(response.message || `A(z) '${type}' parancs hibával tért vissza.`, {
          code: response.code || 'REMOTE_ERROR',
          details: response.details
        });
      } catch (error) {
        lastError = error;
        if (!(error instanceof BridgeError) || error.code !== 'REFUSED') throw error;
      }
    }
    throw lastError;
  }
}
