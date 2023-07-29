//	www.igmsy.xyz

import { connect } from 'cloudflare:sockets';

// UUID设置
let userID = 'b1e1dbcd-a89b-45ab-b093-92bec853286f';

const proxyIPs = ['cdn-all.xn--b6gac.eu.org', 'cdn.xn--b6gac.eu.org', 'cdn-b100.xn--b6gac.eu.org', 'edgetunnel.anycast.eu.org', 'cdn.anycast.eu.org'];

let proxyIP = proxyIPs[Math.floor(Math.random() * proxyIPs.length)];

let dohURL = 'https://sky.rethinkdns.com/1:-Pf_____9_8A_AMAIgE8kMABVDDmKOHTAKg=';

// v2board API环境变量
let nodeId = ''; // 1

let apiToken = ''; //abcdefghijklmnopqrstuvwxyz123456

let apiHost = ''; // api.v2board.com

if (!isValidUUID(userID)) {
	throw new Error('UUID配置无效！');
}

export default {
	async fetch(request, env, ctx) {
		try {
			userID = env.UUID || userID;
			proxyIP = env.PROXYIP || proxyIP;
			dohURL = env.DNS_RESOLVER_URL || dohURL;
			nodeId = env.NODE_ID || nodeId;
			apiToken = env.API_TOKEN || apiToken;
			apiHost = env.API_HOST || apiHost;
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				const url = new URL(request.url);
				switch (url.pathname) {
					case '/cf':
						return new Response(JSON.stringify(request.cf, null, 4), {
							status: 200,
							headers: {
								"Content-Type": "application/json;charset=utf-8",
							},
						});
					case '/connect':
						const [hostname, port] = ['cloudflare.com', '80'];
						console.log(`Connecting to ${hostname}:${port}...`);

						try {
							const socket = await connect({
								hostname: hostname,
								port: parseInt(port, 10),
							});

							const writer = socket.writable.getWriter();

							try {
								await writer.write(new TextEncoder()
									.encode('GET / HTTP/1.1\r\nHost: ' + hostname + '\r\n\r\n'));
							} catch (writeError) {
								writer.releaseLock();
								await socket.close();
								return new Response(writeError.message, {
									status: 500
								});
							}

							writer.releaseLock();

							const reader = socket.readable.getReader();
							let value;

							try {
								const result = await reader.read();
								value = result.value;
							} catch (readError) {
								await reader.releaseLock();
								await socket.close();
								return new Response(readError.message, {
									status: 500
								});
							}

							await reader.releaseLock();
							await socket.close();

							return new Response(new TextDecoder()
								.decode(value), {
									status: 200
								});
						} catch (connectError) {
							return new Response(connectError.message, {
								status: 500
							});
						}
					case `/${userID}`:
						{
							const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
							return new Response(`${vlessConfig}`, {
								status: 200,
								headers: {
									"Content-Type": "text/plain;charset=utf-8",
								}
							});
						}
					default:
						url.hostname = 'tv.cctv.com';	// 伪装域名
						url.protocol = 'https:';
						request = new Request(url, request);
						return await fetch(request);
				}
			} else {
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			let e = err;
			return new Response(e.toString());
		}
	},
};

async function vlessOverWSHandler(request) {
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (info, event) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);
	let remoteSocketWapper = {
		value: null,
	};
	let udpStreamWrite = null;
	let isDns = false;
	readableWebSocketStream.pipeTo(new WritableStream({
			async write(chunk, controller) {
				if (isDns && udpStreamWrite) {
					return udpStreamWrite(chunk);
				}
				if (remoteSocketWapper.value) {
					const writer = remoteSocketWapper.value.writable.getWriter()
					await writer.write(chunk);
					writer.releaseLock();
					return;
				}
				const {
					hasError,
					message,
					portRemote = 443,
					addressRemote = '',
					rawDataIndex,
					vlessVersion = new Uint8Array([0, 0]),
					isUDP,
				} = await processVlessHeader(chunk, userID);
				address = addressRemote;
				portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '
				} `;
				if (hasError) {
					throw new Error(message);
					return;
				}
				if (isUDP) {
					if (portRemote === 53) {
						isDns = true;
					} else {
						throw new Error('UDP proxy only enable for DNS which is port 53');
						return;
					}
				}
				const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
				const rawClientData = chunk.slice(rawDataIndex);
				if (isDns) {
					const {
						write
					} = await handleUDPOutBound(webSocket, vlessResponseHeader, log);
					udpStreamWrite = write;
					udpStreamWrite(rawClientData);
					return;
				}
				handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
			},
			close() {
				log(`readableWebSocketStream is close`);
			},
			abort(reason) {
				log(`readableWebSocketStream is abort`, JSON.stringify(reason));
			},
		}))
		.catch((err) => {
			log('readableWebSocketStream pipeTo error', err);
		});
	return new Response(null, {
		status: 101,
		webSocket: client,
	});
}

let apiResponseCache = null;
let cacheTimeout = null;

async function fetchApiResponse() {
	const requestOptions = {
		method: 'GET',
		redirect: 'follow'
	};
	try {
		const response = await fetch(`https://${apiHost}/api/v1/server/UniProxy/user?node_id=${nodeId}&node_type=v2ray&token=${apiToken}`, requestOptions);

		if (!response.ok) {
			console.error('Error: Network response was not ok');
			return null;
		}
		const apiResponse = await response.json();
		apiResponseCache = apiResponse;

		if (cacheTimeout) {
			clearTimeout(cacheTimeout);
		}
		cacheTimeout = setTimeout(() => fetchApiResponse(), 300000);

		return apiResponse;
	} catch (error) {
		console.error('Error:', error);
		return null;
	}
}

async function getApiResponse() {
	if (!apiResponseCache) {
		return await fetchApiResponse();
	}
	return apiResponseCache;
}

async function checkUuidInApiResponse(targetUuid) {
	if (!nodeId || !apiToken || !apiHost) {
		return false;
	}
	try {
		const apiResponse = await getApiResponse();
		if (!apiResponse) {
			return false;
		}
		const isUuidInResponse = apiResponse.users.some(user => user.uuid === targetUuid);
		return isUuidInResponse;
	} catch (error) {
		console.error('Error:', error);
		return false;
	}
}

async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log, ) {
	async function connectAndWrite(address, port) {
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData);
		writer.releaseLock();
		return tcpSocket;
	}
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
		tcpSocket.closed.catch(error => {
				console.log('retry tcpSocket closed error', error);
			})
			.finally(() => {
				safeCloseWebSocket(webSocket);
			})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}
	const tcpSocket = await connectAndWrite(addressRemote, portRemote);
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
			});
			webSocketServer.addEventListener('close', () => {
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			});
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			});
			const {
				earlyData,
				error
			} = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},
		pull(controller) {},
		cancel(reason) {
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});
	return stream;
}

async function processVlessHeader(
	vlessBuffer,
	userID
) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	const slicedBuffer = new Uint8Array(vlessBuffer.slice(1, 17));
	const slicedBufferString = stringify(slicedBuffer);
	const uuids = userID.includes(',') ? userID.split(",") : [userID];
	const checkUuidInApi = await checkUuidInApiResponse(slicedBufferString);
	isValidUser = uuids.some(userUuid => checkUuidInApi || slicedBufferString === userUuid.trim());
	console.log(`checkUuidInApi: ${await checkUuidInApiResponse(slicedBufferString)}, userID: ${slicedBufferString}`);
	if (!isValidUser) {
		return {
			hasError: true,
			message: 'invalid user',
		};
	}
	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	const command = new Uint8Array(
		vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];
	if (command === 1) {} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	const portRemote = new DataView(portBuffer)
		.getUint16(0);

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(
		vlessBuffer.slice(addressIndex, addressIndex + 1)
	);
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(
					vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
				)
				.join('.');
			break;
		case 2:
			addressLength = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder()
				.decode(
					vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
				);
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2)
					.toString(16));
			}
			addressValue = ipv6.join(':');
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}
	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}

async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	let remoteChunkCount = 0;
	let chunks = [];
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false;
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {},
				async write(chunk, controller) {
					hasIncomingData = true;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk])
							.arrayBuffer());
						vlessHeader = null;
					} else {
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});
	if (hasIncomingData === false && retry) {
		log(`retry`)
		retry();
	}
}

function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return {
			error: null
		};
	}
	try {
		base64Str = base64Str.replace(/-/g, '+')
			.replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return {
			earlyData: arryBuffer.buffer,
			error: null
		};
	} catch (error) {
		return {
			error
		};
	}
}

function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256)
		.toString(16)
		.slice(1));
}

function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]])
		.toLowerCase();
}

function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}

async function handleUDPOutBound(webSocket, vlessResponseHeader, log) {

	let isVlessHeaderSent = false;
	const transformStream = new TransformStream({
		start(controller) {

		},
		transform(chunk, controller) {
			for (let index = 0; index < chunk.byteLength;) {
				const lengthBuffer = chunk.slice(index, index + 2);
				const udpPakcetLength = new DataView(lengthBuffer)
					.getUint16(0);
				const udpData = new Uint8Array(
					chunk.slice(index + 2, index + 2 + udpPakcetLength)
				);
				index = index + 2 + udpPakcetLength;
				controller.enqueue(udpData);
			}
		},
		flush(controller) {}
	});

	transformStream.readable.pipeTo(new WritableStream({
			async write(chunk) {
				const resp = await fetch(dohURL, {
					method: 'POST',
					headers: {
						'content-type': 'application/dns-message',
					},
					body: chunk,
				})
				const dnsQueryResult = await resp.arrayBuffer();
				const udpSize = dnsQueryResult.byteLength;
				const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
				if (webSocket.readyState === WS_READY_STATE_OPEN) {
					log(`doh success and dns message length is ${udpSize}`);
					if (isVlessHeaderSent) {
						webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult])
							.arrayBuffer());
					} else {
						webSocket.send(await new Blob([vlessResponseHeader, udpSizeBuffer, dnsQueryResult])
							.arrayBuffer());
						isVlessHeaderSent = true;
					}
				}
			}
		}))
		.catch((error) => {
			log('dns udp has error' + error)
		});

	const writer = transformStream.writable.getWriter();

	return {
		write(chunk) {
			writer.write(chunk);
		}
	};
}

function getVLESSConfig(userID, hostName) {
	const vlessws = `vless://${userID}@time.cloudflare.com:8880?encryption=none&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`
	const vlesswstls = `vless://${userID}@time.cloudflare.com:8443?encryption=none&security=tls&type=ws&host=自定义域名&path=%2F%3Fed%3D2048#${hostName}`
	return `

==========================配置详解==============================


################################################################
一、CF_Workers_Vless_ws节点，分享链接如下：

${vlessws}

---------------------------------------------------------------
注意：当前节点无需域名，TLS选项关闭
---------------------------------------------------------------
客户端必要文明参数如下：
客户端地址（address）：自选域名 或者 自选IP
端口(port)：7个http端口可任意选择(80、8080、8880、2052、2082、2086、2095)
用户ID（uuid）：${userID}
传输协议（network）：ws/websocket
伪装域名（host）：${hostName}
路径（path）：/?ed=2048
################################################################


################################################################
二、CF_Workers_Vless_ws_tls节点，分享链接如下：

${vlesswstls}

---------------------------------------------------------------
注意：客户端ws选项后的伪装域名host必须改为你自定义的域名
---------------------------------------------------------------
客户端必要文明参数如下：
客户端地址（address）：自选域名 或者 自选IP
端口(port)：6个https端口可任意选择(443、8443、2053、2083、2087、2096)
用户ID（uuid）：${userID}
传输协议（network）：ws/websocket
伪装域名（host）：绑定的自定义域名
路径（path）：/?ed=2048
传输安全（TLS）：开启
跳过证书验证（allowlnsecure）：false
################################################################

################################################################
clash-meta
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
  path: "/?ed=2048"
  headers:
  host: ${hostName}
---------------------------------------------------------------
################################################################
`;
}