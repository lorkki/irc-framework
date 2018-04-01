'use strict';

/**
 * TCP / TLS transport
 */

var net             = require('net');
var tls             = require('tls');
var util            = require('util');
var EventEmitter    = require('events').EventEmitter;
var Socks           = require('socksjs');
var iconv           = require('iconv-lite');
var jschardet       = require('jschardet');

var SOCK_DISCONNECTED = 0;
var SOCK_CONNECTING = 1;
var SOCK_CONNECTED = 2;

module.exports = class Connection extends EventEmitter {
    constructor(options) {
        super();

        this.options = options || {};

        this.socket = null;
        this.state = SOCK_DISCONNECTED;
        this.last_socket_error = null;
        this.socket_events = [];

        this.encoding = 'utf8';
        this.incoming_buffer = '';
    }

    isConnected() {
        return this.state === SOCK_CONNECTED;
    }

    writeLine(line, cb) {
    	if (this.socket && this.isConnected()) {
    		if (this.encoding !== 'utf8') {
    			this.socket.write(iconv.encode(line + '\n', this.encoding), cb);
    		} else {
    			this.socket.write(line + '\n', cb);
    		}
    	}
    }

    debugOut(out) {
        this.emit('debug', 'NetTransport ' + out);
    }

    _bindEvent(obj, event, fn) {
    	obj.on(event, fn);
    	var unbindEvent = () => {
    		obj.off(event, fn);
    	};
    	this.socket_events.push(unbindEvent);
    	return unbindEvent;
    }

    _unbindEvents() {
    	this.socket_events.forEach(fn => fn());
    }

    connect() {
        var socket_connect_event_name = 'connect';
        var options = this.options;
        var ircd_host = options.host;
        var ircd_port = options.port || 6667;
        var socket = null;

        this.debugOut('connect()');

        this.disposeSocket();
        this.requested_disconnect = false;

        if (!options.encoding || !this.setEncoding(options.encoding)) {
            this.setEncoding('utf8');
        }

        this.state = SOCK_CONNECTING;
        this.debugOut('Connecting socket..');

        if (options.socks) {
            this.debugOut('Using SOCKS proxy');
            socket = this.socket = Socks.connect({
                host: ircd_host,
                port: ircd_port,
                ssl: options.tls || options.ssl,
                rejectUnauthorized: options.rejectUnauthorized
            }, {
                host: options.socks.host,
                port: options.socks.port || 8080,
                user: options.socks.user,
                pass: options.socks.pass,
                localAddress: options.outgoing_addr
            });
        } else {
            if (options.tls || options.ssl) {
                socket = this.socket = tls.connect({
                    host: ircd_host,
                    port: ircd_port,
                    rejectUnauthorized: options.rejectUnauthorized,
                    localAddress: options.outgoing_addr
                });

                socket_connect_event_name = 'secureConnect';

            } else {
                socket = this.socket = net.connect({
                    host: ircd_host,
                    port: ircd_port,
                    localAddress: options.outgoing_addr
                });

                socket_connect_event_name = 'connect';
            }
        }

        // We need the raw socket connect event.
        // node.js 0.12 no longer has a .socket property.
        this._bindEvent(socket.socket || socket, 'connect', this.onSocketRawConnected.bind(this));
        this._bindEvent(socket, socket_connect_event_name, this.onSocketFullyConnected.bind(this));

        this._bindEvent(socket, 'close', this.onSocketClose.bind(this));
        this._bindEvent(socket, 'error', this.onSocketError.bind(this));
        this._bindEvent(socket, 'data', this.onSocketData.bind(this));
    }

    // Called when the socket is connected and before any TLS handshaking if applicable.
    // This is when it's ideal to read socket pairs for identd.
    onSocketRawConnected() {
        this.debugOut('socketRawConnected()');
        this.state = SOCK_CONNECTED;
        this.emit('extra', 'raw socket connected', (this.socket.socket || this.socket));
    }

    // Called when the socket is connected and ready to start sending/receiving data.
    onSocketFullyConnected() {
        this.debugOut('socketFullyConnected()');
        this.last_socket_error = null;
        this.emit('open');
    }

    onSocketClose() {
    	this.debugOut('socketClose()');
        this.state = SOCK_DISCONNECTED;
        this.emit('close', this.last_socket_error ? this.last_socket_error : false);
    }

    onSocketError(err) {
        this.debugOut('socketError() ' + err.message);
        this.last_socket_error = err;
        //this.emit('error', err);
    }

    onSocketData(data) {
        var encoding = this.detectEncoding(data);
    	this.incoming_buffer += iconv.decode(data, encoding);

    	var lines = this.incoming_buffer.split('\n');
    	if (lines[lines.length - 1] !== '') {
    		this.incoming_buffer = lines.pop();
    	} else {
    		lines.pop();
    		this.incoming_buffer = '';
    	}

    	lines.forEach(_line => {
    		var line = _line.trim();
    		this.emit('line', line);
    	});
    }



    disposeSocket() {
        this.debugOut('disposeSocket() connected=' + this.isConnected());

        if (this.socket && this.state !== SOCK_DISCONNECTED) {
            this.socket.destroy();
        }

        if (this.socket) {
            this._unbindEvents();
            this.socket = null;
        }
    }


    close(force) {
        // Cleanly close the socket if we can
        if ((this.socket && this.state === SOCK_CONNECTING) || force) {
            this.debugOut('close() destroying');
            this.socket.destroy();
        } else if (this.socket && this.state === SOCK_CONNECTED) {
            this.debugOut('close() ending');
            this.socket.end();
        }
    }


    detectEncoding(data) {
        if (!this.options.encoding_autodetect) {
            return this.encoding;
        }

        var detected_encoding = jschardet.detect(data).encoding;

        this.debugOut('Connection.detectEncoding() detected ' + detected_encoding);

        if (detected_encoding === 'ascii' || !this.testEncoding(detected_encoding)) {
            return this.encoding;
        } else {
            return detected_encoding;
        }
    }

    setEncoding(encoding) {
        this.debugOut('Connection.setEncoding() encoding=' + encoding);

        if (this.testEncoding(encoding)) {
            this.encoding = encoding;
            return true;
        } else {
            return false;
        }
    }


    testEncoding(encoding) {
        var encoded_test;

        try {
            encoded_test = iconv.encode('TEST', encoding);
            // This test is done to check if this encoding also supports
            // the ASCII charset required by the IRC protocols
            // (Avoid the use of base64 or incompatible encodings)
            if (encoded_test == 'TEST') { // jshint ignore:line
                return true;
            }
            return false;
        } catch (err) {
            return false;
        }
    }
};
