"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var mdc_exports = {};
__export(mdc_exports, {
  MdcClient: () => MdcClient,
  MdcCommand: () => MdcCommand
});
module.exports = __toCommonJS(mdc_exports);
var import_node_net = require("node:net");
const MdcCommand = {
  STATUS: 0,
  POWER: 17,
  VOLUME: 18,
  MUTE: 19,
  INPUT: 20
};
const ACK = 65;
class MdcClient {
  /**
   * @param host - display IP address
   * @param port - MDC TCP port (usually 1515)
   * @param id - MDC display/set ID (0 for a single display)
   * @param timeoutMs - per-request timeout in milliseconds
   */
  constructor(host, port, id, timeoutMs = 4e3) {
    this.host = host;
    this.port = port;
    this.id = id;
    this.timeoutMs = timeoutMs;
  }
  buildFrame(command, data) {
    const body = [command, this.id, data.length, ...data];
    const checksum = body.reduce((sum, b) => sum + b, 0) & 255;
    return Buffer.from([170, ...body, checksum]);
  }
  /**
   * Send one MDC command and resolve with the response data payload.
   *
   * @param command - MDC command byte (see MdcCommand)
   * @param data - optional command arguments
   */
  request(command, data = []) {
    return new Promise((resolve, reject) => {
      const socket = new import_node_net.Socket();
      const chunks = [];
      let settled = false;
      const finish = (err, value) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        if (err) {
          reject(err);
        } else {
          resolve(value != null ? value : []);
        }
      };
      socket.setTimeout(this.timeoutMs, () => finish(new Error(`MDC timeout after ${this.timeoutMs} ms`)));
      socket.on("error", (err) => finish(err));
      socket.on("data", (chunk) => {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (buf.length < 4) {
          return;
        }
        if (buf[0] !== 170) {
          finish(new Error("invalid MDC header"));
          return;
        }
        const len = buf[3];
        const total = 4 + len + 1;
        if (buf.length < total) {
          return;
        }
        const frame = buf.subarray(0, total);
        const checksum = frame.subarray(1, total - 1).reduce((sum, b) => sum + b, 0) & 255;
        if (checksum !== frame[total - 1]) {
          finish(new Error("MDC checksum mismatch"));
          return;
        }
        const ack = frame[4];
        if (ack !== ACK) {
          finish(new Error(`MDC negative acknowledgement (0x${ack.toString(16)})`));
          return;
        }
        finish(void 0, Array.from(frame.subarray(6, total - 1)));
      });
      socket.connect(this.port, this.host, () => {
        socket.write(this.buildFrame(command, data));
      });
    });
  }
  /** Read the combined status (power, volume, mute, input) in a single request. */
  async getStatus() {
    var _a, _b;
    const d = await this.request(MdcCommand.STATUS);
    return {
      power: d[0] === 1,
      volume: (_a = d[1]) != null ? _a : 0,
      mute: d[2] === 1,
      input: (_b = d[3]) != null ? _b : 0
    };
  }
  /**
   * Turn the display on or off.
   *
   * @param on - true to power on, false to power off
   */
  setPower(on) {
    return this.request(MdcCommand.POWER, [on ? 1 : 0]);
  }
  /**
   * Set the volume (clamped to 0-100).
   *
   * @param volume - target volume
   */
  setVolume(volume) {
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    return this.request(MdcCommand.VOLUME, [v]);
  }
  /**
   * Mute or unmute the display.
   *
   * @param mute - true to mute
   */
  setMute(mute) {
    return this.request(MdcCommand.MUTE, [mute ? 1 : 0]);
  }
  /**
   * Switch the input source.
   *
   * @param code - MDC input source code (see INPUT_SOURCES in main.ts)
   */
  setInput(code) {
    return this.request(MdcCommand.INPUT, [code & 255]);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  MdcClient,
  MdcCommand
});
//# sourceMappingURL=mdc.js.map
