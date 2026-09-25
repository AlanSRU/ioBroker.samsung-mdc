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
var wol_exports = {};
__export(wol_exports, {
  wake: () => wake
});
module.exports = __toCommonJS(wol_exports);
var import_node_dgram = require("node:dgram");
function wake(mac, broadcast = "255.255.255.255", port = 9) {
  return new Promise((resolve, reject) => {
    const bytes = mac.split(/[:-]/).map((h) => parseInt(h, 16));
    if (bytes.length !== 6 || bytes.some((b) => Number.isNaN(b))) {
      reject(new Error(`invalid MAC address: ${mac}`));
      return;
    }
    const packet = Buffer.concat([Buffer.alloc(6, 255), ...Array(16).fill(Buffer.from(bytes))]);
    const socket = (0, import_node_dgram.createSocket)("udp4");
    socket.once("error", (err) => {
      socket.close();
      reject(err);
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, 0, packet.length, port, broadcast, (err) => {
        socket.close();
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  wake
});
//# sourceMappingURL=wol.js.map
