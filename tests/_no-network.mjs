// Tests never use the host network. Individual fixtures may replace fetch with
// an in-memory fake, but TCP, TLS, HTTP and datagram connections remain blocked.
import net from 'node:net';
import tls from 'node:tls';
import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import { syncBuiltinESMExports } from 'node:module';

const deny = () => { throw new Error('Network disabled in synthetic tests'); };
net.Socket.prototype.connect = deny;
net.connect = net.createConnection = tls.connect = http.request = http.get = https.request = https.get = deny;
dgram.createSocket = deny;
globalThis.fetch = deny;
syncBuiltinESMExports();
