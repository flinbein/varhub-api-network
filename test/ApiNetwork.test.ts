import assert from "node:assert";
import { describe, it } from "node:test";
import { NetworkConfig, default as createNetworkApi, FetchResult, FetchParams } from "../src/index.js";

const resolveFunction: NetworkConfig["resolveFunction"] & {} = (hostname, callback) => {
	const m = hostname.match(/\d+\.\d+\.\d+\.\d+/g);
	if (m) callback(null, [...m]);
	else callback(new Error("unresolved"), []);
}

const fetchFunction: typeof fetch = async (url, params) => {
	return new Promise(async (resolve, reject) => {
		params?.signal?.addEventListener("abort", reject);
		try {
			const urlString = String(url);
			const delay = Number(urlString.match(/delay=(\d+)/)?.[1] ?? 0);
			const status = Number(urlString.match(/status=(\d+)/)?.[1] ?? 200);
			if (delay) await new Promise(r => setTimeout(r, delay));
			
			const response: Awaited<ReturnType<typeof fetch>> = {
				url: urlString,
				headers: new Headers({...(params?.headers ?? {}), test: "headerTest"}),
				json: () => Promise.resolve<unknown>({test: "json"}),
				text: () => Promise.resolve("text"),
				arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
				type: "default",
				ok: status >= 200 && status < 299,
				status: status,
				redirected: false,
				statusText: "OK",
				body: null as any,
				bodyUsed: false,
				blob: null as any,
				formData: null as any,
				clone: null as any,
			};
			resolve(response);
		} catch (e) {
			reject(e)
		}
	});
	
}

function createApi(conf?: NetworkConfig): {fetch: (url: string, params?: FetchParams) => Promise<FetchResult>} {
	return new (createNetworkApi({...conf, resolveFunction, fetchFunction}))() as any
}

describe("ApiNetwork", () => {
	it("simple", {timeout: 500}, async () => {
		const api = createApi();
		const fetchResult = await api.fetch("http://_99.99.99.99_:225");
		assert.equal(fetchResult.status, 200, "default status 200");
	});
	
	it("fetch ip false", {timeout: 500}, async () => {
		const api = createApi();
		await assert.rejects(() => api.fetch("https://20.30.40.50:8088"), "not ok");
	});
	
	it("fetch ip true", {timeout: 500}, async () => {
		const api = createApi({
			fetchAllowIp: true
		});
		await assert.doesNotReject(() => api.fetch("https://20.30.40.50:8088"), "ok");
	});

	it("ip blacklist", {timeout: 500}, async () => {
		const api =createApi({
			ipBlacklist: ["10.0.0.0/8", "20.0.0.0/8"],
			fetchAllowIp: true
		});
		await assert.doesNotReject(() => api.fetch("https://_5.5.5.5_:225"), "1 ok");
		await assert.rejects(() => api.fetch("https://_10.20.30.40_"), "2 not ok");
		await assert.rejects(() => api.fetch("https://_20.20.30.40_:80"), "3 not ok");
		await assert.rejects(() => api.fetch("https://_5.5.5.5_20.20.30.40_:80"), "4 not ok");
		await assert.rejects(() => api.fetch("https://20.30.40.50:8088"), "5 not ok");
	});


	it("ip whitelist", {timeout: 500}, async () => {
		const api =createApi({
			ipWhitelist: ["10.0.0.0/8", "20.0.0.0/8"],
			fetchAllowIp: true
		});
		await assert.rejects(() => api.fetch("https://_5.5.5.5_:225"), "1 not ok");
		await assert.rejects(() => api.fetch("https://_5.5.5.5_10.20.30.40_:225"), "2 not ok");
		await assert.rejects(() => api.fetch("https://_10.20.30.40_5.5.5.5_:225"), "3 not ok");
		await assert.rejects(() => api.fetch("https://5.5.5.5/ip"), "4 not ok");
		await assert.doesNotReject(() => api.fetch("https://_10.20.30.40_"), "5 ok");
		await assert.doesNotReject(() => api.fetch("https://10.20.30.40/ip"), "6 ok");
		await assert.doesNotReject(() => api.fetch("https://_20.20.30.40_:80"), "7 ok");
		await assert.doesNotReject(() => api.fetch("https://_20.20.30.40_10.20.30.40_:80"), "8 ok");
	});

	it("ip blacklist over ip whitelist", {timeout: 500}, async () => {
		const api =createApi({
			ipWhitelist: ["10.0.0.0/8", "20.0.0.0/8"],
			ipBlacklist: ["10.10.10.0/24"]
		});
		await assert.rejects(() => api.fetch("https://_5.5.5.5_:225"), "1 not ok");
		await assert.doesNotReject(() => api.fetch("https://_10.20.30.40_"), "2 ok");
		await assert.doesNotReject(() => api.fetch("https://_20.20.30.40_:80"), "3 ok");
		await assert.rejects(() => api.fetch("https://_10.10.10.10_"), "4 not ok");
	});

	it("fetch pool", {timeout: 500, todo: true}, async (t) => {
		const api =createApi({
			fetchPoolTimeout: 50,
			fetchPoolCount: 3,
			fetchAllowIp: true
		});
		const f1 = api.fetch("https://1.1.1.1");
		await new Promise(r => setTimeout(r, 5));

		const f2 = api.fetch("https://1.1.1.1");
		await new Promise(r => setTimeout(r, 5));

		const f3 = api.fetch("https://1.1.1.1");
		await new Promise(r => setTimeout(r, 5));

		await assert.rejects(() => api.fetch("https://1.1.1.1"), "rejects 4th");
		await assert.doesNotReject(Promise.all([f1,f2,f3]), "resolves 3");
		await assert.rejects(() => api.fetch("https://1.1.1.1"), "rejects 5th");

		await new Promise(r => setTimeout(r, 50));

		await assert.doesNotReject(Promise.all([f1,f2,f3]), "resolves 6");
	});


	it("fetch max active", {timeout: 500, todo: true}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const f1 = api.fetch("https://1.1.1.1?delay=10");
		const f2 = api.fetch("https://1.1.1.1?delay=10");
		const f3 = api.fetch("https://1.1.1.1?delay=10");
		await assert.rejects(() => api.fetch("https://1.1.1.1?delay=10"), "rejects 4th");
		await new Promise(r => setTimeout(r, 15));
		await assert.doesNotReject(() => api.fetch("https://1.1.1.1?delay=10"), "resolves 5th");
		await assert.doesNotReject(Promise.all([f1,f2,f3]), "resolves 3");
	});

	it("fetch text", {timeout: 500, todo: true}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const {body} = await api.fetch("https://1.1.1.1", {type: "text"});
		assert.equal(body, "text", "fetched text")
	});

	it("fetch json", {timeout: 500, todo: true}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const {body} = await api.fetch("https://1.1.1.1", {type: "json"});
		assert.deepEqual(body, {test: "json"}, "fetched json")
	});

	it("fetch json default", {timeout: 500, todo: true}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const {body} = await api.fetch("https://1.1.1.1");
		assert.deepEqual(body, {test: "json"}, "fetched json")
	});


	it("fetch arrayBuffer", {timeout: 500, todo: true}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const {body} = await api.fetch("https://1.1.1.1", {type: "arrayBuffer"});
		assert.ok(body instanceof ArrayBuffer, "fetched ArrayBuffer")
	});

	it("fetch headers", {timeout: 500, todo: true}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const {headers} = await api.fetch("https://1.1.1.1", {headers: {"foo": "bar"}});
		assert.deepEqual(headers, {foo: "bar", test: "headerTest"}, "fetched headers");
	});
	
	it("domain blacklist", {timeout: 500}, async () => {
		const api =createApi({
			domainBlacklist: ["_10.10.10.10_", /_2/]
		});
		await assert.doesNotReject(() => api.fetch("https://_5.5.5.5_:225"), "1 ok");
		await assert.rejects(() => api.fetch("https://_10.10.10.10_"), "2 not ok");
		await assert.rejects(() => api.fetch("https://_10.10.10.10_:8088"), "3 not ok");
		await assert.rejects(() => api.fetch("https://_20.20.20.20_"), "3 not ok");
	});
	
	it("domain whitelist", {timeout: 500}, async () => {
		const api =createApi({
			domainWhitelist: ["_10.10.10.10_", /_2/]
		});
		await assert.rejects(() => api.fetch("https://_5.5.5.5_:225"), "1 not ok");
		await assert.doesNotReject(() => api.fetch("https://_10.10.10.10_"), "2 ok");
		await assert.doesNotReject(() => api.fetch("https://_10.10.10.10_:8088"), "3 ok");
		await assert.doesNotReject(() => api.fetch("https://_20.20.20.20_"), "3 ok");
	});
	
	it("domain blacklist over ip whitelist", {timeout: 500}, async () => {
		const api =createApi({
			domainWhitelist: ["_10.10.10.10_", /_2/],
			domainBlacklist: ["_20.20.20.20_"]
		});
		await assert.rejects(() => api.fetch("https://_5.5.5.5_:225"), "1 not ok");
		await assert.doesNotReject(() => api.fetch("https://_10.10.10.10_"), "2 ok");
		await assert.doesNotReject(() => api.fetch("https://_20.20.30.40_:80"), "3 ok");
		await assert.rejects(() => api.fetch("https://_20.20.20.20_"), "4 not ok");
		await assert.rejects(() => api.fetch("https://_20.20.20.20_:80"), "5 not ok");
	});
	
	it("content length", {timeout: 500}, async () => {
		const api =createApi({
			fetchMaxContentLength: 100,
			fetchAllowIp: true,
		});
		await assert.doesNotReject(() => api.fetch("https://1.1.1.1", {headers: {"content-length": "50"}}), "1 ok");
		await assert.rejects(() => api.fetch("https://1.1.1.1", {headers: {"content-length": "500"}}), "2 not ok");
		await assert.rejects(() => api.fetch("https://1.1.1.1", {headers: {"content-length": "unknown"}}), "3 not ok");
		await assert.rejects(() => api.fetch("https://1.1.1.1", {headers: {"x-content-length": "10"}}), "4 not ok");
		await assert.doesNotReject(() => api.fetch("https://1.1.1.1", {headers: {"content-length": "0"}}), "5 ok");
		await assert.doesNotReject(() => api.fetch("https://1.1.1.1", {headers: {"content-length": "100"}}), "6 ok");
	});
})