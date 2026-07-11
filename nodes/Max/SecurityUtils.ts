import { timingSafeEqual } from 'crypto';
import type {
	ICredentialDataDecryptedObject,
	IHookFunctions,
	IHttpRequestOptions,
	INodeTypeDescription,
	IWebhookFunctions,
	IExecuteFunctions,
} from 'n8n-workflow';

export const MAX_API_BASE_URL = 'https://platform-api2.max.ru';

const MAX_API_HOSTS = new Set(['platform-api.max.ru', 'platform-api2.max.ru']);
const TRUSTED_MAX_UPLOAD_HOSTS = new Set(['fu.oneme.ru', 'iu.oneme.ru', 'vu.okcdn.ru']);

type MaxContext = IExecuteFunctions | IHookFunctions | IWebhookFunctions;

function normalizeHeaderValue(value: unknown): string | undefined {
	if (Array.isArray(value)) {
		return typeof value[0] === 'string' ? value[0] : undefined;
	}
	return typeof value === 'string' ? value : undefined;
}

export function validateMaxWebhookSecret(expectedSecret: string, actualHeader: unknown): boolean {
	const actualSecret = normalizeHeaderValue(actualHeader);
	if (!expectedSecret || actualSecret === undefined) {
		return false;
	}

	const expectedBuffer = Buffer.from(expectedSecret, 'utf8');
	const actualBuffer = Buffer.from(actualSecret, 'utf8');
	if (expectedBuffer.length !== actualBuffer.length) {
		timingSafeEqual(expectedBuffer, Buffer.alloc(expectedBuffer.length));
		return false;
	}

	return timingSafeEqual(expectedBuffer, actualBuffer);
}

function hasAuthorizationHeader(headers: Record<string, unknown>): boolean {
	return Object.keys(headers).some((key) => key.toLowerCase() === 'authorization');
}

function removeAuthorizationHeader(headers: Record<string, unknown>): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === 'authorization') {
			delete headers[key];
		}
	}
}

export function hardenMaxHttpRequest(options: IHttpRequestOptions): IHttpRequestOptions {
	if (!options.url) {
		throw new Error('MAX request URL is required');
	}

	const parsed = new URL(options.url);
	const hostname = parsed.hostname.toLowerCase();
	const headers = { ...((options.headers ?? {}) as Record<string, unknown>) };
	const hardened = { ...options, headers } as IHttpRequestOptions & {
		maxRedirects?: number;
	};

	if (MAX_API_HOSTS.has(hostname)) {
		parsed.protocol = 'https:';
		parsed.hostname = 'platform-api2.max.ru';
		parsed.port = '';
		hardened.url = parsed.toString();
		return hardened;
	}

	if (TRUSTED_MAX_UPLOAD_HOSTS.has(hostname)) {
		if (parsed.protocol !== 'https:') {
			throw new Error('MAX upload URL must use HTTPS');
		}
		if (parsed.username || parsed.password) {
			throw new Error('MAX upload URL must not contain credentials');
		}
		removeAuthorizationHeader(headers);
		hardened.maxRedirects = 0;
		return hardened;
	}

	if (hasAuthorizationHeader(headers)) {
		throw new Error(`Refusing to send MAX credentials to untrusted host: ${hostname}`);
	}

	return hardened;
}

export function createSecuredMaxContext<T extends MaxContext>(context: T): T {
	const helpersProxy = new Proxy(context.helpers as object, {
		get(target, property, receiver) {
			if (property === 'httpRequest') {
				return async (options: IHttpRequestOptions) =>
					await (context.helpers.httpRequest as (request: IHttpRequestOptions) => Promise<unknown>)(
						hardenMaxHttpRequest(options),
					);
			}

			const value = Reflect.get(target, property, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});

	return new Proxy(context, {
		get(target, property, receiver) {
			if (property === 'helpers') {
				return helpersProxy;
			}
			if (property === 'getCredentials') {
				return async (...args: unknown[]) => {
					const getCredentials = target.getCredentials as (
						...params: unknown[]
					) => Promise<ICredentialDataDecryptedObject>;
					const credentials = await getCredentials.apply(target, args);
					return { ...credentials, baseUrl: MAX_API_BASE_URL };
				};
			}

			const value = Reflect.get(target, property, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	}) as T;
}

export function cloneDescriptionWithoutUrlAttachments(
	description: INodeTypeDescription,
): INodeTypeDescription {
	const clone = JSON.parse(JSON.stringify(description)) as INodeTypeDescription;

	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (!value || typeof value !== 'object') return;

		const object = value as Record<string, unknown>;
		if (object.name === 'inputType' && Array.isArray(object.options)) {
			object.options = object.options.filter(
				(option) =>
					!(
						option &&
						typeof option === 'object' &&
						(option as Record<string, unknown>).value === 'url'
					),
			);
		}
		for (const child of Object.values(object)) visit(child);
	};

	visit(clone.properties);
	return clone;
}

export function parseAllowedIds(value: unknown): string[] {
	if (typeof value !== 'string') return [];
	return value
		.split(',')
		.map((id) => id.trim())
		.filter(Boolean);
}
