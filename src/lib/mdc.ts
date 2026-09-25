/*
 * Samsung MDC (Multiple Display Control) protocol client.
 *
 * Wire format (host -> display):
 *   [0xAA][command][id][len][data...][checksum]
 * Response (display -> host):
 *   [0xAA][0xFF][id][len][ack][command][data...][checksum]
 *   ack: 'A' (0x41) = affirmative, 'N' (0x4E) = negative
 *   checksum: sum of every byte except the 0xAA header, low 8 bits
 *
 * One request is in flight at a time; a fresh TCP connection is opened per
 * request, which keeps the client stateless and robust against half-open
 * sockets on displays that drop idle connections.
 */
import { Socket } from 'node:net';

export const MdcCommand = {
    STATUS: 0x00,
    POWER: 0x11,
    VOLUME: 0x12,
    MUTE: 0x13,
    INPUT: 0x14,
} as const;

const ACK = 0x41; // 'A'

/** Combined display status returned by the STATUS command. */
export interface MdcStatus {
    /** true if the panel is powered on */
    power: boolean;
    /** volume 0-100 */
    volume: number;
    /** true if muted */
    mute: boolean;
    /** current input source code */
    input: number;
}

/** Minimal MDC protocol client for a single Samsung signage display. */
export class MdcClient {
    /**
     * @param host - display IP address
     * @param port - MDC TCP port (usually 1515)
     * @param id - MDC display/set ID (0 for a single display)
     * @param timeoutMs - per-request timeout in milliseconds
     */
    public constructor(
        private readonly host: string,
        private readonly port: number,
        private readonly id: number,
        private readonly timeoutMs = 4000,
    ) {}

    private buildFrame(command: number, data: number[]): Buffer {
        const body = [command, this.id, data.length, ...data];
        const checksum = body.reduce((sum, b) => sum + b, 0) & 0xff;
        return Buffer.from([0xaa, ...body, checksum]);
    }

    /**
     * Send one MDC command and resolve with the response data payload.
     *
     * @param command - MDC command byte (see MdcCommand)
     * @param data - optional command arguments
     */
    public request(command: number, data: number[] = []): Promise<number[]> {
        return new Promise((resolve, reject) => {
            const socket = new Socket();
            const chunks: Buffer[] = [];
            let settled = false;

            const finish = (err?: Error, value?: number[]): void => {
                if (settled) {
                    return;
                }
                settled = true;
                socket.destroy();
                if (err) {
                    reject(err);
                } else {
                    resolve(value ?? []);
                }
            };

            socket.setTimeout(this.timeoutMs, () => finish(new Error(`MDC timeout after ${this.timeoutMs} ms`)));
            socket.on('error', err => finish(err));
            socket.on('data', chunk => {
                chunks.push(chunk);
                const buf = Buffer.concat(chunks);
                if (buf.length < 4) {
                    return; // need header, response-cmd, id, len
                }
                if (buf[0] !== 0xaa) {
                    finish(new Error('invalid MDC header'));
                    return;
                }
                const len = buf[3];
                const total = 4 + len + 1; // header + ff + id + len + payload + checksum
                if (buf.length < total) {
                    return; // wait for the rest of the frame
                }
                const frame = buf.subarray(0, total);
                const checksum = frame.subarray(1, total - 1).reduce((sum, b) => sum + b, 0) & 0xff;
                if (checksum !== frame[total - 1]) {
                    finish(new Error('MDC checksum mismatch'));
                    return;
                }
                const ack = frame[4];
                if (ack !== ACK) {
                    finish(new Error(`MDC negative acknowledgement (0x${ack.toString(16)})`));
                    return;
                }
                // payload is everything between [ack, command] and the checksum
                finish(undefined, Array.from(frame.subarray(6, total - 1)));
            });

            socket.connect(this.port, this.host, () => {
                socket.write(this.buildFrame(command, data));
            });
        });
    }

    /** Read the combined status (power, volume, mute, input) in a single request. */
    public async getStatus(): Promise<MdcStatus> {
        const d = await this.request(MdcCommand.STATUS);
        return {
            power: d[0] === 1,
            volume: d[1] ?? 0,
            mute: d[2] === 1,
            input: d[3] ?? 0,
        };
    }

    /**
     * Turn the display on or off.
     *
     * @param on - true to power on, false to power off
     */
    public setPower(on: boolean): Promise<number[]> {
        return this.request(MdcCommand.POWER, [on ? 1 : 0]);
    }

    /**
     * Set the volume (clamped to 0-100).
     *
     * @param volume - target volume
     */
    public setVolume(volume: number): Promise<number[]> {
        const v = Math.max(0, Math.min(100, Math.round(volume)));
        return this.request(MdcCommand.VOLUME, [v]);
    }

    /**
     * Mute or unmute the display.
     *
     * @param mute - true to mute
     */
    public setMute(mute: boolean): Promise<number[]> {
        return this.request(MdcCommand.MUTE, [mute ? 1 : 0]);
    }

    /**
     * Switch the input source.
     *
     * @param code - MDC input source code (see INPUT_SOURCES in main.ts)
     */
    public setInput(code: number): Promise<number[]> {
        return this.request(MdcCommand.INPUT, [code & 0xff]);
    }
}
