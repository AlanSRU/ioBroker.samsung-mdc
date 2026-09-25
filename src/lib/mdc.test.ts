import { expect } from 'chai';
import { createServer, type Server, type Socket } from 'node:net';
import { MdcClient } from './mdc';

/** connections accepted by the test servers, destroyed after each test */
const sockets: Socket[] = [];

/**
 * Start a local server that handles each connection with the given function.
 *
 * @param onConnection - connection handler
 */
function listen(onConnection: (socket: Socket) => void): Promise<Server> {
    return new Promise(resolve => {
        const server = createServer(socket => {
            sockets.push(socket);
            onConnection(socket);
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

const portOf = (server: Server): number => (server.address() as { port: number }).port;

describe('mdc => MdcClient.request', () => {
    let server: Server | undefined;

    afterEach(done => {
        sockets.splice(0).forEach(socket => socket.destroy());
        if (server) {
            server.close(() => done());
            server = undefined;
        } else {
            done();
        }
    });

    it('rejects when the display closes the connection without replying', async () => {
        server = await listen(socket => socket.end());
        const client = new MdcClient('127.0.0.1', portOf(server), 0, 3000);
        await expect(client.getStatus()).to.be.rejectedWith('closed before a complete reply');
    });

    it('rejects when the display closes the connection after a truncated reply', async () => {
        server = await listen(socket => socket.end(Buffer.from([0xaa, 0xff, 0x00, 0x09, 0x41])));
        const client = new MdcClient('127.0.0.1', portOf(server), 0, 3000);
        await expect(client.getStatus()).to.be.rejectedWith('closed before a complete reply');
    });

    it('parses a complete status reply', async () => {
        const body = [0xff, 0x00, 0x09, 0x41, 0x00, 0x01, 0x14, 0x00, 0x21, 0x10, 0x00, 0x00];
        const checksum = body.reduce((sum, b) => sum + b, 0) & 0xff;
        server = await listen(socket => socket.once('data', () => socket.end(Buffer.from([0xaa, ...body, checksum]))));
        const client = new MdcClient('127.0.0.1', portOf(server), 0, 3000);
        expect(await client.getStatus()).to.deep.equal({ power: true, volume: 20, mute: false, input: 0x21 });
    });
});
