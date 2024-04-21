import {resolve} from "node:dns"
import {isIP} from "node:net"
import {Netmask} from "netmask"
import type { ApiHelper } from "@flinbein/varhub";

export interface NetworkApi {
	fetch<T extends keyof BodyType>(url: string, params?: FetchParams<T>): Promise<FetchResult<T>>
}

type RequestInit = Parameters<typeof fetch>[1] & {};

type BodyType = {
	json: unknown;
	text: string;
	arrayBuffer: ArrayBuffer;
	formData: Array<[string, string | FileJson]>
}

interface FileJson {
	type: string,
	size: number,
	name: string,
	lastModified: number,
	data: ArrayBuffer
}

export type FetchParams<T extends keyof BodyType = keyof BodyType> = {
	type?: T
	method?: RequestInit["method"],
	headers?: Record<string, string>,
	body?: string | ArrayBuffer | Array<[string, string] | [string, FileJson] | [string, ArrayBuffer, string]>
	redirect?: RequestInit["redirect"],
	credentials?: RequestInit["credentials"]
	mode?: RequestInit["mode"]
	referrer?: RequestInit["referrer"]
	referrerPolicy?: RequestInit["referrerPolicy"]
};

export interface NetworkConfig {
	/** max content length  */
	fetchMaxContentLength?: number;
	/** timeout to check fetchPoolCount */
	fetchPoolTimeout?: number;
	/** Maximum number of fetch processes starts per fetchPoolTimeout */
	fetchPoolCount?: number;
	/** Maximum number of active fetch processes */
	fetchMaxActiveCount?: number;
	/** allow fetch by ip. Example: `fetch("http://10.20.30.40:8088/service/data")`*/
	fetchAllowIp?: boolean;
	/** Defines whitelist of ip. Example: `["127.0.0.0/8", "172.16.0.0/12"]` */
	ipWhitelist?: string[];
	/** Defines blacklist of ip. Example: `["127.0.0.0/8", "172.16.0.0/12"]`. Blacklist has high priority */
	ipBlacklist?: string[];
	/** Defines whitelist of domains. Example: `["localhost", /.*\.google.ru$/]`.*/
	domainBlacklist?: (string|RegExp)[];
	/** Defines blacklist of domains. Example: `["localhost", /.*\.google.ru$/]`. Blacklist has high priority */
	domainWhitelist?: (string|RegExp)[];
	/** add custom headers for fetch */
	fetchHeaders?: Record<string, string>;
	/** mock function `fetch` */
	fetchFunction?: typeof fetch;
	/** mock function `resolve` */
	resolveFunction?: (hostname: string, callback: (error: any, ipList: string[]) => void) => void;
}

export interface FetchResult<T extends keyof BodyType = keyof BodyType> {
	url: string,
	ok: boolean,
	type: string,
	statusText: string,
	redirected: boolean,
	status: number,
	headers: Record<string, string>,
	body: BodyType[T],
}
export default function createApi(config: NetworkConfig = {}): new () => ApiHelper {
	
	const fetchMaxContentLength = config.fetchMaxContentLength;
	const whitelistDomains = config.domainWhitelist ? [...config.domainWhitelist] : undefined;
	const blacklistDomains = config.domainBlacklist ? [...config.domainBlacklist] : undefined;
	const fetchAllowIp = config.fetchAllowIp ?? false;
	const whitelistMasks = config.ipWhitelist?.map(mask => new Netmask(mask));
	const blacklistMasks = config.ipBlacklist?.map(mask => new Netmask(mask));
	const fetchHeaders = {...config.fetchHeaders};
	
	const fetchFn = config.fetchFunction ?? fetch;
	const resolveFn = config.resolveFunction ?? resolve;
	
	class ApiNetwork implements Disposable {
		#disposed = false;
		readonly #abortControllers = new Set<AbortController>();
		
		fetch = async (urlParam: string, param?: FetchParams): Promise<FetchResult> => {
			param ||= {}
			if (this.#disposed) throw new Error("api disposed");
			this.#checkFetchTimeout();
			this.#checkFetchMaxActiveCount();
			
			const abortCtrl = new AbortController();
			this.#abortControllers.add(abortCtrl);
			try {
				const url = new URL(String(urlParam));
				const hostIsValid = await this.#isFetchHostnameAllowed(url.hostname);
				if (this.#disposed) throw new Error("api disposed");
				if (!hostIsValid) throw new Error("address blocked");
				
				let body: ArrayBuffer | string | FormData | null = null;
				const paramBody = param.body;
				if (paramBody instanceof ArrayBuffer || typeof paramBody === "string") body = paramBody;
				else if (Array.isArray(paramBody)) {
					body = new FormData();
					for (const [name, value, fileName] of paramBody) {
						if (typeof value === "string") {
							body.append(name, value)
						} else if (value instanceof ArrayBuffer) {
							body.append(name, new File([new Uint8Array(value)], fileName ?? ""), fileName);
						} else {
							const file = new File([new Uint8Array(value.data)], value.name, {
								type: value.type,
								lastModified: value.lastModified,
							});
							body.append(name, file, fileName ?? file.name);
						}
					}
				}
				const headers = new Headers();
				if (param.headers) {
					for (let headerName in param.headers) {
						headers.set(headerName, String(param.headers[headerName]));
					}
				}
				for (let headerName in fetchHeaders) {
					headers.set(headerName, String(fetchHeaders[headerName]));
				}
				const response = await fetchFn(url, {
					body,
					headers,
					signal: abortCtrl.signal,
					mode: param.mode !== undefined ? String(param.mode) as any : undefined,
					redirect: param.redirect !== undefined ? String(param.redirect) as any : undefined,
					referrerPolicy: param.referrerPolicy !== undefined ? String(param.referrerPolicy) as any : undefined,
					referrer: param.referrer !== undefined ? String(param.referrer) : undefined,
					credentials: param.credentials !== undefined ? String(param.credentials) as any : undefined,
					method: param.method !== undefined ? String(param.method) : undefined,
				});
				if (this.#disposed) throw new Error("api disposed");
				
				this.#checkFetchContentLength(response);
				
				let resultData = undefined;
				let type = param.type;
				if (!type) {
					const contentType = response.headers.get("content-type");
					if (contentType?.startsWith("application/json")) type = "json";
					else if (contentType?.startsWith("multipart/form-data")) type = "formData";
					else if (contentType === "text" || contentType?.startsWith("text/")) type = "text";
					else if (contentType?.includes("+xml")) type = "text";
					else type = "arrayBuffer";
				}
				if (type === "formData") {
					resultData = [];
					const formData = await response.formData();
					await Promise.all([...formData.entries()].map(async ([name, value]) => {
						if (typeof value === "string") {
							resultData.push([name, value]);
						} else {
							resultData.push([name, await mapFileToJson(value)])
						}
					}))
				}
				if (type === "text") resultData = await response.text();
				else if (type === "arrayBuffer") resultData = await response.arrayBuffer();
				else if (type === "json") resultData = await response.json();
				else if (!type) resultData = await response.text();
				if (this.#disposed) throw new Error("api disposed");
				
				return {
					url: response.url,
					ok: response.ok,
					type: response.type,
					statusText: response.statusText,
					redirected: response.redirected,
					status: response.status,
					headers: Object.fromEntries(response.headers.entries()),
					body: resultData,
				};
			} finally {
				this.#abortControllers.delete(abortCtrl);
			}
		}
		
		#fetchPoolTimeoutId: undefined | ReturnType<typeof setTimeout>;
		#fetchPoolCounter = 0;
		#checkFetchTimeout(){
			if (!config.fetchPoolTimeout) return;
			if (!this.#fetchPoolTimeoutId) {
				this.#fetchPoolTimeoutId = setTimeout(() => {
					this.#fetchPoolTimeoutId = undefined;
					this.#fetchPoolCounter = 0;
				}, config.fetchPoolTimeout);
			}
			this.#fetchPoolCounter++;
			if (this.#fetchPoolCounter > (config.fetchPoolCount ?? 0)) {
				throw new Error("fetch limit");
			}
		}
		
		async #isFetchHostnameAllowed(hostname: string){
			if (isIP(hostname)) {
				if (!fetchAllowIp) return false;
				return this.#isIpAllowed(hostname);
			}
			if (!await this.#isDomainAllowed(hostname)) return false;
			return await new Promise<boolean>((promiseResolve, promiseReject) => {
				resolveFn(hostname, (error, addresses) => {
					try {
						if (error !== null) promiseReject(error);
						promiseResolve(addresses.every(ip => this.#isIpAllowed(ip)));
					} catch (error) {
						promiseReject(error);
					}
				})
			})
		}
		
		async #isDomainAllowed(domain: string){
			if (blacklistDomains) {
				for (let domainPattern of blacklistDomains) {
					if (domainPattern === domain) return false;
					if (domainPattern instanceof RegExp && domain.match(domainPattern)) return false;
				}
			}
			if (!whitelistDomains) return true;
			for (let domainPattern of whitelistDomains) {
				if (domainPattern === domain) return true;
				if (domainPattern instanceof RegExp && domain.match(domainPattern)) return true;
			}
			return false;
		}
		
		#isIpAllowed(ip: string){
			if (blacklistMasks) {
				for (let mask of blacklistMasks) {
					if (mask.contains(ip)) return false;
				}
			}
			if (!whitelistMasks) return true;
			for (let mask of whitelistMasks) {
				if (mask.contains(ip)) return true;
			}
			return false;
		}
		
		#checkFetchMaxActiveCount(){
			if (typeof config.fetchMaxActiveCount !== "number") return;
			if (this.#abortControllers.size >= config.fetchMaxActiveCount) {
				throw new Error("fetch limit");
			}
		}
		
		#checkFetchContentLength(response: Awaited<ReturnType<typeof fetch>>){
			if (fetchMaxContentLength == undefined) return;
			const contentLength = response.headers.get("content-length");
			if (!contentLength) throw new Error("fetch content length");
			const len = Number(contentLength);
			if (Number.isNaN(len)) throw new Error("fetch content length");
			if (len > fetchMaxContentLength) throw new Error("fetch content length");
		}
		
		[Symbol.dispose] = () => {
			this.#disposed = true;
			for (const abortController of this.#abortControllers) {
				abortController.abort("aborted by api");
			}
		}
	}
	return ApiNetwork;
}



async function mapFileToJson(file: File): Promise<FileJson> {
	file.lastModified
	return {
		type: file.type,
		size: file.size,
		name: file.name,
		lastModified: file.lastModified,
		data: await file.arrayBuffer()
	}
}