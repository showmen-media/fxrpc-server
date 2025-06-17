const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const BSON = require('bson');

const __dirname = global.Citizen.getResourcePath();

const PROTO_PATH = `${__dirname}/fxsrv.proto`;
const packageDef = protoLoader.loadSync(PROTO_PATH);
const proto = grpc.loadPackageDefinition(packageDef).rpcservice;

const server = new grpc.Server();

class RpcStream {

	constructor(stream) {
		if (typeof this.receive == 'function') {
			stream.on('data', (pkg) => {
				const data = BSON.deserialize(pkg.data);
				this.receive(data);
			});
		}
		stream.on('end', stream.end);
		this.stream = stream;
	}

	send(data) {
		const bsonBuffer = BSON.serialize(data);
		return this.stream.write({ data: bsonBuffer });
	}

}


class EventsStream extends RpcStream {
	// private readonly
	_events = {};

	receive(data) {
		const { event, net, subscribe } = data;
		let subFn = 'on';
		if (net) subFn += 'Net';
		let eventsSet = this._events[subFn];
		if (!eventsSet) {
			eventsSet = this._events[subFn] = {};
		}
 		if (subscribe) {
			if (eventsSet[event]) return;
			global[subFn](event, (...args) => {
				this.send({
					event, isNet: net, args
				});
			});
			eventsSet[event] = true;
		}
	}
}

class ObjControlStream extends RpcStream {

	// private readonly
	_objects = {};

	constructor(stream) {
		super(stream);
		["_release", "_get", "emit", "emitNet"].forEach((name) => {
			this._objects[name] = this[name].bind(this);
		});
	}

	async receive(data) {
		let { id: fnId, fn, args } = data;
		args = args || [];
		let reply = {};
		let resultObjects;

		try {
			reply.resultId = await (async () => {

				const func = this._objects[fn];

				if (typeof func !== 'function') {
					throw new Error(`Function ${fn} not found`);
				}

				let result = func(...args);
				if (result instanceof Promise) {
					result = await result;
				}

				if (result === undefined) {
					return null;
				}

				if (!(result instanceof Object)) {
					resultObjects = { '0': result };
					return '0';
				}

				resultObjects = {};
				const recursiveSerialize = (original, returnCopy = false) => {
					const copy = original instanceof Array ? [] : {};
					Object.entries(original).forEach(([key, value]) => {
						copy[key] = (
							value instanceof Object
							? recursiveSerialize(value, true)
							: value
						);
					});
					const isFunction = typeof original === 'function';
					const id = (new BSON.ObjectId()).toString();
					if (isFunction || !returnCopy) {
						this._objects[id] = original;
						resultObjects[id] = copy;
						if (isFunction) {
							copy['__##function'] = id;
						}
					}
					return returnCopy ? copy : id;
				}

				return recursiveSerialize(result);

			})();
		}
		catch (error) {
			console.error(`Error in ObjControlStream: ${error.message}`);
			reply.error = error.message;
		}
		reply.fnId = fnId;
		reply.resultObjects = resultObjects;
		this.send(reply);
	}

	_release(id) {
		delete this._objects[id];
	}

	_get(...keys) {
		return keys.reduce((obj, key) => obj[key], global);
	}

	emit = global.emit;
	emitNet = global.emitNet;

}

server.addService(
	proto.RpcService.service,
	{
		EventsStream: (stream) => new EventsStream(stream),
		ObjControlStream: (stream) => new ObjControlStream(stream)
	}
);

server.bindAsync('0.0.0.0:50051', grpc.ServerCredentials.createInsecure(), () => {
	console.log('FxRPC Server running at 0.0.0.0:50051');
});
