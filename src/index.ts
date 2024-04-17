import {resolve} from "node:dns"
import {isIP} from "node:net"
import {Netmask} from "netmask"
import { ApiHelper } from "@flinbein/varhub/src/controllers/ApiHelperController.js";

type RequestInit = Parameters<typeof fetch>[1] & {};

export type FetchParams = {
	type?: "json" | "text" | "arrayBuffer"
	method?: RequestInit["method"],
	headers?: Record<string, string>,
	body?: string | ArrayBuffer
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
	/** mock function `fetch` */
	fetchFunction?: typeof fetch;
	/** mock function `resolve` */
	resolveFunction?: (hostname: string, callback: (error: any, ipList: string[]) => void) => void;
}

export interface FetchResult {
	url: string,
	ok: boolean,
	type: string,
	statusText: string,
	redirected: boolean,
	status: number,
	headers: Record<string, string>,
	body: any,
}
export default function createApi(config: NetworkConfig = {}): new () => ApiHelper {
	
	const fetchMaxContentLength = config.fetchMaxContentLength;
	const whitelistDomains = config.domainWhitelist ? [...config.domainWhitelist] : undefined;
	const blacklistDomains = config.domainBlacklist ? [...config.domainBlacklist] : undefined;
	const fetchAllowIp = config.fetchAllowIp ?? false;
	const whitelistMasks = config.ipWhitelist?.map(mask => new Netmask(mask));
	const blacklistMasks = config.ipBlacklist?.map(mask => new Netmask(mask));
	
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
				
				let body: ArrayBuffer | string | null = null;
				if (param.body instanceof ArrayBuffer || typeof param.body === "string") body = param.body;
				const response = await fetchFn(url, {
					body,
					headers: param.headers !== undefined ? {...(param.headers)} as Record<string, string> : undefined,
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
				
				let responseBody = undefined;
				if (param.type === "text") responseBody = await response.text();
				else if (param.type === "arrayBuffer") responseBody = await response.arrayBuffer();
				else if (param.type === "json" || !param.type) responseBody = await response.json();
				if (this.#disposed) throw new Error("api disposed");
				
				return {
					url: response.url,
					ok: response.ok,
					type: response.type,
					statusText: response.statusText,
					redirected: response.redirected,
					status: response.status,
					headers: Object.fromEntries(response.headers.entries()),
					body: responseBody,
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
