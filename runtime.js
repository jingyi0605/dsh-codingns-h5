(function() {
	const MAGIC = new Uint8Array([
		68,
		83,
		72,
		1
	]);
	const channels = /* @__PURE__ */ new Set([
		"session",
		"rpc",
		"adapter",
		"pty",
		"task",
		"file",
		"port",
		"peerhost",
		"plugin",
		"web"
	]);
	/** 编码为 `DSH1 | 4 字节 JSON 头长度 | JSON 头 | 原始 body`。 */
	function encodeDshEnvelope(envelope, options = {}) {
		validateDshEnvelope(envelope);
		const maxBytes = options.maxBytes ?? 1048576;
		const maxMetaBytes = options.maxMetaBytes ?? 65536;
		validateLimit(maxBytes, "Envelope");
		validateLimit(maxMetaBytes, "Envelope meta");
		const body = envelope.body ?? /* @__PURE__ */ new Uint8Array();
		const header = {
			...envelope,
			bodyLength: body.byteLength
		};
		delete header.body;
		const headerBytes = new TextEncoder().encode(JSON.stringify(header));
		if (headerBytes.byteLength > maxMetaBytes) throw new Error("DSH Envelope meta 超过大小限制");
		const result = new Uint8Array(MAGIC.byteLength + 4 + headerBytes.byteLength + body.byteLength);
		result.set(MAGIC, 0);
		new DataView(result.buffer).setUint32(MAGIC.byteLength, headerBytes.byteLength);
		result.set(headerBytes, MAGIC.byteLength + 4);
		result.set(body, MAGIC.byteLength + 4 + headerBytes.byteLength);
		if (result.byteLength > maxBytes) throw new Error("DSH Envelope 超过大小限制");
		return result;
	}
	function decodeDshEnvelope(data, options = {}) {
		const maxBytes = options.maxBytes ?? 1048576;
		const maxMetaBytes = options.maxMetaBytes ?? 65536;
		validateLimit(maxBytes, "Envelope");
		validateLimit(maxMetaBytes, "Envelope meta");
		if (!(data instanceof Uint8Array)) throw new Error("DSH Envelope 必须是 Uint8Array");
		if (data.byteLength > maxBytes) throw new Error("DSH Envelope 超过大小限制");
		if (data.byteLength < MAGIC.byteLength + 4 || !MAGIC.every((value, index) => data[index] === value)) throw new Error("DSH Envelope magic 无效");
		const headerLength = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(MAGIC.byteLength);
		if (headerLength > maxMetaBytes || MAGIC.byteLength + 4 + headerLength > data.byteLength) throw new Error("DSH Envelope 头部长度无效");
		let header;
		try {
			header = JSON.parse(new TextDecoder().decode(data.subarray(MAGIC.byteLength + 4, MAGIC.byteLength + 4 + headerLength)));
		} catch (error) {
			throw new Error("DSH Envelope 头部不是有效 JSON", { cause: error });
		}
		if (!header || typeof header !== "object") throw new Error("DSH Envelope 头部无效");
		const value = header;
		const bodyLength = value.bodyLength;
		if (typeof bodyLength !== "number" || !Number.isSafeInteger(bodyLength) || bodyLength < 0 || MAGIC.byteLength + 4 + headerLength + bodyLength !== data.byteLength) throw new Error("DSH Envelope body 长度无效");
		delete value.bodyLength;
		validateDshEnvelope(value);
		const body = data.subarray(MAGIC.byteLength + 4 + headerLength);
		return body.byteLength === 0 ? value : {
			...value,
			body: body.slice()
		};
	}
	function validateDshEnvelope(value) {
		if (!value || typeof value !== "object") throw new Error("DSH Envelope 必须是对象");
		const envelope = value;
		if (envelope.version !== 1) throw new Error("DSH Envelope 版本不兼容");
		if (typeof envelope.messageId !== "string" || envelope.messageId.length === 0) throw new Error("DSH Envelope messageId 无效");
		if (typeof envelope.streamId !== "string" || envelope.streamId.length === 0) throw new Error("DSH Envelope streamId 无效");
		if (!channels.has(envelope.channel)) throw new Error("DSH Envelope channel 无效");
		if (typeof envelope.type !== "string" || envelope.type.length === 0) throw new Error("DSH Envelope type 无效");
		if (!Number.isSafeInteger(envelope.sequence) || envelope.sequence < 0) throw new Error("DSH Envelope sequence 无效");
		if (typeof envelope.generation !== "string" || envelope.generation.length === 0) throw new Error("DSH Envelope generation 无效");
		validateHostScope(envelope.hostScope);
		if (!envelope.meta || typeof envelope.meta !== "object" || Array.isArray(envelope.meta)) throw new Error("DSH Envelope meta 无效");
		if (envelope.body !== void 0 && !(envelope.body instanceof Uint8Array)) throw new Error("DSH Envelope body 必须是 Uint8Array");
	}
	function validateHostScope(scope) {
		if (!scope || typeof scope !== "object") throw new Error("DSH Envelope hostScope 无效");
		const value = scope;
		if (typeof value.hostId !== "string" || value.hostId.length === 0) throw new Error("DSH Envelope hostScope.hostId 无效");
		if (value.kind !== "local" && value.kind !== "remote") throw new Error("DSH Envelope hostScope.kind 无效");
		for (const key of [
			"hostLabel",
			"workspaceId",
			"sessionId"
		]) if (value[key] !== void 0 && typeof value[key] !== "string") throw new Error(`DSH Envelope hostScope.${key} 无效`);
	}
	function validateLimit(value, name) {
		if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} 大小限制无效`);
	}
	//#endregion
	//#region src/transport/multiplexer.ts
	const DEFAULT_SCOPE = {
		hostId: "unknown",
		kind: "remote"
	};
	/** DSH Envelope 层多路复用器；逻辑 API 保持 rpc/openStream，物理线路只发送二进制 Envelope。 */
	var DshTunnelMultiplexer = class {
		carrier;
		pending = /* @__PURE__ */ new Map();
		streams = /* @__PURE__ */ new Map();
		sequence = 0;
		nextId = 0;
		disposed = false;
		unsubscribe;
		idPrefix;
		flowControl;
		generation;
		hostScope;
		session;
		requireSessionReady;
		constructor(carrier, options = {}) {
			this.carrier = carrier;
			this.idPrefix = options.idPrefix ?? "g0";
			this.flowControl = options.flowControl;
			this.generation = options.generation ?? this.idPrefix.replace(/^g/u, "");
			this.hostScope = options.hostScope ?? DEFAULT_SCOPE;
			this.session = options.session;
			this.requireSessionReady = options.requireSessionReady ?? options.session !== void 0;
			this.unsubscribe = carrier.subscribe((data) => this.receive(data));
		}
		request(channel, payload, signal) {
			return this.requestOperation(channel, channel === "fetch" ? "web.request" : "rpc.request", payload, signal);
		}
		requestOperation(channel, operation, payload, signal) {
			this.ensureOpen();
			const id = `${this.idPrefix}_req_${this.nextRequestId()}`;
			return new Promise((resolve, reject) => {
				const abort = () => {
					if (!this.pending.delete(id)) return;
					if (!this.disposed && this.carrier.state === "open") try {
						this.send({
							streamId: id,
							channel: mapChannel(channel),
							type: "stream.cancel",
							meta: { reason: String(signal?.reason ?? "cancelled") }
						});
					} catch {}
					reject(signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("请求已取消"));
				};
				if (signal?.aborted) return abort();
				signal?.addEventListener("abort", abort, { once: true });
				this.pending.set(id, {
					resolve: (value) => {
						signal?.removeEventListener("abort", abort);
						resolve(value);
					},
					reject: (error) => {
						signal?.removeEventListener("abort", abort);
						reject(error);
					},
					accepted: false
				});
				try {
					this.send({
						streamId: id,
						channel: mapChannel(channel),
						type: "stream.open",
						meta: {
							operation,
							encoding: "json"
						},
						body: encodeJson(payload)
					});
				} catch (error) {
					this.pending.delete(id);
					signal?.removeEventListener("abort", abort);
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
		}
		openStream(payload, signal) {
			return this.openStreamOperation("rpc", "rpc.stream", payload, signal);
		}
		openStreamOperation(channel, operation, payload, signal) {
			return this.openStreamOperationWithId(channel, operation, payload, signal).stream;
		}
		openStreamOperationWithId(channel, operation, payload, signal) {
			this.ensureOpen();
			if (signal?.aborted) return {
				streamId: "",
				stream: this.closedStream()
			};
			const id = `${this.idPrefix}_stream_${this.nextRequestId()}`;
			const state = {
				queue: [],
				queuedBytes: 0,
				waiters: [],
				closed: false,
				removeAbort: void 0
			};
			this.streams.set(id, state);
			const cancel = () => {
				if (state.closed) return;
				state.closed = true;
				if (!this.disposed && this.carrier.state === "open") try {
					this.send({
						streamId: id,
						channel,
						type: "stream.cancel",
						meta: {}
					});
				} catch {}
				this.finishStream(id, state);
			};
			if (signal) {
				signal.addEventListener("abort", cancel, { once: true });
				state.removeAbort = () => signal.removeEventListener("abort", cancel);
			}
			try {
				this.send({
					streamId: id,
					channel,
					type: "stream.open",
					meta: {
						operation,
						encoding: "json"
					},
					body: encodeJson(payload)
				});
			} catch (error) {
				state.error = error instanceof Error ? error : new Error(String(error));
				this.finishStream(id, state);
			}
			return {
				streamId: id,
				stream: { [Symbol.asyncIterator]: () => ({
					next: async () => {
						if (state.error) throw state.error;
						if (state.queue.length > 0) {
							state.queuedBytes = 0;
							return {
								done: false,
								value: state.queue.shift()
							};
						}
						if (state.closed) return {
							done: true,
							value: void 0
						};
						return new Promise((resolve, reject) => state.waiters.push({
							resolve: (result) => resolve({
								done: result.done === true,
								value: result.value
							}),
							reject
						}));
					},
					return: async () => {
						cancel();
						return {
							done: true,
							value: void 0
						};
					}
				}) }
			};
		}
		sendStreamMessage(streamId, channel, type, meta = {}, body) {
			this.ensureOpen();
			this.send({
				streamId,
				channel,
				type,
				meta,
				...body === void 0 ? {} : { body }
			});
		}
		closeStream(streamId, channel = "web") {
			if (this.disposed || this.carrier.state !== "open") return;
			try {
				this.sendStreamMessage(streamId, channel, "stream.cancel", {});
			} catch {}
		}
		close(error = /* @__PURE__ */ new Error("Transport 已关闭")) {
			if (this.disposed) return;
			this.disposed = true;
			this.unsubscribe();
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
			for (const [id, stream] of this.streams) {
				stream.error = error;
				this.finishStream(id, stream);
			}
		}
		invalidate(error = /* @__PURE__ */ new Error("Transport generation 已过期")) {
			for (const pending of this.pending.values()) pending.reject(error);
			this.pending.clear();
			for (const [id, stream] of this.streams) {
				stream.error = error;
				this.finishStream(id, stream);
			}
		}
		rotateGeneration(idPrefix, error = /* @__PURE__ */ new Error("Transport generation 已过期")) {
			this.invalidate(error);
			this.idPrefix = idPrefix;
			this.generation = idPrefix.replace(/^g/u, "");
		}
		receive(data) {
			let envelope;
			try {
				if (typeof data === "string") envelope = legacyEnvelope(JSON.parse(data));
				else envelope = decodeDshEnvelope(data, this.flowControl?.maxFrameBytes === void 0 ? {} : { maxBytes: this.flowControl.maxFrameBytes });
			} catch (error) {
				this.close(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			if (envelope.generation !== this.generation || envelope.hostScope.hostId !== this.hostScope.hostId || envelope.hostScope.kind !== this.hostScope.kind) return;
			this.flowControl?.onReceive?.(typeof data === "string" ? new TextEncoder().encode(data).byteLength : data.byteLength, envelope);
			const state = this.streams.get(envelope.streamId);
			const pending = this.pending.get(envelope.streamId);
			if (state) return this.receiveStream(envelope, state);
			if (!pending) return;
			if (envelope.type === "stream.accepted") {
				pending.accepted = true;
				return;
			}
			if (envelope.type.endsWith(".response")) {
				this.pending.delete(envelope.streamId);
				pending.resolve(decodePayload(envelope));
			} else if (envelope.type === "stream.close") {
				this.pending.delete(envelope.streamId);
				pending.resolve(decodePayload(envelope));
			} else if (envelope.type === "stream.error" || envelope.type.endsWith(".error")) {
				this.pending.delete(envelope.streamId);
				pending.reject(new Error(typeof envelope.meta.detail === "string" ? envelope.meta.detail : "远端请求失败"));
			}
		}
		receiveStream(envelope, state) {
			if (envelope.type === "stream.accepted") return;
			if (envelope.type === "stream.error" || envelope.type.endsWith(".error")) {
				state.error = new Error(typeof envelope.meta.detail === "string" ? envelope.meta.detail : "远端流失败");
				this.finishStream(envelope.streamId, state);
				return;
			}
			if (envelope.type === "stream.close" || envelope.flags?.endOfStream) {
				this.finishStream(envelope.streamId, state);
				return;
			}
			if (envelope.type === "stream.window") return;
			const value = decodePayload(envelope);
			state.queuedBytes += envelope.body?.byteLength ?? 0;
			if (state.queuedBytes > (this.flowControl?.maxQueueBytes ?? 4194304)) {
				state.error = /* @__PURE__ */ new Error("Transport 队列超过上限");
				this.finishStream(envelope.streamId, state);
				return;
			}
			if (state.waiters.length > 0) state.waiters.shift()?.resolve({
				done: false,
				value
			});
			else state.queue.push(value);
		}
		finishStream(id, state) {
			state.closed = true;
			state.removeAbort?.();
			state.removeAbort = void 0;
			this.streams.delete(id);
			for (const waiter of state.waiters.splice(0)) state.error ? waiter.reject(state.error) : waiter.resolve({
				done: true,
				value: void 0
			});
		}
		send(input) {
			const envelope = {
				version: 1,
				messageId: `${this.idPrefix}_m_${this.nextSequence()}`,
				streamId: input.streamId,
				channel: input.channel,
				type: input.type,
				sequence: this.nextSequence(),
				generation: this.generation,
				hostScope: this.hostScope,
				meta: input.meta ?? {},
				...input.body === void 0 ? {} : { body: input.body },
				...input.flags === void 0 ? {} : { flags: input.flags }
			};
			const encoded = encodeDshEnvelope(envelope, this.flowControl?.maxFrameBytes === void 0 ? {} : { maxBytes: this.flowControl.maxFrameBytes });
			if (this.flowControl?.canSend && !this.flowControl.canSend(encoded.byteLength, envelope)) throw new Error("Transport 背压窗口不足");
			const pending = this.carrier.send(encoded);
			if (pending && typeof pending.catch === "function") pending.catch((error) => this.close(error instanceof Error ? error : new Error(String(error))));
			this.flowControl?.onSend?.(encoded.byteLength, envelope);
		}
		nextSequence() {
			if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new Error("DSH Envelope sequence 已耗尽");
			return ++this.sequence;
		}
		nextRequestId() {
			if (this.nextId >= Number.MAX_SAFE_INTEGER) throw new Error("Transport request id 已耗尽");
			return ++this.nextId;
		}
		closedStream(error) {
			return { [Symbol.asyncIterator]: () => ({ next: async () => error ? Promise.reject(error) : {
				done: true,
				value: void 0
			} }) };
		}
		ensureOpen() {
			if (this.disposed || this.carrier.state !== "open") throw new Error("Transport 尚未 ready");
			if (this.requireSessionReady && !this.session?.ready) throw new Error("SESSION_NOT_READY");
		}
	};
	function mapChannel(channel) {
		return channel === "fetch" || channel === "web" ? "web" : channel === "control" ? "session" : "rpc";
	}
	function encodeJson(value) {
		return new TextEncoder().encode(JSON.stringify(value === void 0 ? null : value));
	}
	function decodePayload(envelope) {
		if (envelope.meta.encoding === "json" && envelope.body) try {
			return JSON.parse(new TextDecoder().decode(envelope.body));
		} catch {
			return envelope.body;
		}
		return envelope.body ?? envelope.meta.payload;
	}
	function legacyEnvelope(value) {
		if (typeof value.id !== "string" || typeof value.kind !== "string" || !Number.isSafeInteger(value.sequence)) throw new Error("Tunnel Frame 无效");
		const channel = value.channel === "fetch" ? "web" : value.channel === "control" ? "session" : "rpc";
		return {
			version: 1,
			messageId: value.id,
			streamId: value.id,
			channel,
			type: `${value.channel}.${value.kind}`,
			sequence: value.sequence,
			generation: "1",
			hostScope: {
				hostId: "unknown",
				kind: "remote"
			},
			meta: {
				encoding: "json",
				...value.payload === void 0 ? {} : { payload: value.payload }
			},
			...value.payload === void 0 ? {} : { body: new TextEncoder().encode(JSON.stringify(value.payload)) }
		};
	}
	//#endregion
	//#region src/transport/dsh-transport.ts
	/** 将 Tunnel Multiplexer 映射为 DSH ClientTransportHooks。 */
	var DshCodingNsTransport = class {
		options;
		listeners = /* @__PURE__ */ new Set();
		multiplexer;
		generation;
		constructor(options) {
			this.options = options;
			this.generation = options.generation;
			this.multiplexer = new DshTunnelMultiplexer(options.carrier, {
				idPrefix: `g${options.generation.id}`,
				generation: String(options.generation.id),
				...options.hostScope ? { hostScope: options.hostScope } : {},
				...options.session ? { session: options.session } : {},
				...options.requireSessionReady === void 0 ? {} : { requireSessionReady: options.requireSessionReady },
				...options.flowControl ? { flowControl: options.flowControl } : {}
			});
		}
		rpc(request) {
			return this.multiplexer.request("rpc", request, request.signal);
		}
		async fetch(input, init) {
			const result = await this.multiplexer.request("fetch", {
				input: String(input),
				init: init ? {
					method: init.method,
					headers: [...new Headers(init.headers).entries()],
					body: typeof init.body === "string" ? init.body : void 0
				} : void 0
			}, init?.signal ?? void 0);
			return new Response(result.body, {
				status: result.status,
				headers: result.headers
			});
		}
		/** 向 Host 的 Remote Web Runtime 发送带明确 operation 的请求。 */
		webRequest(operation, payload, signal) {
			return this.multiplexer.requestOperation("web", operation, payload, signal);
		}
		/** 打开一个由 Remote Web Runtime 管理的 Web 流。 */
		openWebStream(operation, payload, signal) {
			return this.multiplexer.openStreamOperation("web", operation, payload, signal);
		}
		openWebStreamWithId(operation, payload, signal) {
			return this.multiplexer.openStreamOperationWithId("web", operation, payload, signal);
		}
		sendWebStream(streamId, type, body, meta = {}) {
			this.multiplexer.sendStreamMessage(streamId, "web", type, meta, body);
		}
		closeWebStream(streamId) {
			this.multiplexer.closeStream(streamId, "web");
		}
		openStream(request) {
			return this.multiplexer.openStream(request, request.signal);
		}
		loadBundle(url) {
			return this.multiplexer.request("control", {
				method: "loadBundle",
				url
			}).then(() => void 0);
		}
		getGeneration() {
			return this.generation;
		}
		onGenerationChange(listener) {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		}
		async reconnect(signal) {
			if (!this.options.reconnect) throw new Error("未配置 Transport reconnect");
			const nextGeneration = await this.options.reconnect(signal);
			if (nextGeneration) this.updateGeneration(nextGeneration);
		}
		/** 由启动胶水在建立新物理连接后提交新 generation。旧请求会立即失效。 */
		updateGeneration(generation) {
			if (this.generation?.id === generation.id) return;
			this.multiplexer.rotateGeneration(`g${generation.id}`);
			this.generation = generation;
			for (const listener of [...this.listeners]) listener(generation);
		}
		close() {
			this.multiplexer.close();
			const previous = this.generation;
			this.generation = void 0;
			if (previous) for (const listener of [...this.listeners]) listener(void 0);
			return this.options.carrier.close();
		}
		/** 给 pre-Cordis 启动胶水使用，不直接安装 DSH Connection。 */
		asTransportHooks() {
			const hooks = {
				rpc: this.rpc.bind(this),
				fetch: this.fetch.bind(this),
				openStream: this.openStream.bind(this),
				loadBundle: this.loadBundle.bind(this),
				generation: this.getGeneration.bind(this),
				onGenerationChange: this.onGenerationChange.bind(this),
				reconnect: this.reconnect.bind(this),
				close: this.close.bind(this)
			};
			if (this.options.ownsHost !== void 0) hooks.ownsHost = this.options.ownsHost;
			if (this.options.streamBaseUrl !== void 0) hooks.streamBaseUrl = this.options.streamBaseUrl;
			return hooks;
		}
	};
	//#endregion
	//#region src/transport/dsh-session.ts
	/** 负责 DSH hello/ready、版本能力协商和心跳，不执行任何业务。 */
	var DshSession = class {
		options;
		stateValue = "idle";
		listeners = /* @__PURE__ */ new Set();
		unsubscribe;
		heartbeat;
		messageCounter = 0;
		remoteCapabilities = [];
		readyValue;
		readyResolve;
		readyReject;
		constructor(options) {
			this.options = options;
			this.unsubscribe = options.carrier.subscribe((data) => this.receive(data));
			if (options.onEnvelope) this.listeners.add(options.onEnvelope);
		}
		get state() {
			return this.stateValue;
		}
		get ready() {
			return this.stateValue === "ready";
		}
		get capabilities() {
			return this.remoteCapabilities;
		}
		start() {
			if (this.stateValue !== "idle") return;
			this.stateValue = "handshaking";
			this.readyValue = new Promise((resolve, reject) => {
				this.readyResolve = resolve;
				this.readyReject = reject;
			});
			if (this.options.role === "client") this.sendHello();
			this.startHeartbeat();
		}
		waitReady(signal) {
			if (this.ready) return Promise.resolve();
			if (this.stateValue === "closed") return Promise.reject(/* @__PURE__ */ new Error("DSH Session 已关闭"));
			if (!this.readyValue) this.start();
			const promise = this.readyValue;
			if (!signal) return promise;
			if (signal.aborted) return Promise.reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("会话等待已取消"));
			return Promise.race([promise, new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("会话等待已取消")), { once: true }))]);
		}
		subscribe(listener) {
			this.listeners.add(listener);
			return () => this.listeners.delete(listener);
		}
		send(envelope) {
			if (this.stateValue === "closed") throw new Error("DSH Session 已关闭");
			const pending = this.options.carrier.send(encodeDshEnvelope(envelope));
			if (pending && typeof pending.catch === "function") pending.catch((error) => this.fail(error instanceof Error ? error : new Error(String(error))));
		}
		close(reason = "DSH Session 已关闭") {
			if (this.stateValue === "closed") return;
			this.stateValue = "closed";
			this.unsubscribe();
			if (this.heartbeat) clearInterval(this.heartbeat);
			this.heartbeat = void 0;
			this.readyReject?.(new Error(reason));
			this.readyReject = void 0;
			this.readyResolve = void 0;
		}
		sendHello() {
			this.send(this.createEnvelope("session.hello", "session", {
				protocol: this.options.protocol ?? "dsh-transport-v1",
				dshVersion: this.options.dshVersion ?? "0.1.6-alpha.2",
				capabilities: [...this.options.capabilities ?? []]
			}));
		}
		sendReady(capabilities) {
			this.send(this.createEnvelope("session.ready", "session", {
				protocol: this.options.protocol ?? "dsh-transport-v1",
				dshVersion: this.options.dshVersion ?? "0.1.6-alpha.2",
				capabilities: [...capabilities],
				byteCredit: 65536,
				messageCredit: 32
			}));
		}
		receive(data) {
			if (this.stateValue === "closed") return;
			let envelope;
			try {
				envelope = decodeDshEnvelope(data);
				this.validateScope(envelope);
			} catch (error) {
				this.fail(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			if (envelope.channel === "session") {
				this.receiveSession(envelope);
				return;
			}
			if (!this.ready) {
				this.fail(/* @__PURE__ */ new Error("SESSION_NOT_READY"));
				return;
			}
			for (const listener of [...this.listeners]) listener(envelope);
		}
		receiveSession(envelope) {
			if (envelope.type === "session.hello") {
				if (this.options.role !== "host" || envelope.sequence !== 0 || this.stateValue === "ready") {
					this.fail(/* @__PURE__ */ new Error("非法 session.hello"));
					return;
				}
				const protocol = envelope.meta.protocol;
				const dshVersion = envelope.meta.dshVersion;
				if (protocol !== (this.options.protocol ?? "dsh-transport-v1") || dshVersion !== (this.options.dshVersion ?? "0.1.6-alpha.2")) {
					this.fail(/* @__PURE__ */ new Error("PROTOCOL_VERSION_UNSUPPORTED"));
					return;
				}
				const offered = readCapabilities(envelope.meta.capabilities);
				const allowed = new Set(this.options.capabilities ?? offered);
				this.remoteCapabilities = offered.filter((capability) => allowed.has(capability));
				this.stateValue = "ready";
				this.sendReady(this.remoteCapabilities);
				this.readyResolve?.();
				this.options.onReady?.(this);
				return;
			}
			if (envelope.type === "session.ready") {
				if (this.options.role !== "client" || this.stateValue !== "handshaking") {
					this.fail(/* @__PURE__ */ new Error("非法 session.ready"));
					return;
				}
				const protocol = envelope.meta.protocol;
				const dshVersion = envelope.meta.dshVersion;
				if (protocol !== (this.options.protocol ?? "dsh-transport-v1") || dshVersion !== (this.options.dshVersion ?? "0.1.6-alpha.2")) {
					this.fail(/* @__PURE__ */ new Error("PROTOCOL_VERSION_UNSUPPORTED"));
					return;
				}
				this.remoteCapabilities = readCapabilities(envelope.meta.capabilities);
				this.stateValue = "ready";
				this.readyResolve?.();
				this.options.onReady?.(this);
				return;
			}
			if (envelope.type === "session.ping") {
				this.send(this.createEnvelope("session.pong", "session", { timestamp: Date.now() }));
				return;
			}
			if (envelope.type === "session.pong") return;
			if (envelope.type === "session.close") {
				this.close(typeof envelope.meta.reason === "string" ? envelope.meta.reason : "远端关闭 DSH Session");
				return;
			}
			this.fail(/* @__PURE__ */ new Error("MESSAGE_INVALID"));
		}
		validateScope(envelope) {
			if (envelope.generation !== this.options.generation || envelope.hostScope.hostId !== this.options.hostScope.hostId || envelope.hostScope.kind !== this.options.hostScope.kind) throw new Error("RESOURCE_SCOPE_STALE");
		}
		createEnvelope(type, channel, meta) {
			return {
				version: 1,
				messageId: `${this.options.role[0]}_${++this.messageCounter}`,
				streamId: "session",
				channel,
				type,
				sequence: this.messageCounter - 1,
				generation: this.options.generation,
				hostScope: this.options.hostScope,
				meta
			};
		}
		startHeartbeat() {
			const interval = this.options.heartbeatMs ?? 3e4;
			if (!Number.isFinite(interval) || interval <= 0) return;
			this.heartbeat = setInterval(() => {
				if (this.stateValue === "closed") return;
				try {
					this.send(this.createEnvelope("session.ping", "session", { timestamp: Date.now() }));
				} catch (error) {
					this.fail(error instanceof Error ? error : new Error(String(error)));
				}
			}, interval);
		}
		fail(error) {
			this.stateValue = "degraded";
			this.readyReject?.(error);
			this.options.onError?.(error);
		}
	};
	function readCapabilities(value) {
		if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("MESSAGE_INVALID");
		return [...new Set(value)];
	}
	const TUNNEL_FRAME_TYPE_CODES = {
		"http.request": 1,
		"http.response.start": 2,
		"http.response.chunk": 3,
		"http.response.end": 4,
		"ws.open": 5,
		"ws.opened": 6,
		"ws.message": 7,
		"ws.closed": 8,
		error: 9,
		hello: 10,
		ping: 11,
		pong: 12,
		"http.request.chunk": 13,
		"http.request.end": 14,
		"ws.message.chunk": 15,
		"ws.message.end": 16
	};
	var TunnelFrameError = class extends Error {
		code;
		constructor(message, code) {
			super(message);
			this.code = code;
			this.name = "TunnelFrameError";
		}
	};
	new Map(Object.entries(TUNNEL_FRAME_TYPE_CODES).map(([k, v]) => [v, k]));
	const encoder = new TextEncoder();
	new TextDecoder("utf-8");
	const empty = /* @__PURE__ */ new Uint8Array(0);
	function encodeFrame(frame) {
		const code = TUNNEL_FRAME_TYPE_CODES[frame.type];
		if (typeof code !== "number") throw new TunnelFrameError(`未知的帧类型：${String(frame.type)}`, "UNKNOWN_FRAME_TYPE");
		const meta = encoder.encode(JSON.stringify(metaOf(frame)));
		const body = bodyOf(frame);
		if (meta.byteLength > 1048576) throw new TunnelFrameError(`帧 ${frame.type} 的 meta 超过上限`, "META_TOO_LARGE");
		if (body.byteLength > 49152) throw new TunnelFrameError(`帧 ${frame.type} 的 body 超过单帧上限`, "BODY_TOO_LARGE");
		const output = new Uint8Array(10 + meta.byteLength + body.byteLength);
		const view = new DataView(output.buffer);
		view.setUint8(0, 1);
		view.setUint8(1, code);
		view.setUint32(2, meta.byteLength);
		view.setUint32(6, body.byteLength);
		output.set(meta, 10);
		output.set(body, 10 + meta.byteLength);
		return output;
	}
	function metaOf(frame) {
		switch (frame.type) {
			case "http.request": return {
				streamId: frame.streamId,
				method: frame.method,
				path: frame.path,
				headers: frame.headers
			};
			case "http.response.start": return {
				streamId: frame.streamId,
				status: frame.status,
				headers: frame.headers
			};
			case "http.request.chunk":
			case "http.request.end":
			case "http.response.chunk":
			case "http.response.end":
			case "ws.message.end": return { streamId: frame.streamId };
			case "ws.open": return {
				streamId: frame.streamId,
				path: frame.path,
				headers: frame.headers,
				protocols: frame.protocols
			};
			case "ws.opened": return {
				streamId: frame.streamId,
				selectedProtocol: frame.selectedProtocol
			};
			case "ws.message":
			case "ws.message.chunk": return {
				streamId: frame.streamId,
				binary: frame.binary
			};
			case "ws.closed": return {
				streamId: frame.streamId,
				code: frame.code,
				reason: frame.reason
			};
			case "error": return {
				streamId: frame.streamId,
				errorCode: frame.errorCode,
				detail: frame.detail
			};
			case "hello": return {
				clientContext: frame.clientContext,
				protocolVersion: frame.protocolVersion
			};
			case "ping":
			case "pong": return { at: frame.at };
		}
	}
	function bodyOf(frame) {
		return "body" in frame ? frame.body : empty;
	}
	//#endregion
	//#region src/transport/carrier.ts
	const TUNNEL_DATA_CHANNEL_LABEL = "codingns-tunnel";
	/** 将浏览器或 Node WebRTC DataChannel 包装为带背压的二进制 Carrier。 */
	function createDataChannelCarrier(channel, options = {}) {
		let state = channel.readyState === "open" ? "open" : "connecting";
		const listeners = /* @__PURE__ */ new Set();
		const high = options.highWaterMark ?? 1048576;
		const low = options.lowWaterMark ?? 262144;
		const timeoutMs = options.backpressureTimeoutMs ?? 3e4;
		let chain = Promise.resolve();
		const onOpen = () => {
			state = "open";
		};
		const onClose = () => {
			state = "closed";
			listeners.clear();
		};
		const onMessage = (event) => {
			const value = event.data;
			const bytes = toBytes$1(value);
			if (!bytes) return;
			for (const listener of [...listeners]) listener(bytes);
		};
		channel.addEventListener("open", onOpen);
		channel.addEventListener("close", onClose);
		channel.addEventListener("message", onMessage);
		const waitOpen = () => state === "open" ? Promise.resolve() : new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(/* @__PURE__ */ new Error("等待 DataChannel open 超时"));
			}, timeoutMs);
			const cleanup = () => {
				clearTimeout(timer);
				channel.removeEventListener("open", onReady);
				channel.removeEventListener("close", onFail);
			};
			const onReady = () => {
				cleanup();
				resolve();
			};
			const onFail = () => {
				cleanup();
				reject(/* @__PURE__ */ new Error("DataChannel 已关闭"));
			};
			channel.addEventListener("open", onReady);
			channel.addEventListener("close", onFail);
		});
		const waitBackpressure = () => {
			if ((channel.bufferedAmount ?? 0) <= high) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					cleanup();
					reject(/* @__PURE__ */ new Error("DataChannel 背压等待超时"));
				}, timeoutMs);
				const check = () => {
					if ((channel.bufferedAmount ?? 0) <= low) {
						cleanup();
						resolve();
					}
				};
				const cleanup = () => {
					clearTimeout(timer);
					channel.removeEventListener("bufferedamountlow", check);
					channel.removeEventListener("close", fail);
				};
				const fail = () => {
					cleanup();
					reject(/* @__PURE__ */ new Error("DataChannel 已关闭"));
				};
				channel.bufferedAmountLowThreshold = low;
				channel.addEventListener("bufferedamountlow", check);
				channel.addEventListener("close", fail);
				check();
			});
		};
		return {
			get state() {
				return state;
			},
			send(data) {
				if (!(data instanceof Uint8Array)) return Promise.reject(/* @__PURE__ */ new TypeError("Carrier 只接受 Uint8Array"));
				chain = chain.then(async () => {
					await waitOpen();
					if (state !== "open") throw new Error("CodingNS DataChannel 尚未 ready");
					await waitBackpressure();
					channel.send(data);
				});
				return chain;
			},
			subscribe(listener) {
				listeners.add(listener);
				return () => listeners.delete(listener);
			},
			async close() {
				if (state === "closed") return;
				state = "closed";
				channel.close();
				channel.removeEventListener("open", onOpen);
				channel.removeEventListener("close", onClose);
				channel.removeEventListener("message", onMessage);
				listeners.clear();
			}
		};
	}
	function toBytes$1(value) {
		if (value instanceof Uint8Array) return new Uint8Array(value);
		if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
		if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
		return null;
	}
	//#endregion
	//#region src/transport/webrtc-client.ts
	/** 客户端发起 offer，校验 Host fingerprint 后返回 DataChannel Carrier。 */
	async function connectWebRtcClient(options) {
		const ticket = options.signalingTicket;
		const signalingUrl = createSignalingUrl(ticket.signalingBaseUrl, ticket.ticket);
		const signaling = await options.signalingSocketFactory(signalingUrl);
		const cleanupListeners = [];
		if ("readyState" in signaling) {
			await waitForSignalingRegistered(signaling, options.timeoutMs ?? 15e3, cleanupListeners);
			await waitForPeerReady(signaling, options.timeoutMs ?? 15e3, cleanupListeners);
		}
		const heartbeat = options.heartbeatIntervalMs === 0 ? null : setInterval(() => {
			try {
				signaling.send(JSON.stringify({
					type: "ping",
					at: (/* @__PURE__ */ new Date()).toISOString()
				}));
			} catch {}
		}, options.heartbeatIntervalMs ?? 2e4);
		cleanupListeners.push(() => {
			if (heartbeat) clearInterval(heartbeat);
		});
		const peerConnection = options.peerConnectionFactory({
			iceServers: ticket.iceServers,
			iceTransportPolicy: ticket.iceTransportPolicy
		});
		const channel = peerConnection.createDataChannel(TUNNEL_DATA_CHANNEL_LABEL);
		const carrier = createDataChannelCarrier(channel);
		let closed = false;
		const close = async () => {
			if (closed) return;
			closed = true;
			for (const cleanup of cleanupListeners.splice(0)) cleanup();
			await carrier.close();
			peerConnection.close();
			signaling.close(1e3, "client closed");
		};
		try {
			const answerPromise = waitForAnswer(signaling, options.timeoutMs ?? 15e3, cleanupListeners);
			peerConnection.onicecandidate = (event) => {
				if (!event.candidate) return;
				signaling.send(JSON.stringify({
					type: "candidate",
					candidate: event.candidate.candidate,
					mid: event.candidate.sdpMid
				}));
			};
			const offer = await peerConnection.createOffer();
			await peerConnection.setLocalDescription(offer);
			signaling.send(JSON.stringify({
				type: "offer",
				sdp: offer.sdp ?? ""
			}));
			const answer = await answerPromise;
			assertDtlsFingerprint(ticket.hostDtlsFingerprint, answer.sdp);
			await peerConnection.setRemoteDescription({
				type: "answer",
				sdp: answer.sdp
			});
			for (const candidate of answer.candidates) await peerConnection.addIceCandidate(candidate);
			await waitForOpen(channel, options.timeoutMs ?? 15e3, cleanupListeners);
			await carrier.send(encodeFrame({
				type: "hello",
				clientContext: null,
				protocolVersion: "1"
			}));
			return {
				carrier,
				peerConnection,
				signaling,
				close
			};
		} catch (error) {
			await close();
			throw error;
		}
	}
	function createSignalingUrl(baseUrl, ticket) {
		const base = new URL(ensureWebSocketProtocol(baseUrl));
		const pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
		const url = new URL("signal", `${base.origin}${pathname}`);
		url.searchParams.set("ticket", ticket);
		return url.toString();
	}
	function waitForSignalingRegistered(socket, timeoutMs, cleanup = []) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				remove();
				reject(/* @__PURE__ */ new Error("等待 Relay registered 超时"));
			}, timeoutMs);
			const onMessage = (event) => {
				const raw = event.data;
				if (typeof raw !== "string") return;
				try {
					if (JSON.parse(raw).type !== "registered") return;
					clearTimeout(timer);
					remove();
					resolve();
				} catch {}
			};
			const onClose = () => {
				clearTimeout(timer);
				remove();
				reject(/* @__PURE__ */ new Error("信令连接在 registered 前关闭"));
			};
			const remove = () => {
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("close", onClose);
			};
			socket.addEventListener("message", onMessage);
			socket.addEventListener("close", onClose);
			cleanup.push(remove);
		});
	}
	/** Relay 只有在 Host 在线后才接受客户端 offer，避免过早发送被 HOST_NOT_CONNECTED 拒绝。 */
	function waitForPeerReady(socket, timeoutMs, cleanup = []) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				remove();
				reject(/* @__PURE__ */ new Error("等待 Relay peer-ready 超时"));
			}, timeoutMs);
			const onMessage = (event) => {
				const raw = event.data;
				if (typeof raw !== "string") return;
				try {
					const message = JSON.parse(raw);
					if (message.type === "peer-ready") {
						clearTimeout(timer);
						remove();
						resolve();
					} else if (message.type === "error") {
						clearTimeout(timer);
						remove();
						reject(/* @__PURE__ */ new Error("Relay 拒绝 peer-ready"));
					}
				} catch {}
			};
			const onClose = () => {
				clearTimeout(timer);
				remove();
				reject(/* @__PURE__ */ new Error("信令连接在 peer-ready 前关闭"));
			};
			const remove = () => {
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("close", onClose);
			};
			socket.addEventListener("message", onMessage);
			socket.addEventListener("close", onClose);
			cleanup.push(remove);
		});
	}
	function extractDtlsFingerprint(sdp) {
		const match = sdp.match(/^a=fingerprint:([^\r\n]+)$/mu);
		return match?.[1] ? normalizeFingerprint(match[1]) : null;
	}
	function assertDtlsFingerprint(expected, sdp) {
		const actual = extractDtlsFingerprint(sdp);
		if (!actual || actual !== normalizeFingerprint(expected)) throw new Error("Host DTLS fingerprint 校验失败");
	}
	function waitForAnswer(socket, timeoutMs, cleanup) {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(/* @__PURE__ */ new Error("等待 Host answer 超时")), timeoutMs);
			const candidates = [];
			const onMessage = (event) => {
				const raw = event.data;
				if (typeof raw !== "string") return;
				let message;
				try {
					message = JSON.parse(raw);
				} catch {
					return;
				}
				if (message.type === "answer") {
					clearTimeout(timer);
					remove();
					resolve({
						sdp: message.sdp,
						candidates
					});
				} else if (message.type === "candidate") candidates.push({
					candidate: message.candidate,
					sdpMid: message.mid
				});
				else if (message.type === "error") {
					clearTimeout(timer);
					remove();
					reject(/* @__PURE__ */ new Error(`${message.errorCode}: ${message.detail}`));
				}
			};
			const onClose = () => {
				clearTimeout(timer);
				remove();
				reject(/* @__PURE__ */ new Error("信令连接已关闭"));
			};
			const remove = () => {
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("close", onClose);
			};
			socket.addEventListener("message", onMessage);
			socket.addEventListener("close", onClose);
			cleanup.push(remove);
		});
	}
	function waitForOpen(channel, timeoutMs, cleanup) {
		if (channel.readyState === "open") return Promise.resolve();
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				remove();
				reject(/* @__PURE__ */ new Error("等待 DataChannel open 超时"));
			}, timeoutMs);
			const onOpen = () => {
				clearTimeout(timer);
				remove();
				resolve();
			};
			const onClose = () => {
				clearTimeout(timer);
				remove();
				reject(/* @__PURE__ */ new Error("DataChannel 在 ready 前关闭"));
			};
			const remove = () => {
				channel.removeEventListener("open", onOpen);
				channel.removeEventListener("close", onClose);
			};
			channel.addEventListener("open", onOpen);
			channel.addEventListener("close", onClose);
			cleanup.push(remove);
		});
	}
	function normalizeFingerprint(value) {
		return value.trim().replace(/^[a-z0-9-]+(?:\s+|:)+/iu, "").replace(/[^0-9a-f]/giu, "").toLowerCase();
	}
	function ensureWebSocketProtocol(value) {
		const url = new URL(value);
		if (url.protocol === "http:") url.protocol = "ws:";
		if (url.protocol === "https:") url.protocol = "wss:";
		if (url.protocol !== "ws:" && url.protocol !== "wss:") throw new Error("Relay URL 必须使用 HTTP(S) 或 WS(S)");
		return url.toString();
	}
	//#endregion
	//#region src/client/remote-web-context.ts
	/**
	* 一个 HostScope 对应一个独立 iframe。iframe 内的 fetch 和 WebSocket 都经由
	* postMessage 回到父页面，再由 DSH Transport 走 web.* Envelope；页面本身不接触
	* ticket、Control API 凭据或 Host 的本地地址。
	*/
	var RemoteDshWebContext = class {
		options;
		objectUrls = /* @__PURE__ */ new Set();
		sockets = /* @__PURE__ */ new Map();
		iframeValue;
		sessionIdValue;
		disposed = false;
		onMessageBound = (event) => {
			this.onMessage(event);
		};
		constructor(options) {
			this.options = options;
			if (typeof document === "undefined") throw new Error("Remote DSH Web Context 只能运行在浏览器");
		}
		get iframe() {
			return this.iframeValue;
		}
		get sessionId() {
			return this.sessionIdValue;
		}
		async open(signal) {
			this.ensureOpen();
			window.addEventListener("message", this.onMessageBound);
			const session = await this.options.transport.webRequest("web.session.open", {
				...this.options.workspaceId ? { workspaceId: this.options.workspaceId } : {},
				...this.options.sessionId ? { sessionId: this.options.sessionId } : {}
			}, signal);
			this.sessionIdValue = session.sessionId;
			const boot = await this.options.transport.webRequest("web.boot.get", { sessionId: session.sessionId }, signal);
			const iframe = document.createElement("iframe");
			iframe.className = "dsh-remote-web-context";
			iframe.setAttribute("title", "Remote DSH Web");
			iframe.setAttribute("sandbox", "allow-downloads allow-forms allow-modals allow-popups allow-scripts");
			iframe.setAttribute("referrerpolicy", "no-referrer");
			iframe.style.width = "100%";
			iframe.style.height = "100%";
			iframe.style.border = "0";
			iframe.srcdoc = await this.prepareBootHtml(boot, signal);
			this.options.container.replaceChildren(iframe);
			this.iframeValue = iframe;
		}
		async dispose() {
			if (this.disposed) return;
			this.disposed = true;
			window.removeEventListener("message", this.onMessageBound);
			for (const streamId of this.sockets.values()) this.options.transport.closeWebStream(streamId);
			this.sockets.clear();
			if (this.sessionIdValue !== void 0) try {
				await this.options.transport.webRequest("web.session.close", { sessionId: this.sessionIdValue });
			} catch {}
			for (const url of this.objectUrls) URL.revokeObjectURL(url);
			this.objectUrls.clear();
			this.iframeValue?.remove();
			this.iframeValue = void 0;
			this.sessionIdValue = void 0;
		}
		async prepareBootHtml(boot, signal) {
			const documentValue = new DOMParser().parseFromString(boot.html, "text/html");
			const base = documentValue.createElement("base");
			base.href = "https://dsh.remote.invalid/";
			documentValue.head.prepend(base);
			const scriptNodes = [...documentValue.querySelectorAll("script[src]")];
			const styleNodes = [...documentValue.querySelectorAll("link[rel=\"stylesheet\"][href]")];
			await Promise.all([...scriptNodes.map(async (node) => {
				const path = resolveRemotePath(node.getAttribute("src") ?? "");
				const body = await this.options.transport.webRequest("web.asset.get", {
					sessionId: this.sessionIdValue,
					path
				}, signal);
				node.src = this.createObjectUrl(body, "text/javascript");
			}), ...styleNodes.map(async (node) => {
				const path = resolveRemotePath(node.getAttribute("href") ?? "");
				const body = await this.options.transport.webRequest("web.asset.get", {
					sessionId: this.sessionIdValue,
					path
				}, signal);
				node.href = this.createObjectUrl(body, "text/css");
			})]);
			const bridge = documentValue.createElement("script");
			bridge.textContent = createBridgeScript();
			documentValue.head.prepend(bridge);
			return `<!doctype html>${documentValue.documentElement.outerHTML}`;
		}
		createObjectUrl(value, contentType) {
			if (!(value instanceof Uint8Array)) throw new Error("Remote DSH Web 资源必须是二进制");
			const copy = new Uint8Array(value.byteLength);
			copy.set(value);
			const url = URL.createObjectURL(new Blob([copy.buffer], { type: contentType }));
			this.objectUrls.add(url);
			return url;
		}
		async onMessage(event) {
			if (this.disposed || !this.iframeValue || event.source !== this.iframeValue.contentWindow) return;
			if (!isRecord(event.data) || typeof event.data.kind !== "string" || typeof event.data.id !== "string") return;
			const message = event.data;
			try {
				if (message.kind === "fetch") {
					const input = isRecord(message.input) ? message.input : {};
					const path = resolveRemotePath(typeof input.path === "string" ? input.path : "/");
					const response = path.startsWith("/assets/") || path.startsWith("/plugins/") ? {
						status: 200,
						headers: [["content-type", "application/octet-stream"]],
						body: await this.options.transport.webRequest("web.asset.get", {
							sessionId: this.sessionIdValue,
							path
						})
					} : await this.options.transport.webRequest("web.request", {
						sessionId: this.sessionIdValue,
						path,
						method: typeof input.method === "string" ? input.method : "GET",
						...Array.isArray(input.headers) ? { headers: input.headers } : {},
						...typeof input.body === "string" ? { body: input.body } : {}
					});
					this.postResponse(message.id, {
						ok: true,
						status: response.status,
						headers: response.headers,
						body: response.body instanceof Uint8Array ? response.body.buffer : response.body
					});
					return;
				}
				if (message.kind === "ws.open") {
					const input = isRecord(message.input) ? message.input : {};
					const opened = this.options.transport.openWebStreamWithId("web.ws.open", {
						sessionId: this.sessionIdValue,
						path: resolveRemotePath(typeof input.path === "string" ? input.path : "/")
					});
					this.sockets.set(message.id, opened.streamId);
					this.consumeSocket(message.id, opened.streamId, opened.stream);
					this.postResponse(message.id, { ok: true });
					return;
				}
				if (message.kind === "ws.send") {
					const streamId = this.sockets.get(message.id);
					if (!streamId) throw new Error("Remote DSH WebSocket 不存在");
					const body = typeof message.body === "string" ? new TextEncoder().encode(message.body) : toBytes(message.body);
					this.options.transport.sendWebStream(streamId, "web.ws.data", body, { ...typeof message.body === "string" ? { encoding: "text" } : { binary: true } });
					return;
				}
				if (message.kind === "ws.close") {
					const streamId = this.sockets.get(message.id);
					if (streamId) this.options.transport.closeWebStream(streamId);
					this.sockets.delete(message.id);
				}
			} catch (error) {
				this.postResponse(message.id, {
					ok: false,
					error: error instanceof Error ? error.message : "Remote DSH Web 请求失败"
				});
			}
		}
		async consumeSocket(id, streamId, stream) {
			try {
				let opened = false;
				for await (const value of stream) {
					if (!opened) {
						opened = true;
						if (isRecord(value) && value.opened === true) continue;
					}
					if (value instanceof Uint8Array) this.postEvent(id, "message", value.buffer);
					else this.postEvent(id, "message", typeof value === "string" ? value : JSON.stringify(value));
				}
				this.postEvent(id, "close", void 0);
			} catch (error) {
				this.postEvent(id, "error", error instanceof Error ? error.message : "Remote DSH WebSocket 流失败");
			} finally {
				if (this.sockets.get(id) === streamId) this.sockets.delete(id);
			}
		}
		postResponse(id, value) {
			this.iframeValue?.contentWindow?.postMessage({
				kind: "dsh-web-response",
				id,
				...value
			}, "*");
		}
		postEvent(id, type, body) {
			this.iframeValue?.contentWindow?.postMessage({
				kind: "dsh-web-event",
				id,
				type,
				body
			}, "*");
		}
		ensureOpen() {
			if (this.disposed) throw new Error("Remote DSH Web Context 已关闭");
		}
	};
	function createBridgeScript() {
		return `(() => {
    const pending = new Map();
    let nextId = 0;
    const call = (kind, input, body) => new Promise((resolve, reject) => {
      const id = String(++nextId);
      pending.set(id, { resolve, reject });
      parent.postMessage({ kind, id, input, body }, '*');
    });
    addEventListener('message', (event) => {
      const value = event.data;
      if (!value || value.kind === undefined) return;
      if (value.kind === 'dsh-web-response') {
        const item = pending.get(value.id);
        if (!item) return;
        pending.delete(value.id);
        if (value.ok === false) item.reject(new Error(value.error || 'Remote DSH Web 请求失败'));
        else item.resolve(value);
      }
      if (value.kind === 'dsh-web-event') {
        const item = pending.get(value.id);
        if (item && value.type === 'error') item.reject(new Error(value.body || 'Remote DSH WebSocket 失败'));
        const target = window.__dshRemoteSockets && window.__dshRemoteSockets.get(value.id);
        if (target) {
          if (value.type === 'message') target.onmessage && target.onmessage({ data: value.body });
          if (value.type === 'close') { target.readyState = 3; target.onclose && target.onclose(new CloseEvent('close')); }
          if (value.type === 'error') target.onerror && target.onerror(new Event('error'));
        }
      }
    });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      const parsed = new URL(url, location.href);
      if (parsed.origin === location.origin || parsed.origin === 'null' || parsed.origin === 'https://dsh.remote.invalid') {
        const response = await call('fetch', { path: parsed.pathname + parsed.search, method: init && init.method, headers: init && [...new Headers(init.headers).entries()] }, typeof init?.body === 'string' ? init.body : undefined);
        return new Response(response.body, { status: response.status, headers: response.headers });
      }
      return originalFetch(input, init);
    };
    window.__dshRemoteSockets = new Map();
    window.WebSocket = class RemoteWebSocket {
      constructor(url) { this.url = String(url); this.readyState = 0; window.__dshRemoteSockets.set(this._id = String(++nextId), this); call('ws.open', { path: new URL(this.url, location.href).pathname }).then(() => { this.readyState = 1; this.onopen && this.onopen(new Event('open')); }).catch((error) => { this.readyState = 3; this.onerror && this.onerror(new Error(error)); }); }
      send(value) { if (this.readyState !== 1) throw new Error('WebSocket is not open'); parent.postMessage({ kind: 'ws.send', id: this._id, body: typeof value === 'string' ? value : value }, '*'); }
      close(code, reason) { this.readyState = 2; parent.postMessage({ kind: 'ws.close', id: this._id, input: { code, reason } }, '*'); this.readyState = 3; this.onclose && this.onclose(new CloseEvent('close', { code: code || 1000, reason: reason || '' })); }
      addEventListener(type, listener) { this['on' + type] = listener; }
      removeEventListener(type, listener) { if (this['on' + type] === listener) this['on' + type] = null; }
    };
  })();`;
	}
	function resolveRemotePath(value) {
		const parsed = new URL(value, "https://dsh.remote.invalid");
		if (parsed.origin !== "https://dsh.remote.invalid" || parsed.pathname.includes("..")) throw new Error("远程 DSH Web 路径无效");
		return parsed.pathname + parsed.search;
	}
	function isRecord(value) {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	}
	function toBytes(value) {
		if (value instanceof Uint8Array) return value;
		if (value instanceof ArrayBuffer) return new Uint8Array(value);
		if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
		throw new TypeError("远程 WebSocket 消息必须是二进制或字符串");
	}
	//#endregion
	//#region src/client/dsh-h5-bootstrap.ts
	/** 独立 H5 页面使用的入口；Control API 会话通过 HttpOnly Cookie 提供。 */
	async function startDshH5BrowserBootstrap(options) {
		const signal = options.signal;
		const device = chooseDshDevice(await options.controlApi.listDevices(signal), options.dshDeviceId);
		const ticket = await options.controlApi.createClientTicket(device.dshDeviceId, signal);
		const connection = await connectWebRtcClient({
			signalingTicket: ticket,
			signalingSocketFactory: (url) => new WebSocket(url),
			peerConnectionFactory: ({ iceServers, iceTransportPolicy }) => createPeerConnection({
				iceServers,
				iceTransportPolicy
			})
		});
		const generation = options.generation ?? 1;
		const hostScope = {
			hostId: ticket.dshDeviceId,
			kind: "remote"
		};
		const session = new DshSession({
			carrier: connection.carrier,
			role: "client",
			generation: String(generation),
			hostScope
		});
		const transport = new DshCodingNsTransport({
			carrier: connection.carrier,
			generation: {
				id: generation,
				host: { home: "/" }
			},
			hostScope,
			session,
			requireSessionReady: true
		});
		let webContext;
		try {
			session.start();
			await session.waitReady(signal);
			if (options.webContext) {
				webContext = new RemoteDshWebContext({
					...options.webContext,
					transport
				});
				await webContext.open(signal);
			}
			return {
				dshDeviceId: device.dshDeviceId,
				transport,
				session,
				...webContext ? { webContext } : {},
				dispose: async () => {
					await webContext?.dispose();
					session.close();
					await transport.close();
					await connection.close();
				}
			};
		} catch (error) {
			await webContext?.dispose();
			session.close();
			await transport.close();
			await connection.close();
			throw error;
		}
	}
	/** 使用同源或跨域 HttpOnly Cookie 调用控制站，不读取 Cookie 内容。 */
	function createHttpDshH5ControlApi(baseUrl = "") {
		const normalizedBaseUrl = baseUrl.replace(/\/+$/u, "");
		return {
			async listDevices(signal) {
				return requestJson(`${normalizedBaseUrl}/api/v1/dsh/devices`, signal === void 0 ? {} : { signal });
			},
			async createClientTicket(dshDeviceId, signal) {
				return requestJson(`${normalizedBaseUrl}/api/v1/dsh/relay/ticket`, {
					method: "POST",
					...signal === void 0 ? {} : { signal },
					body: {
						dshDeviceId,
						role: "client"
					}
				});
			}
		};
	}
	function chooseDshDevice(response, requested) {
		const device = requested === void 0 ? response.devices.find((item) => item.online && item.status === "active") : response.devices.find((item) => item.dshDeviceId === requested && item.online && item.status === "active");
		if (!device) throw new Error(requested ? `DSH 设备不可用: ${requested}` : "没有可用的 DSH Host");
		return device;
	}
	function createPeerConnection(options) {
		const Constructor = globalThis.RTCPeerConnection;
		if (!Constructor) throw new Error("当前浏览器不支持 RTCPeerConnection");
		return new Constructor({
			iceServers: [...options.iceServers],
			iceTransportPolicy: options.iceTransportPolicy
		});
	}
	async function requestJson(url, options = {}) {
		const response = await fetch(url, {
			method: options.method ?? "GET",
			credentials: "include",
			...options.signal === void 0 ? {} : { signal: options.signal },
			headers: {
				accept: "application/json",
				...options.body === void 0 ? {} : { "content-type": "application/json" }
			},
			...options.body === void 0 ? {} : { body: JSON.stringify(options.body) }
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.detail ?? data.errorCode ?? `Control API 请求失败 (${response.status})`);
		return data;
	}
	//#endregion
	//#region src/client/h5-bootstrap-entry.ts
	Object.defineProperty(globalThis, "DshCodingNsH5", {
		configurable: true,
		enumerable: false,
		value: {
			createHttpDshH5ControlApi,
			startDshH5BrowserBootstrap
		},
		writable: false
	});
	//#endregion
})();
