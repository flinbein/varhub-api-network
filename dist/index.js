import { resolve } from "node:dns";
import { isIP } from "node:net";
import { Netmask } from "netmask";
export default function createApi(config = {}) {
    const whitelistDomains = config.domainWhitelist ? [...config.domainWhitelist] : undefined;
    const blacklistDomains = config.domainBlacklist ? [...config.domainBlacklist] : undefined;
    const fetchAllowIp = config.fetchAllowIp ?? false;
    const whitelistMasks = config.ipWhitelist?.map(mask => new Netmask(mask));
    const blacklistMasks = config.ipBlacklist?.map(mask => new Netmask(mask));
    const fetchFn = config.fetchFunction ?? fetch;
    const resolveFn = config.resolveFunction ?? resolve;
    class ApiNetwork {
        #disposed = false;
        #abortControllers = new Set();
        fetch = async (urlParam, param) => {
            param ||= {};
            if (this.#disposed)
                throw new Error("api disposed");
            this.#checkFetchTimeout();
            this.#checkFetchMaxActiveCount();
            const abortCtrl = new AbortController();
            this.#abortControllers.add(abortCtrl);
            try {
                const url = new URL(String(urlParam));
                const hostIsValid = await this.#isFetchHostnameAllowed(url.hostname);
                if (this.#disposed)
                    throw new Error("api disposed");
                if (!hostIsValid)
                    throw new Error("address blocked");
                let body = null;
                if (param.body instanceof ArrayBuffer || typeof param.body === "string")
                    body = param.body;
                const fetchResult = await fetchFn(url, {
                    body,
                    headers: param.headers !== undefined ? { ...(param.headers) } : undefined,
                    signal: abortCtrl.signal,
                    mode: param.mode !== undefined ? String(param.mode) : undefined,
                    redirect: param.redirect !== undefined ? String(param.redirect) : undefined,
                    referrerPolicy: param.referrerPolicy !== undefined ? String(param.referrerPolicy) : undefined,
                    referrer: param.referrer !== undefined ? String(param.referrer) : undefined,
                    credentials: param.credentials !== undefined ? String(param.credentials) : undefined,
                    method: param.method !== undefined ? String(param.method) : undefined,
                });
                if (this.#disposed)
                    throw new Error("api disposed");
                let responseBody = undefined;
                if (param.type === "text")
                    responseBody = await fetchResult.text();
                else if (param.type === "arrayBuffer")
                    responseBody = await fetchResult.arrayBuffer();
                else if (param.type === "json" || !param.type)
                    responseBody = await fetchResult.json();
                if (this.#disposed)
                    throw new Error("api disposed");
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
            }
            finally {
                this.#abortControllers.delete(abortCtrl);
            }
        };
        #fetchPoolTimeoutId;
        #fetchPoolCounter = 0;
        #checkFetchTimeout() {
            if (!config.fetchPoolTimeout)
                return;
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
        async #isFetchHostnameAllowed(hostname) {
            if (isIP(hostname)) {
                if (!fetchAllowIp)
                    return false;
                return this.#isIpAllowed(hostname);
            }
            if (!await this.#isDomainAllowed(hostname))
                return false;
            return await new Promise((promiseResolve, promiseReject) => {
                resolveFn(hostname, (error, addresses) => {
                    try {
                        if (error !== null)
                            promiseReject(error);
                        promiseResolve(addresses.every(ip => this.#isIpAllowed(ip)));
                    }
                    catch (error) {
                        promiseReject(error);
                    }
                });
            });
        }
        async #isDomainAllowed(domain) {
            if (blacklistDomains) {
                for (let domainPattern of blacklistDomains) {
                    if (domainPattern === domain)
                        return false;
                    if (domainPattern instanceof RegExp && domain.match(domainPattern))
                        return false;
                }
            }
            if (!whitelistDomains)
                return true;
            for (let domainPattern of whitelistDomains) {
                if (domainPattern === domain)
                    return true;
                if (domainPattern instanceof RegExp && domain.match(domainPattern))
                    return true;
            }
            return false;
        }
        #isIpAllowed(ip) {
            if (blacklistMasks) {
                for (let mask of blacklistMasks) {
                    if (mask.contains(ip))
                        return false;
                }
            }
            if (!whitelistMasks)
                return true;
            for (let mask of whitelistMasks) {
                if (mask.contains(ip))
                    return true;
            }
            return false;
        }
        #checkFetchMaxActiveCount() {
            if (typeof config.fetchMaxActiveCount !== "number")
                return;
            if (this.#abortControllers.size >= config.fetchMaxActiveCount) {
                throw new Error("fetch limit");
            }
        }
        [Symbol.dispose] = () => {
            this.#disposed = true;
            for (const abortController of this.#abortControllers) {
                abortController.abort("aborted by api");
            }
        };
    }
    return ApiNetwork;
}
