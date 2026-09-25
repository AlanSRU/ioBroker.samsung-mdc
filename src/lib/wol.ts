/*
 * Wake-on-LAN magic packet sender.
 *
 * MDC displays with Network Standby enabled answer on TCP 1515 while in
 * standby, so WoL is only needed to bring a fully powered-off panel back onto
 * the network before the MDC power-on command is sent.
 */
import { createSocket } from 'node:dgram';

/**
 * Send a Wake-on-LAN magic packet for the given MAC address.
 *
 * @param mac - target MAC address (colon- or hyphen-separated)
 * @param broadcast - broadcast address to send to (default 255.255.255.255)
 * @param port - UDP port (default 9)
 */
export function wake(mac: string, broadcast = '255.255.255.255', port = 9): Promise<void> {
    return new Promise((resolve, reject) => {
        const bytes = mac.split(/[:-]/).map(h => parseInt(h, 16));
        if (bytes.length !== 6 || bytes.some(b => Number.isNaN(b))) {
            reject(new Error(`invalid MAC address: ${mac}`));
            return;
        }
        // magic packet: 6x 0xFF followed by the MAC repeated 16 times
        const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(Buffer.from(bytes))]);
        const socket = createSocket('udp4');
        socket.once('error', err => {
            socket.close();
            reject(err);
        });
        socket.bind(() => {
            socket.setBroadcast(true);
            socket.send(packet, 0, packet.length, port, broadcast, err => {
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
