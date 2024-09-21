import assert from "node:assert";
import { describe, it } from "node:test";
import { NetworkConfig, default as createNetworkApi, FetchResult, FetchParams } from "../src/index.js";

const resolveFunction: NetworkConfig["resolveFunction"] & {} = (hostname, callback) => {
	const m = hostname.match(/\d+\.\d+\.\d+\.\d+/g);
	if (m) callback(null, [...m]);
	else callback(new Error("unresolved"), []);
}

const WRAP_STATUS = [() => "fulfilled", () => "rejected"]

const fetchFunction: typeof fetch = async (url, params) => {
	return new Promise(async (resolve, reject) => {
		params?.signal?.addEventListener("abort", reject);
		try {
			const urlString = String(url);
			const delay = Number(urlString.match(/delay=(\d+)/)?.[1] ?? 0);
			const status = Number(urlString.match(/status=(\d+)/)?.[1] ?? 200);
			const needError = Boolean(urlString.match(/error=true/));
			if (delay) await new Promise(r => setTimeout(r, delay));
			if (needError) throw new TypeError("fetch failed");
			
			const headersObj = Object.fromEntries((params?.headers as Headers).entries());
			const response: Awaited<ReturnType<typeof fetch>> = {
				url: urlString,
				headers: new Headers({...headersObj, test: "headerTest"}),
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
				formData: () => {
					const form = new FormData();
					form.append("text", "1");
					form.append("text", "2");
					form.append("file", new File([Uint8Array.from([1,2,3])], "fileName"))
					return Promise.resolve(form);
				},
				clone: null as any,
			};
			resolve(response);
		} catch (e) {
			reject(e)
		}
	});
	
}

function createApi(conf?: NetworkConfig): {fetch: (url: string, params?: FetchParams) => Promise<FetchResult>} & Disposable {
	return new (createNetworkApi({...conf, resolveFunction, fetchFunction}))() as any
}

describe("ApiNetwork", () => {
	it("simple", {timeout: 500}, async () => {
		using api = createApi();
		const fetchResult = await api.fetch("http://_99.99.99.99_:225");
		assert.equal(fetchResult.status, 200, "default status 200");
	});

	it("fetch ip false", {timeout: 500}, async () => {
		using api = createApi();
		await assert.rejects(() => api.fetch("https://20.30.40.50:8088"), "not ok");
	});

	it("fetch ip true", {timeout: 500}, async () => {
		using api = createApi({
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

	it("awaiting fetch pool", {timeout: 500}, async (t) => {
		const api = createApi({
			fetchPoolTimeout: 50,
			fetchPoolCount: 3,
			fetchAllowIp: true,
			fetchMaxAwaitingProcesses: 100,
		});
		const completeTasks = {} as Record<string, boolean>;
		api.fetch("https://1.1.0.1").then(() => completeTasks.f1 = true);
		api.fetch("https://1.1.0.2").then(() => completeTasks.f2 = true);
		api.fetch("https://1.1.0.3").then(() => completeTasks.f3 = true);
		api.fetch("https://1.1.0.4").then(() => completeTasks.f4 = true);
		api.fetch("https://1.1.0.5").then(() => completeTasks.f5 = true);
		api.fetch("https://1.1.0.6").then(() => completeTasks.f6 = true);
		api.fetch("https://1.1.0.7").then(() => completeTasks.f7 = true);
		await new Promise(r => setTimeout(r, 5));
		assert.deepEqual(completeTasks, {f1: true, f2: true, f3: true});
		await new Promise(r => setTimeout(r, 50));
		assert.deepEqual(completeTasks, {f1: true, f2: true, f3: true, f4: true, f5: true, f6: true});
		await new Promise(r => setTimeout(r, 50));
		assert.deepEqual(completeTasks, {f1: true, f2: true, f3: true, f4: true, f5: true, f6: true, f7: true});
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

	it("awaiting fetch max active", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true,
			fetchMaxAwaitingProcesses: 100,

		});
		const completeTasks = {} as Record<string, boolean>;
		api.fetch("https://1.1.1.1?delay=50").then(() => completeTasks.f1 = true);
		api.fetch("https://1.1.1.2?delay=50").then(() => completeTasks.f2 = true);
		api.fetch("https://1.1.1.3?delay=50").then(() => completeTasks.f3 = true);
		api.fetch("https://1.1.1.4?delay=50").then(() => completeTasks.f4 = true);
		api.fetch("https://1.1.1.5?delay=50").then(() => completeTasks.f5 = true);
		api.fetch("https://1.1.1.6?delay=50").then(() => completeTasks.f6 = true);
		api.fetch("https://1.1.1.7?delay=50").then(() => completeTasks.f7 = true);
		await new Promise(r => setTimeout(r, 70));
		assert.deepEqual(completeTasks, {f1: true, f2: true, f3: true});
		await new Promise(r => setTimeout(r, 50));
		assert.deepEqual(completeTasks, {f1: true, f2: true, f3: true, f4: true, f5: true, f6: true});
		await new Promise(r => setTimeout(r, 50));
		assert.deepEqual(completeTasks, {f1: true, f2: true, f3: true, f4: true, f5: true, f6: true, f7: true});
	});

	it("fetch text", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const {body} = await api.fetch("https://1.1.1.1", {type: "text"});
		assert.equal(body, "text", "fetched text")
	});

	it("fetch json", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const {body} = await api.fetch("https://1.1.1.1", {type: "json"});
		assert.deepEqual(body, {test: "json"}, "fetched json")
	});

	it("fetch default type json", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const response = await api.fetch("https://1.1.1.1", {headers: {"content-type": "application/json"}});
		assert.deepEqual(response.body, {test: "json"}, "fetched json")
	});

	it("fetch default type text", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const response = await api.fetch("https://1.1.1.1", {headers: {"content-type": "text/xml; encoding=utf-8"}});
		assert.deepEqual(response.body, "text", "fetched text")
	});

	it("fetch default type text for svg", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const response = await api.fetch("https://1.1.1.1", {headers: {"content-type": "image/svg+xml"}});
		assert.deepEqual(response.body, "text", "fetched text")
	});

	it("fetch default type arrayBuffer", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const response = await api.fetch("https://1.1.1.1", {headers: {"content-type": "audio/mp3"}});
		assert.deepEqual(response.body, new ArrayBuffer(0), "fetched mp3 as arrayBuffer")
	});

	it("fetch default type formData", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const response = await api.fetch("https://1.1.1.1", {headers: {"content-type": "multipart/form-data"}});
		assert.ok(Array.isArray(response.body), "fetched formData");
	});


	it("fetch arrayBuffer", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const {body} = await api.fetch("https://1.1.1.1", {type: "arrayBuffer"});
		assert.ok(body instanceof ArrayBuffer, "fetched ArrayBuffer")
	});

	it("fetch formData", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		const response = await api.fetch("https://1.1.1.1", {type: "formData"});
		assert.ok(Array.isArray(response.body), "fetched formData");
	});

	it("fetch headers with pre-set", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true,
			fetchHeaders: {"content-type": "text/xml; encoding=utf-8", a: "b"}
		});
		const {headers, body} = await api.fetch("https://1.1.1.1", {headers: {"foo": "bar"}});
		assert.deepEqual(headers, {foo: "bar", test: "headerTest", "content-type": "text/xml; encoding=utf-8", a: "b"}, "fetched headers");
		assert.deepEqual(body, "text", "fetched text");
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

	it("fetch timeout", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		let result1: any;
		await api.fetch("https://1.1.1.1?delay=10", {timeout: 15}).then(() => result1 = "ok", () => result1 = "fail");
		assert.equal(result1, "ok", "fetched with timeout ok");
		let result2: any;
		await api.fetch("https://1.1.1.1?delay=20", {timeout: 15}).then(() => result2 = "ok", () => result2 = "fail");
		assert.equal(result2, "fail", "failed fetch with timeout ok");
	});

	it("fetch with error", {timeout: 500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 3,
			fetchAllowIp: true
		});
		let result: any = undefined;
		api.fetch("https://1.1.1.1?delay=10&error=true").then(() => result = "ok", () => result = "fail");
		assert.equal(result, undefined, "error-fetched with timeout");
		await new Promise(r => setTimeout(r, 15));
		assert.equal(result, "fail", "error-fetched with timeout done");
	});
	
	it("fetch pool overflow", {timeout: 1500}, async (t) => {
		const api =createApi({
			fetchMaxActiveCount: 2,
			fetchMaxAwaitingProcesses: 3,
			fetchAllowIp: true
		});
		const f1 = api.fetch("https://1.1.3.1?delay=150").then(...WRAP_STATUS);
		await new Promise(r => setTimeout(r, 2));
		const f2 = api.fetch("https://1.1.3.2?delay=150").then(...WRAP_STATUS);
		await new Promise(r => setTimeout(r, 2));
		const f3 = api.fetch("https://1.1.3.3?delay=150").then(...WRAP_STATUS);
		await new Promise(r => setTimeout(r, 2));
		const f4 = api.fetch("https://1.1.3.4?delay=150").then(...WRAP_STATUS);
		await new Promise(r => setTimeout(r, 2));
		const f5 = api.fetch("https://1.1.3.5?delay=150").then(...WRAP_STATUS);
		await new Promise(r => setTimeout(r, 2));
		const f6 = api.fetch("https://1.1.3.6?delay=150").then(...WRAP_STATUS);
		await new Promise(r => setTimeout(r, 2));
		const f7 = api.fetch("https://1.1.3.7?delay=150").then(...WRAP_STATUS);
		await new Promise(r => setTimeout(r, 2));
		const f8 = api.fetch("https://1.1.3.8?delay=150").then(...WRAP_STATUS);
		await new Promise(r => setTimeout(r, 2));
		const [r1, r2, r3, r4,r5, r6, r7, r8] = (await Promise.all([f1,f2,f3,f4,f5,f6,f7, f8]));
		assert.equal(r1, "fulfilled", "fetch 1 ok")
		assert.equal(r2, "fulfilled", "fetch 2 ok")
		assert.equal(r3, "fulfilled", "fetch 3 ok")
		assert.equal(r4, "fulfilled", "fetch 4 ok")
		assert.equal(r5, "fulfilled", "fetch 5 fail")
		assert.equal(r6, "rejected", "fetch 6 fail")
		assert.equal(r7, "rejected", "fetch 7 fail")
		assert.equal(r8, "rejected", "fetch 8 fail")
	});
})