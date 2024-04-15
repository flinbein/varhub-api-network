import {resolve} from "node:dns"
import {isIP} from "node:net"
import {Netmask} from "netmask"
import T, {type ResolveTypeChecker} from "@flinbein/t-type-check"
import { ApiHelper } from "@flinbein/varhub/src/controllers/ApiHelperController.js";

const isFetchParams = T({
	type: T("json", "text", "arrayBuffer").optional,
	method: T.string.optional,
	headers: T.mapOf(T.string, T.string).optional,
	body: T.any.optional,
	redirect: T('error','follow','manual').optional,
	credentials: T('omit', 'include', 'same-origin').optional,
	mode: T('cors', 'navigate', 'no-cors', 'same-origin').optional,
	referrer: T.string.optional,
	referrerPolicy: T.string.optional,
});
export type FetchParams = ResolveTypeChecker<typeof isFetchParams>;

export interface NetworkConfig {
	fetchPoolTimeout?: number;
	fetchPoolCount?: number;
	fetchMaxActiveCount?: number;
	ipWhitelist?: string[];
	ipBlacklist?: string[];
	fetchFunction?: typeof fetch;
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
	
	const whitelistMasks = config.ipWhitelist?.map(mask => new Netmask(mask));
	const blacklistMasks = config.ipBlacklist?.map(mask => new Netmask(mask));
	
	const fetchFn = config.fetchFunction ?? fetch;
	const resolveFn = config.resolveFunction ?? resolve;
	
	class ApiNetwork implements Disposable {
		#disposed = false;
		readonly #abortControllers = new Set<AbortController>();
		
		fetch = async (urlParam: unknown, param: unknown = {}): Promise<FetchResult> => {
			if (this.#disposed) throw new Error("api disposed");
			this.#checkFetchTimeout();
			this.#checkFetchMaxActiveCount();
			
			const abortCtrl = new AbortController();
			this.#abortControllers.add(abortCtrl);
			try {
				if (typeof urlParam !== "string") throw new Error("url not a string");
				if (!isFetchParams(param)) throw new Error("wrong fetch params");
				
				const url = new URL(urlParam);
				const hostIsValid = await this.#isAddressAllowed(url.host);
				if (this.#disposed) throw new Error("api disposed");
				if (!hostIsValid) throw new Error("address blocked");
				
				let body: ArrayBuffer | string | null = null;
				if (param.body instanceof ArrayBuffer || typeof param.body === "string") body = param.body;
				const fetchResult = await fetchFn(urlParam, {
					body,
					headers: param.headers as Record<string, string>,
					signal: abortCtrl.signal,
					mode: param.mode,
					redirect: param.redirect,
					referrerPolicy: param.referrerPolicy as any,
					referrer: param.referrer,
					credentials: param.credentials,
					method: param.method,
				});
				if (this.#disposed) throw new Error("api disposed");
				
				let responseBody = undefined;
				if (param.type === "text") responseBody = fetchResult.text();
				else if (param.type === "arrayBuffer") responseBody = fetchResult.arrayBuffer();
				else if (param.type === "json" || !param.type) responseBody = fetchResult.json();
				if (this.#disposed) throw new Error("api disposed");
				
				return {
					url: fetchResult.url,
					ok: fetchResult.ok,
					type: fetchResult.type,
					statusText: fetchResult.statusText,
					redirected: fetchResult.redirected,
					status: fetchResult.status,
					headers: Object.fromEntries(fetchResult.headers.entries()),
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
		
		async #isAddressAllowed(address: string){
			if (isIP(address)) return this.#isIpAllowed(address);
			return await new Promise<boolean>((promiseResolve, promiseReject) => {
				resolveFn(address, (error, addresses) => {
					try {
						if (error !== null) promiseReject(error);
						promiseResolve(addresses.every(ip => this.#isIpAllowed(ip)));
					} catch (error) {
						promiseReject(error);
					}
				})
			})
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
		
		[Symbol.dispose] = () => {
			this.#disposed = true;
			for (const abortController of this.#abortControllers) {
				abortController.abort("aborted by api");
			}
		}
	}
	return ApiNetwork;
}
