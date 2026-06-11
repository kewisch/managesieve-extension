/* exported tcp */
/* global Cc, Ci, Components, Cr, ChromeUtils, Services, URL */

const { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
const { ExtensionUtils } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionUtils.sys.mjs"
);
const { ExtensionError } = ExtensionUtils;

const ScriptableInputStream = Components.Constructor(
  "@mozilla.org/scriptableinputstream;1",
  "nsIScriptableInputStream",
  "init"
);
const InputStreamPump = Components.Constructor(
  "@mozilla.org/network/input-stream-pump;1",
  "nsIInputStreamPump",
  "init"
);
const UnicodeConverter = Components.Constructor(
  "@mozilla.org/intl/scriptableunicodeconverter",
  "nsIScriptableUnicodeConverter"
);

// eslint-disable-next-line no-unused-vars
var tcp = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    const sockets = new Map();

    const getSocket = socketId => {
      const socket = sockets.get(socketId);
      if (!socket) {
        throw extensionError("unknownSocket", "The TCP socket is not open.");
      }
      return socket;
    };

    return {
      tcp: {
        async connect(options) {
          const host = normalizeHost(options.host);
          const permission = `https://${host}/*`;
          if (!context.extension.allowedOrigins.matches(Services.io.newURI(`https://${host}/`))) {
            throw extensionError("missingHostPermission", `Missing host permission for ${permission}.`);
          }

          const socket = new TcpSocket({
            host,
            port: options.port,
            security: options.security || "plain",
            connectTimeout: options.connectTimeout || 30,
            onClose() {
              sockets.delete(socket.id);
            },
          });
          sockets.set(socket.id, socket);
          await socket.connect();
          return socket.id;
        },

        async read(socketId, byteCount) {
          return getSocket(socketId).read(byteCount);
        },

        async readLine(socketId) {
          return getSocket(socketId).readLine();
        },

        async write(socketId, data) {
          getSocket(socketId).write(data);
        },

        async startTLS(socketId) {
          await getSocket(socketId).startTLS();
        },

        async close(socketId) {
          getSocket(socketId).close();
          sockets.delete(socketId);
        },
      },
    };
  }
};

class TcpSocket {
  constructor({ host, port, security, connectTimeout, onClose }) {
    this.id = Services.uuid.generateUUID().toString();
    this.host = host;
    this.port = port;
    this.security = security;
    this.connectTimeout = connectTimeout;
    this.onClose = onClose;
    this.buffer = "";
    this.pendingReads = [];
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      const socketService = Cc["@mozilla.org/network/socket-transport-service;1"]
        .getService(Ci.nsISocketTransportService);
      this.transport = socketService.createTransport(
        this.security == "tls" ? ["ssl"] : [],
        this.host,
        this.port,
        null,
        null
      );
      this.transport.setTimeout(Ci.nsISocketTransport.TIMEOUT_CONNECT, this.connectTimeout);
      this.transport.setEventSink(this, Services.tm.currentThread);

      this.outputStream = this.transport.openOutputStream(0, 0, -1);
      this.inputStream = this.transport.openInputStream(0, 0, 0);
      this.scriptableInputStream = new ScriptableInputStream(this.inputStream);
      this.pump = new InputStreamPump(this.inputStream, 0, 0, false);
      this.pump.asyncRead(this);
    });
  }

  read(byteCount) {
    return new Promise((resolve, reject) => {
      this.pendingReads.push({
        type: "bytes",
        byteCount,
        resolve,
        reject,
      });
      this.flushPendingReads();
    });
  }

  readLine() {
    return new Promise((resolve, reject) => {
      this.pendingReads.push({
        type: "line",
        resolve,
        reject,
      });
      this.flushPendingReads();
    });
  }

  write(data) {
    if (this.closed) {
      throw extensionError("socketClosed", "The TCP socket is closed.");
    }

    const bytes = encodeUtf8(data);
    let offset = 0;
    while (offset < bytes.length) {
      const written = this.outputStream.write(bytes.slice(offset), bytes.length - offset);
      if (written <= 0) {
        throw extensionError("socketWriteFailed", "The TCP socket did not accept any data.");
      }
      offset += written;
    }
  }

  async startTLS() {
    if (this.closed) {
      throw extensionError("socketClosed", "The TCP socket is closed.");
    }

    await this.transport.tlsSocketControl
      .QueryInterface(Ci.nsITLSSocketControl)
      .asyncStartTLS();
  }

  close() {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.rejectPending(extensionError("socketClosed", "The TCP socket was closed."));
    this.inputStream?.close();
    this.outputStream?.close();
    this.transport?.close(Cr.NS_OK);
    this.onClose();
  }

  flushPendingReads() {
    while (this.pendingReads.length) {
      const pending = this.pendingReads[0];
      if (pending.type == "line") {
        const lineEnd = this.buffer.indexOf("\n");
        if (lineEnd == -1) {
          return;
        }

        const line = decodeUtf8(this.buffer.slice(0, lineEnd).replace(/\r$/, ""));
        this.buffer = this.buffer.slice(lineEnd + 1);
        this.pendingReads.shift();
        pending.resolve(line);
        continue;
      }

      if (this.buffer.length < pending.byteCount) {
        return;
      }

      const data = decodeUtf8(this.buffer.slice(0, pending.byteCount));
      this.buffer = this.buffer.slice(pending.byteCount);
      this.pendingReads.shift();
      pending.resolve(data);
    }
  }

  rejectPending(error) {
    for (const pending of this.pendingReads.splice(0)) {
      pending.reject(error);
    }
  }

  onStartRequest() {}

  onDataAvailable(request, inputStream, offset, count) {
    this.buffer += this.scriptableInputStream.read(count);
    this.flushPendingReads();
  }

  onStopRequest(request, status) {
    if (!Components.isSuccessCode(status) && !this.closed) {
      const error = extensionError("socketError", `The TCP socket closed with status ${status}.`);
      this.connectReject?.(error);
      this.rejectPending(error);
    }
    this.close();
  }

  onTransportStatus(transport, status) {
    if (status == Ci.nsISocketTransport.STATUS_CONNECTED_TO && this.connectResolve) {
      this.connectResolve();
      delete this.connectResolve;
      delete this.connectReject;
    }
  }

  QueryInterface = ChromeUtils.generateQI([
    "nsIStreamListener",
    "nsIRequestObserver",
    "nsITransportEventSink",
  ]);
}

function normalizeHost(host) {
  const trimmedHost = host?.trim() || "";
  if (!trimmedHost) {
    throw extensionError("invalidHost", "A TCP host is required.");
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmedHost)) {
    return new URL(trimmedHost).hostname;
  }
  return trimmedHost.replace(/\/.*$/, "").replace(/:\d+$/, "");
}

function extensionError(code, message) {
  return new ExtensionError(`${code}: ${message}`);
}

function encodeUtf8(value) {
  const converter = new UnicodeConverter();
  converter.charset = "UTF-8";
  return converter.ConvertFromUnicode(value) + converter.Finish();
}

function decodeUtf8(value) {
  const converter = new UnicodeConverter();
  converter.charset = "UTF-8";
  return converter.ConvertToUnicode(value) + converter.Finish();
}
