
var MAX_RECEIVE_BUFFER = 10000000;
var PROTOCOL_VERSION = 70048; 
var Buffers = require('./buffers');
var Put = require('bufferput');

var bitcoreDefaults = require('../config');
var networks = require('./networks');
var Block = require('./block/block');
var Transaction = require('./transaction/transaction');
var util = require('./util/util');
var Parser = require('./util/binaryparser');
var doubleSha256 = util.twoSha256;
var Random = require('./crypto/random');
var nonce = Random.getPseudoRandomBuffer(8);
var nodeUtil = require('util');
var EventEmitter = require('events').EventEmitter;

var BIP0031_VERSION = 60000;

function Connection(socket, peer, opts) {
  this.config = opts || bitcoreDefaults;

  this.network = networks[this.config.network] || networks.livenet;
  this.socket = socket;
  this.peer = peer;

  // check for socks5 proxy options and construct a proxied socket
  if (this.config.proxy) {
    var Socks5Client = require('socks5-client');
    this.socket = new Socks5Client(this.config.proxy.host, this.config.proxy.port);
  }

  // A connection is considered "active" once we have received verack
  this.active = false;
  // The version incoming packages are interpreted as
  this.recvVer = 0;
  // The version outgoing packages are sent as
  this.sendVer = 0;
  // The (claimed) height of the remote peer's block chain
  this.bestHeight = 0;
  // Is this an inbound connection?
  this.inbound = !!this.socket.server;
  // Have we sent a getaddr on this connection?
  this.getaddr = false;

  // Receive buffer
  this.buffers = new Buffers();

  // Starting 20 Feb 2012, Version 0.2 is obsolete
  // This is the same behavior as the official client
  if (new Date().getTime() > 1329696000000) {
    this.recvVer = 209;
    this.sendVer = 209;
  }

  this.setupHandlers();
}
nodeUtil.inherits(Connection, EventEmitter);
Connection.prototype.open = function(callback) {
  if (typeof callback === 'function') this.once('connect', callback);
  this.socket.connect(this.peer.port, this.peer.host);
  return this;
};

Connection.prototype.setupHandlers = function() {
  this.socket.addListener('connect', this.handleConnect.bind(this));
  this.socket.addListener('error', this.handleError.bind(this));
  this.socket.addListener('end', this.handleDisconnect.bind(this));
  this.socket.addListener('data', (function(data) {
    var dumpLen = 35;
    console.log('[' + this.peer + '] ' +
      'Received ' + data.length + ' bytes of data:');
 
  var bread = this.socket.bytesRead;
  var bwrite = this.socket.bytesWritten;
  console.log('Bytes read : ' + bread);
  console.log('Bytes written : ' + bwrite);
  console.log('Data sent to server : ' + data);

   //console.log(data.toString('hex').match(/../g).join(' '));
    //console.log('... ' + new Buffer(data.slice(0, dumpLen > data.length ?
   //     data.length : dumpLen)).toHex() +
  //    new Buffer(data.length > dumpLen ? '...' : '')).toHex();
//var str = '';
//for (var ii = 0; ii < data.length; ii++) {
//    str += data[ii].toString(16) + ' ' ;
//};
//console.log(str);

  }).bind(this));
  this.socket.addListener('data', this.handleData.bind(this));
};

Connection.prototype.handleConnect = function() {
  if (!this.inbound) {
    this.sendVersion();
  }
  this.emit('connect', {
    conn: this,
    socket: this.socket,
    peer: this.peer
  });
};

Connection.prototype.handleError = function(err) {
  if (err.errno == 110 || err.errno == 'ETIMEDOUT') {
    console.log('connection timed out for ' + this.peer);
  } else if (err.errno == 111 || err.errno == 'ECONNREFUSED') {
    console.log('connection refused for ' + this.peer);
  } else {
    console.log('connection with ' + this.peer + ' ' + err.toString());
  }
  this.emit('error', {
    conn: this,
    socket: this.socket,
    peer: this.peer,
    err: err
  });
};

Connection.prototype.handleDisconnect = function() {
  this.emit('disconnect', {
    conn: this,
    socket: this.socket,
    peer: this.peer
  });
};

Connection.prototype.handleMessage = function(message) {
  if (!message) {
    // Parser was unable to make sense of the message, drop it
    return;
  }

  try {
    console.log("CMD: " + message.command);
    console.log("CMDv: " + message.version);
    switch (message.command) {
      case 'version':
        // Did we connect to ourself?
        if (Buffer.compare(nonce, message.nonce) === 0) {
          this.socket.end();
          return;
        }

        if (this.inbound) {
          console.log("We send version now");
          this.sendVersion();
        }

        if (message.version >= 209) {
          this.sendMessage('verack', new Buffer([]));
          console.log("sent verack");
        }
        this.sendVer = Math.min(message.version, PROTOCOL_VERSION);
        console.log("V:" + this.sendVer);
        if (message.version < 209) {
          console.log("Whats up");
          this.recvVer = Math.min(message.version, PROTOCOL_VERSION);
        } else {
          // We won't start expecting a checksum until after we've received
          // the 'verack' message.
          this.once('verack', (function() {
            this.recvVer = message.version;
            console.log("We received: " + this.recvVer);
          }).bind(this));
        }
        this.bestHeight = message.start_height;
        break;

      case 'verack':
        this.recvVer = Math.min(message.version, PROTOCOL_VERSION);
        this.active = true;
        break;

      case 'ping':
        if ('object' === typeof message.nonce) {
          this.sendPong(message.nonce);
        }
        break;
    }
  } catch (e) {
    console.log('Error while handling "' + message.command + '" message from ' +
      this.peer + ':\n' +
      (e.stack ? e.stack : e.toString()));
    return;
  }
  this.emit(message.command, {
    conn: this,
    socket: this.socket,
    peer: this.peer,
    message: message
  });
};

Connection.prototype.sendPong = function(nonce) {
  this.sendMessage('pong', nonce);
};

Connection.prototype.sendFeeFilter = function() {
  console.log("So what");
};

Connection.prototype.sendVersion = function() {
  var subversion = '/Marscore:1.7/';

  var put = new Put();
  put.word32le(PROTOCOL_VERSION); // version
  put.word64le(1); // services
  put.word64le(Math.round(new Date().getTime() / 1000)); // timestamp
  put.pad(26); // addr_me
  put.pad(26); // addr_you
  put.put(nonce);
  put.varint(subversion.length);
  put.put(new Buffer(subversion, 'ascii'));
  put.word32le(0);

  this.sendMessage('version', put.buffer());
};

Connection.prototype.sendGetBlocks = function(starts, stop, wantHeaders) {
  // Default value for stop is 0 to get as many blocks as possible (500)
  stop = stop || util.NULL_HASH;

  var put = new Put();

  // https://en.bitcoin.it/wiki/Protocol_specification#getblocks
  put.word32le(this.sendVer);
  put.varint(starts.length);

  for (var i = 0; i < starts.length; i++) {
    if (starts[i].length != 32) {
      throw new Error('Invalid hash length');
    }

    put.put(starts[i]);
  }

  var stopBuffer = new Buffer(stop, 'binary');
  if (stopBuffer.length != 32) {
    throw new Error('Invalid hash length');
  }

  put.put(stopBuffer);

  var command = 'getblocks';
  if (wantHeaders)
    command = 'getheaders';
  this.sendMessage(command, put.buffer());
};

Connection.prototype.sendGetHeaders = function(starts, stop) {
  this.sendGetBlocks(starts, stop, true);
};

Connection.prototype.sendGetData = function(invs) {
  var put = new Put();
  put.varint(invs.length);
  for (var i = 0; i < invs.length; i++) {
    put.word32le(invs[i].type);
    put.put(invs[i].hash);
  }
  this.sendMessage('getdata', put.buffer());
};

Connection.prototype.sendGetAddr = function(invs) {
  var put = new Put();
  this.sendMessage('getaddr', put.buffer());
};

Connection.prototype.sendInv = function(data) {
  if (!Array.isArray(data)) data = [data];
  var put = new Put();
  put.varint(data.length);
  data.forEach(function(value) {
    if (value instanceof Block) {
      // Block
      put.word32le(2); // MSG_BLOCK
    } else {
      // Transaction
      put.word32le(1); // MSG_TX
    }
    put.put(value.getHash());
  });
  this.sendMessage('inv', put.buffer());
};

Connection.prototype.sendHeaders = function(headers) {
  var put = new Put();
  put.varint(headers.length);
  headers.forEach(function(header) {
    put.put(header);

    // Indicate 0 transactions
    put.word8(0);
  });
  this.sendMessage('headers', put.buffer());
};

Connection.prototype.sendTx = function(tx) {
  this.sendMessage('tx', tx.serialize());
};

Connection.prototype.sendBlock = function(block, txs) {
  var put = new Put();

  // Block header
  put.put(block.getHeader());

  // List of transactions
  put.varint(txs.length);
  txs.forEach(function(tx) {
    put.put(tx.serialize());
  });

  this.sendMessage('block', put.buffer());
};

Connection.prototype.sendMessage = function(command, payload) {
  try {
    var magic = this.network.networkMagic;
    console.log("Magic: " + magic);
    var commandBuf = new Buffer(command, 'ascii');
    if (commandBuf.length > 12) throw 'Command name too long';

    var checksum;
    if (this.sendVer >= 209) {
      checksum = doubleSha256(payload).slice(0, 4);
    } else {
      checksum = new Buffer([]);
    }

    var message = new Put(); // -- HEADER --
    message.put(magic); // magic bytes
    message.put(commandBuf); // command name
    message.pad(12 - commandBuf.length); // zero-padded
    message.word32le(payload.length); // payload length
    message.put(checksum); // checksum
    // -- BODY --
    message.put(payload); // payload data

    var buffer = message.buffer();

    console.log('[' + this.peer + '] ' +
      'Sending message ' + command + ' (' + payload.length + ' bytes)');

    this.socket.write(buffer);
  } catch (err) {
    // TODO: We should catch this error one level higher in order to better
    //       determine how to react to it. For now though, ignoring it will do.
    console.log('Error while sending message to peer ' + this.peer + ': ' +
      (err.stack ? err.stack : err.toString()));
  }
};

Connection.prototype.handleData = function(data) {
  this.buffers.push(data);

  if (this.buffers.length > MAX_RECEIVE_BUFFER) {
    console.log('Peer ' + this.peer + ' exceeded maxreceivebuffer, disconnecting.' +
      (err.stack ? err.stack : err.toString()));
    this.socket.destroy();
    return;
  }

  this.processData();
};

Connection.prototype.processData = function() {
  // If there are less than 20 bytes there can't be a message yet.
  if (this.buffers.length < 20) return;
  console.log("Processing data ... ");
  var magic = this.network.networkMagic;
  console.log("Magic check: " + this.buffers.get(0) + " should equal " + magic[0]);
  var i = 0;
  for (;;) {
    if (this.buffers.get(i) === magic[0] &&
      this.buffers.get(i + 1) === magic[1] &&
      this.buffers.get(i + 2) === magic[2] &&
      this.buffers.get(i + 3) === magic[3]) {
      if (i !== 0) {
        console.log('[' + this.peer + '] ' +
          'Received ' + i +
          ' bytes of inter-message garbage: ');
        console.log('... ' + this.buffers.slice(0, i));

        this.buffers.skip(i);
      }
      break;
    }

    if (i > (this.buffers.length - 4)) {
      this.buffers.skip(i);
      return;
    }
    i++;
  }
  console.log("Payload retrieval");
  var payloadLen = (this.buffers.get(16)) +
    (this.buffers.get(17) << 8) +
    (this.buffers.get(18) << 16) +
    (this.buffers.get(19) << 24);
  console.log("Payload retrieval 2");

  var startPos = (this.recvVer >= 209) ? 24 : 20;
  var endPos = startPos + payloadLen;

  console.log("Payload retrieval 3");
  if (this.buffers.length < endPos) return;

  console.log("Payload retrieval 4");
  var command = this.buffers.slice(4, 16).toString('ascii').replace(/\0+$/, '');
  console.log("Command processing " + command);
  var payload = this.buffers.slice(startPos, endPos);
  console.log("Payload processing " + payload);
  var checksum = (this.recvVer >= 209) ? this.buffers.slice(20, 24) : null;
  console.log("Checksum: " + checksum);

  console.log('[' + this.peer + '] ' +
    'Received message ' + command +
    ' (' + payloadLen + ' bytes)');

  if (checksum !== null) {
    var checksumConfirm = doubleSha256(payload).slice(0, 4);
    if (Buffer.compare(checksumConfirm, checksum) !== 0) {
      console.log('[' + this.peer + '] ' +
        'Checksum failed', {
          cmd: command,
          expected: checksumConfirm.toString('hex'),
          actual: checksum.toString('hex')
        });
      return;
    }
  }

  var message;
  try {
    message = this.parseMessage(command, payload);
  } catch (e) {
    console.log('Error while parsing message ' + command + ' from ' +
      this.peer + ':\n' +
      (e.stack ? e.stack : e.toString()));
  }

  if (message) {
    this.handleMessage(message);
  }

  this.buffers.skip(endPos);
  this.processData();
};

Connection.prototype.parseMessage = function(command, payload) {
  var parser = new Parser(payload);

  var data = {
    command: command
  };

  var i;

  switch (command) {
    case 'version': // https://en.bitcoin.it/wiki/Protocol_specification#version
      data.version = parser.word32le();
      data.services = parser.word64le();
      data.timestamp = parser.word64le();
      data.addr_me = parser.buffer(26);
      data.addr_you = parser.buffer(26);
      data.nonce = parser.buffer(8);
      data.subversion = parser.varStr();
      data.start_height = parser.word32le();
      break;

    case 'inv':
    case 'getdata':
      data.count = parser.varInt();

      data.invs = [];
      for (i = 0; i < data.count; i++) {
        data.invs.push({
          type: parser.word32le(),
          hash: parser.buffer(32)
        });
      }
      break;

    case 'headers':
      data.count = parser.varInt();

      data.headers = [];
      for (i = 0; i < data.count; i++) {
        var header = new Block();
        header.parse(parser);
        data.headers.push(header);
      }
      break;

    case 'block':
      var block = new Block();
      block.parse(parser);

      data.block = block;
      data.version = block.version;
      data.prev_hash = block.prev_hash;
      data.merkle_root = block.merkle_root;
      data.timestamp = block.timestamp;
      data.bits = block.bits;
      data.nonce = block.nonce;

      data.txs = block.txs;

      data.size = payload.length;
      break;

    case 'tx':
      var tx = new Transaction();
      tx.parse(parser);
      return {
        command: command,
        version: tx.version,
        lock_time: tx.lock_time,
        ins: tx.ins,
        outs: tx.outs,
        tx: tx,
      };
    case 'feefilter':
	console.log("Received fee filter, not interested");
    case 'getblocks':
    case 'getheaders':
      console.log("Received getheaders");
      // parse out the version
      data.version = parser.word32le();

      // TODO: Limit block locator size?
      // reference implementation limits to 500 results
      var startCount = parser.varInt();
      console.log("halfway getheaders");
      data.starts = [];
      for (i = 0; i < startCount; i++) {
        data.starts.push(parser.buffer(32));
      }
      data.stop = parser.buffer(32);
      break;

    case 'addr':
      var addrCount = parser.varInt();

      // Enforce a maximum number of addresses per message
      if (addrCount > 1000) {
        addrCount = 1000;
      }

      data.addrs = [];
      for (i = 0; i < addrCount; i++) {
        // TODO: Time actually depends on the version of the other peer (>=31402)
        data.addrs.push({
          time: parser.word32le(),
          services: parser.word64le(),
          ip: parser.buffer(16),
          port: parser.word16be()
        });
      }
      break;

    case 'alert':
      data.payload = parser.varStr();
      data.signature = parser.varStr();
      break;

    case 'ping':
      if (this.recvVer > BIP0031_VERSION) {
        data.nonce = parser.buffer(8);
      }
      break;

    case 'getaddr':
    case 'verack':
    case 'reject':
      // Empty message, nothing to parse
      break;

    default:
      console.log('Connection.parseMessage(): Command not implemented', {
        cmd: command
      });

      // This tells the calling function not to issue an event
      return null;
  }

  return data;
};

module.exports = Connection;
