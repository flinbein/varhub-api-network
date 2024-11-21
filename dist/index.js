import { resolve } from "node:dns";
import { isIP } from "node:net";
import EventEmitter from "node:events";
import { Netmask } from "netmask";
export default function createApi(config = {}) {
    const fetchMaxContentLength = config.fetchMaxContentLength;
    const whitelistDomains = config.domainWhitelist ? [...config.domainWhitelist] : undefined;
    const blacklistDomains = config.domainBlacklist ? [...config.domainBlacklist] : undefined;
    const fetchAllowIp = config.fetchAllowIp ?? false;
    const whitelistMasks = config.ipWhitelist?.map(mask => new Netmask(mask));
    const blacklistMasks = config.ipBlacklist?.map(mask => new Netmask(mask));
    const fetchHeaders = typeof config.fetchHeaders === "function" ? config.fetchHeaders : { ...config.fetchHeaders };
    const fetchFn = config.fetchFunction ?? fetch;
    const resolveFn = config.resolveFunction ?? resolve;
    class ApiNetwork {
        #disposed = false;
        #abortControllers = new Set();
        #events = (() => {
            const emitter = new EventEmitter();
            emitter.setMaxListeners(config.fetchMaxAwaitingProcesses ?? 0);
            return emitter;
        })();
        fetch = async (urlParam, param = {}) => {
            if (this.#disposed)
                throw new Error("api disposed");
            while (this.#hasTimeoutBlock() || this.#hasMaxActiveBlock()) {
                await this.#waitForUpdate();
            }
            if (this.#disposed)
                throw new Error("api disposed");
            const abortCtrl = new AbortController();
            this.#abortControllers.add(abortCtrl);
            if (config.fetchPoolTimeout) {
                if (!this.#fetchPoolTimeoutId) {
                    this.#fetchPoolTimeoutId = setTimeout(() => {
                        this.#fetchPoolTimeoutId = undefined;
                        this.#fetchPoolCounter = 0;
                        this.#events.emit("update");
                    }, config.fetchPoolTimeout);
                }
                this.#fetchPoolCounter++;
            }
            let abortTimeout;
            try {
                const url = new URL(String(urlParam));
                const hostIsValid = await this.#isFetchHostnameAllowed(url.hostname);
                if (this.#disposed)
                    throw new Error("api disposed");
                if (!hostIsValid)
                    throw new Error("address blocked");
                let body = null;
                const paramBody = param.body;
                if (paramBody instanceof ArrayBuffer || typeof paramBody === "string")
                    body = paramBody;
                else if (Array.isArray(paramBody)) {
                    body = new FormData();
                    for (const [name, value, fileName] of paramBody) {
                        if (typeof value === "string") {
                            body.append(name, value);
                        }
                        else if (value instanceof ArrayBuffer) {
                            body.append(name, new File([new Uint8Array(value)], fileName ?? ""), fileName);
                        }
                        else {
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
                if (typeof fetchHeaders === "function") {
                    const headersObj = { ...param.headers };
                    const headersResult = fetchHeaders(headersObj) ?? headersObj;
                    for (let headerName in headersResult) {
                        headers.set(headerName, String(headersResult[headerName]));
                    }
                }
                else {
                    for (let headerName in fetchHeaders) {
                        headers.set(headerName, String(fetchHeaders[headerName]));
                    }
                }
                if (param.timeout && param.timeout > 0) {
                    const timeout = +param.timeout;
                    abortTimeout = setTimeout(() => {
                        abortCtrl.abort("aborted by timeout");
                    }, timeout);
                }
                const response = await fetchFn(url, {
                    body,
                    headers,
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
                this.#checkFetchContentLength(response);
                let resultData = undefined;
                let type = param.type;
                if (!type) {
                    const contentType = response.headers.get("content-type");
                    if (contentType?.startsWith("application/json"))
                        type = "json";
                    else if (contentType?.startsWith("multipart/form-data"))
                        type = "formData";
                    else if (contentType === "text" || contentType?.startsWith("text/"))
                        type = "text";
                    else if (contentType?.includes("+xml"))
                        type = "text";
                    else
                        type = "arrayBuffer";
                }
                if (type === "formData") {
                    resultData = [];
                    const formData = await response.formData();
                    await Promise.all([...formData.entries()].map(async ([name, value]) => {
                        if (typeof value === "string") {
                            resultData.push([name, value]);
                        }
                        else {
                            resultData.push([name, await mapFileToJson(value)]);
                        }
                    }));
                }
                if (type === "text")
                    resultData = await response.text();
                else if (type === "arrayBuffer")
                    resultData = await response.arrayBuffer();
                else if (type === "json")
                    resultData = await response.json();
                else if (!type)
                    resultData = await response.text();
                if (this.#disposed)
                    throw new Error("api disposed");
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
            }
            finally {
                if (abortTimeout !== undefined)
                    clearTimeout(abortTimeout);
                this.#abortControllers.delete(abortCtrl);
                this.#events.emit("update");
            }
        };
        async #waitForUpdate() {
            if (this.#events.listenerCount("update") >= this.#events.getMaxListeners()) {
                throw new Error("fetch pool overflow");
            }
            await new Promise((resolve, reject) => {
                this.#events.once("update", e => e ? reject(e) : resolve());
            });
        }
        #fetchPoolTimeoutId;
        #fetchPoolCounter = 0;
        #hasTimeoutBlock() {
            if (!config.fetchPoolTimeout)
                return false;
            return this.#fetchPoolCounter >= (config.fetchPoolCount ?? 0);
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
        #hasMaxActiveBlock() {
            if (typeof config.fetchMaxActiveCount !== "number")
                return false;
            return this.#abortControllers.size >= config.fetchMaxActiveCount;
        }
        #checkFetchContentLength(response) {
            if (fetchMaxContentLength == undefined)
                return;
            const contentLength = response.headers.get("content-length");
            if (!contentLength)
                throw new Error("fetch content length");
            const len = Number(contentLength);
            if (Number.isNaN(len))
                throw new Error("fetch content length");
            if (len > fetchMaxContentLength)
                throw new Error("fetch content length");
        }
        [Symbol.dispose] = () => {
            this.#events.emit("update", new Error("api disposed"));
            this.#events.setMaxListeners(0);
            this.#events.removeAllListeners();
            this.#disposed = true;
            for (const abortController of this.#abortControllers) {
                abortController.abort("aborted by api");
            }
        };
    }
    return ApiNetwork;
}
async function mapFileToJson(file) {
    file.lastModified;
    return {
        type: file.type,
        size: file.size,
        name: file.name,
        lastModified: file.lastModified,
        data: await file.arrayBuffer()
    };
}
