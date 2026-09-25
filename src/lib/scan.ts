/*
 * MDC panel discovery.
 *
 * MDC has no announce or broadcast mechanism, so discovery is an active sweep:
 * open TCP 1515 on every address in the given range and send a STATUS request.
 * A positive acknowledgement is proof the address is an MDC panel answering on
 * the given set ID — and the reply carries power/volume/input at the same time.
 */
import { MdcClient, type MdcStatus } from './mdc';

/** Upper bound on addresses per scan, so a wide CIDR cannot start a huge sweep. */
export const MAX_SCAN_HOSTS = 4096;

/** A panel that answered the STATUS probe. */
export interface ScanHit {
    /** address that answered */
    ipAddress: string;
    /** MDC port it answered on */
    port: number;
    /** set ID it was probed with */
    displayId: number;
    /** status reported in the probe reply */
    status: MdcStatus;
}

const ipToLong = (ip: string): number => {
    const parts = ip.split('.');
    if (parts.length !== 4) {
        throw new Error(`invalid IP address: ${ip}`);
    }
    return parts.reduce((acc, part) => {
        const octet = Number(part);
        if (!/^\d{1,3}$/.test(part) || octet > 255) {
            throw new Error(`invalid IP address: ${ip}`);
        }
        return acc * 256 + octet;
    }, 0);
};

const longToIp = (value: number): string =>
    [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');

/**
 * Expand a scan specification into a list of IP addresses.
 *
 * Accepts a comma- or whitespace-separated list of: a single address
 * (`192.168.230.200`), a CIDR block (`192.168.230.0/24`, network and broadcast
 * addresses excluded for prefixes shorter than /31), a last-octet range
 * (`192.168.230.10-60`) or a full range (`192.168.230.10-192.168.231.20`).
 *
 * @param spec - the scan specification
 * @returns de-duplicated addresses in ascending order
 */
export function expandScanRange(spec: string): string[] {
    const found = new Set<number>();

    for (const token of spec.split(/[,\s]+/).filter(Boolean)) {
        let first: number;
        let last: number;

        if (token.includes('/')) {
            const [base, bitsText] = token.split('/');
            const bits = Number(bitsText);
            if (!/^\d{1,2}$/.test(bitsText) || bits > 32) {
                throw new Error(`invalid CIDR prefix: ${token}`);
            }
            const size = 2 ** (32 - bits);
            const network = Math.floor(ipToLong(base) / size) * size;
            first = size > 2 ? network + 1 : network;
            last = size > 2 ? network + size - 2 : network + size - 1;
        } else if (token.includes('-')) {
            const [from, to] = token.split('-');
            first = ipToLong(from);
            // "192.168.1.10-60" — the end may be a bare last octet
            last = to.includes('.') ? ipToLong(to) : ipToLong(`${from.split('.').slice(0, 3).join('.')}.${to}`);
            if (last < first) {
                throw new Error(`range ends before it starts: ${token}`);
            }
        } else {
            first = last = ipToLong(token);
        }

        if (found.size + (last - first + 1) > MAX_SCAN_HOSTS) {
            throw new Error(`scan range covers more than ${MAX_SCAN_HOSTS} addresses — narrow it down`);
        }
        for (let value = first; value <= last; value++) {
            found.add(value);
        }
    }

    return [...found].sort((a, b) => a - b).map(longToIp);
}

/**
 * Probe every address for a panel answering MDC.
 *
 * @param options - scan parameters
 * @param options.hosts - addresses to probe (see expandScanRange)
 * @param options.port - MDC TCP port
 * @param options.displayId - MDC set ID to probe with
 * @param options.timeoutMs - per-address timeout
 * @param options.concurrency - how many addresses to probe at once
 * @returns the panels that acknowledged, in the order the addresses were given
 */
export async function scanForPanels(options: {
    hosts: string[];
    port: number;
    displayId: number;
    timeoutMs?: number;
    concurrency?: number;
}): Promise<ScanHit[]> {
    const { hosts, port, displayId, timeoutMs = 1500, concurrency = 32 } = options;
    const hits: (ScanHit | undefined)[] = new Array(hosts.length);
    let cursor = 0;

    const worker = async (): Promise<void> => {
        for (let index = cursor++; index < hosts.length; index = cursor++) {
            const ipAddress = hosts[index];
            try {
                const status = await new MdcClient(ipAddress, port, displayId, timeoutMs).getStatus();
                hits[index] = { ipAddress, port, displayId, status };
            } catch {
                // not a panel, wrong set ID, or unreachable — nothing to report
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, () => worker()));
    return hits.filter((hit): hit is ScanHit => hit !== undefined);
}
