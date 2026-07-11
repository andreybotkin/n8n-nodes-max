#!/usr/bin/env python3
from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def write(path: str, content: str) -> None:
    target = ROOT / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")


def replace_once(path: str, old: str, new: str) -> None:
    content = read(path)
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}, found {count}: {old[:100]!r}")
    write(path, content.replace(old, new, 1))


def replace_all(path: str, old: str, new: str, minimum: int = 1) -> None:
    content = read(path)
    count = content.count(old)
    if count < minimum:
        raise RuntimeError(f"Expected at least {minimum} matches in {path}, found {count}: {old!r}")
    write(path, content.replace(old, new))


def replace_regex_once(path: str, pattern: str, replacement: str) -> None:
    content = read(path)
    updated, count = re.subn(pattern, replacement, content, count=1, flags=re.MULTILINE | re.DOTALL)
    if count != 1:
        raise RuntimeError(f"Expected exactly one regex match in {path}, found {count}: {pattern[:120]!r}")
    write(path, updated)


# 1. Declare the runtime dependency that GenericFunctions imports directly.
package_path = ROOT / "package.json"
package = json.loads(package_path.read_text(encoding="utf-8"))
package.setdefault("dependencies", {})["form-data"] = "^4.0.4"
package["dependencies"] = dict(sorted(package["dependencies"].items()))
package_path.write_text(json.dumps(package, ensure_ascii=False, indent="\t") + "\n", encoding="utf-8")


# 2. Central security helpers.
write(
    "nodes/Max/SecurityUtils.ts",
    r'''import { timingSafeEqual } from 'crypto';
import { promises as dns } from 'dns';
import { isIP } from 'net';
import { basename } from 'path';

export const MAX_API_BASE_URL = 'https://platform-api2.max.ru';
export const MAX_REMOTE_FILE_TIMEOUT_MS = 30_000;
export const MAX_REMOTE_FILE_MAX_REDIRECTS = 3;

const TRUSTED_MAX_UPLOAD_HOSTS = new Set(['fu.oneme.ru', 'iu.oneme.ru', 'vu.okcdn.ru']);

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
		// Keep comparison work approximately constant even for different lengths.
		timingSafeEqual(expectedBuffer, Buffer.alloc(expectedBuffer.length));
		return false;
	}

	return timingSafeEqual(expectedBuffer, actualBuffer);
}

export function sanitizeAttachmentFileName(fileName: string): string {
	const withoutNullBytes = fileName.replace(/\0/g, '');
	const safeName = basename(withoutNullBytes).trim().slice(0, 255);
	return safeName && safeName !== '.' && safeName !== '..' ? safeName : 'file';
}

function isPrivateIpv4(address: string): boolean {
	const octets = address.split('.').map(Number);
	if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
		return true;
	}

	const [a, b] = octets;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 192 && b === 0) ||
		(a === 192 && b === 0 && octets[2] === 2) ||
		(a === 198 && (b === 18 || b === 19)) ||
		(a === 198 && b === 51 && octets[2] === 100) ||
		(a === 203 && b === 0 && octets[2] === 113) ||
		a >= 224
	);
}

function isPrivateIpv6(address: string): boolean {
	const normalized = address.toLowerCase().split('%')[0];
	if (
		normalized === '::' ||
		normalized === '::1' ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd') ||
		normalized.startsWith('fe8') ||
		normalized.startsWith('fe9') ||
		normalized.startsWith('fea') ||
		normalized.startsWith('feb') ||
		normalized.startsWith('2001:db8:')
	) {
		return true;
	}

	const ipv4Mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
	return ipv4Mapped ? isPrivateIpv4(ipv4Mapped[1]) : false;
}

export function isPublicIpAddress(address: string): boolean {
	const version = isIP(address);
	if (version === 4) {
		return !isPrivateIpv4(address);
	}
	if (version === 6) {
		return !isPrivateIpv6(address);
	}
	return false;
}

export async function assertSafeRemoteFileUrl(value: string): Promise<URL> {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('Attachment URL is invalid');
	}

	if (!['http:', 'https:'].includes(parsed.protocol)) {
		throw new Error('Attachment URL must use HTTP or HTTPS');
	}
	if (parsed.username || parsed.password) {
		throw new Error('Attachment URL must not contain credentials');
	}

	const hostname = parsed.hostname.toLowerCase();
	if (hostname === 'localhost' || hostname.endsWith('.localhost')) {
		throw new Error('Attachment URL points to a local host');
	}

	if (isIP(hostname)) {
		if (!isPublicIpAddress(hostname)) {
			throw new Error('Attachment URL points to a private or non-routable address');
		}
		return parsed;
	}

	const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
	if (addresses.length === 0 || addresses.some(({ address }) => !isPublicIpAddress(address))) {
		throw new Error('Attachment URL resolves to a private or non-routable address');
	}

	return parsed;
}

export function assertTrustedMaxUploadUrl(value: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		throw new Error('MAX API returned an invalid upload URL');
	}

	if (parsed.protocol !== 'https:') {
		throw new Error('MAX upload URL must use HTTPS');
	}
	if (parsed.username || parsed.password) {
		throw new Error('MAX upload URL must not contain credentials');
	}
	if (!TRUSTED_MAX_UPLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
		throw new Error(`MAX API returned an untrusted upload host: ${parsed.hostname}`);
	}

	return parsed;
}
''',
)


# 3. Credentials: token only; the API endpoint is no longer user-controlled.
replace_regex_once(
    "credentials/MaxApi.credentials.ts",
    r"\n\t\t\{\n\t\t\tdisplayName: 'Base URL',.*?\n\t\t\},",
    "",
)
replace_once(
    "credentials/MaxApi.credentials.ts",
    "baseURL: '={{$credentials.baseUrl}}',",
    "baseURL: 'https://platform-api2.max.ru',",
)


# 4. Use the fixed official API endpoint and hardened upload/download helpers.
generic_path = "nodes/Max/GenericFunctions.ts"
replace_once(
    generic_path,
    "import FormData from 'form-data';\n\nconst DEFAULT_MAX_BASE_URL = 'https://platform-api.max.ru';",
    "import FormData from 'form-data';\nimport {\n\tassertSafeRemoteFileUrl,\n\tassertTrustedMaxUploadUrl,\n\tMAX_API_BASE_URL,\n\tMAX_REMOTE_FILE_MAX_REDIRECTS,\n\tMAX_REMOTE_FILE_TIMEOUT_MS,\n\tsanitizeAttachmentFileName,\n} from './SecurityUtils';",
)
replace_all(
    generic_path,
    "(credentials['baseUrl'] as string) || DEFAULT_MAX_BASE_URL",
    "MAX_API_BASE_URL",
    minimum=1,
)
replace_all(generic_path, "https://platform-api.max.ru", "https://platform-api2.max.ru", minimum=0)

new_download_function = r'''export async function downloadFileFromUrl(
	this: IExecuteFunctions,
	url: string,
	fileName?: string,
	maxFileSize: number = 20 * 1024 * 1024,
): Promise<{ filePath: string; fileName: string; fileSize: number }> {
	let filePath = '';
	try {
		let currentUrl = await assertSafeRemoteFileUrl(url);
		let response: Response | undefined;

		for (let redirectCount = 0; redirectCount <= MAX_REMOTE_FILE_MAX_REDIRECTS; redirectCount++) {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), MAX_REMOTE_FILE_TIMEOUT_MS);
			try {
				response = await fetch(currentUrl, {
					method: 'GET',
					redirect: 'manual',
					signal: controller.signal,
				});
			} finally {
				clearTimeout(timeout);
			}

			if (response.status >= 300 && response.status < 400) {
				const location = response.headers.get('location');
				if (!location || redirectCount === MAX_REMOTE_FILE_MAX_REDIRECTS) {
					throw new Error('Attachment URL exceeded the redirect limit');
				}
				currentUrl = await assertSafeRemoteFileUrl(new URL(location, currentUrl).toString());
				continue;
			}
			break;
		}

		if (!response || !response.ok || !response.body) {
			throw new Error(`Failed to download file: HTTP ${response?.status ?? 'unknown'}`);
		}

		const contentLength = response.headers.get('content-length');
		if (contentLength && Number(contentLength) > maxFileSize) {
			throw new Error(`Remote file exceeds the maximum allowed size of ${maxFileSize} bytes`);
		}

		const pathName = currentUrl.pathname.split('/').pop() || `file_${randomUUID()}`;
		const decodedPathName = (() => {
			try {
				return decodeURIComponent(pathName);
			} catch {
				return pathName;
			}
		})();
		const safeFileName = sanitizeAttachmentFileName(fileName || decodedPathName);
		filePath = join(tmpdir(), `max_upload_${randomUUID()}_${safeFileName}`);

		const fs = await import('fs');
		const { Readable, Transform } = await import('stream');
		const { pipeline } = await import('stream/promises');
		let fileSize = 0;
		const sizeLimiter = new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				fileSize += chunk.length;
				if (fileSize > maxFileSize) {
					callback(new Error(`Remote file exceeds the maximum allowed size of ${maxFileSize} bytes`));
					return;
				}
				callback(null, chunk);
			},
		});

		await pipeline(
			Readable.fromWeb(response.body as any),
			sizeLimiter,
			fs.createWriteStream(filePath, { flags: 'wx' }),
		);

		return { filePath, fileName: safeFileName, fileSize };
	} catch (error) {
		if (filePath) {
			try {
				const fs = await import('fs');
				await fs.promises.unlink(filePath);
			} catch {
				// Ignore cleanup errors.
			}
		}
		throw new NodeOperationError(
			this.getNode(),
			`Failed to download file from URL: ${(error as Error).message}`,
		);
	}
}

'''
replace_regex_once(
    generic_path,
    r"export async function downloadFileFromUrl\(.*?\n\}\n\n(?=/\*\*\n \* Upload file to Max API)",
    new_download_function,
)
replace_once(
    generic_path,
    "\t\tconst baseUrl = MAX_API_BASE_URL;\n\t\tconst accessToken = credentials['accessToken'] as string;\n\n\t\t// Step 1: Get upload URL from Max API",
    "\t\tconst accessToken = credentials['accessToken'] as string;\n\n\t\t// Step 1: Get upload URL from Max API",
)
replace_once(generic_path, "url: `${baseUrl}/uploads`,", "url: `${MAX_API_BASE_URL}/uploads`,")
replace_once(
    generic_path,
    "\t\tif (!uploadUrlResponse.url || typeof uploadUrlResponse.url !== 'string') {\n\t\t\tthrow new Error('Failed to get upload URL from Max API');\n\t\t}\n\n\t\t// Step 2: Read file data from binary data",
    "\t\tif (!uploadUrlResponse.url || typeof uploadUrlResponse.url !== 'string') {\n\t\t\tthrow new Error('Failed to get upload URL from Max API');\n\t\t}\n\t\tconst trustedUploadUrl = assertTrustedMaxUploadUrl(uploadUrlResponse.url);\n\n\t\t// Step 2: Read file data from binary data",
)
replace_once(
    generic_path,
    "\t\tformData.append('data', fileBuffer, {\n\t\t\tfilename: fileName,",
    "\t\tformData.append('data', fileBuffer, {\n\t\t\tfilename: sanitizeAttachmentFileName(fileName),",
)
replace_once(
    generic_path,
    "\t\t\turl: uploadUrlResponse.url,\n\t\t\tbody: formData,\n\t\t\theaders: {\n\t\t\t\t...formData.getHeaders(),\n\t\t\t\t...getAuthHeaders(accessToken),\n\t\t\t},\n\t\t\treturnFullResponse: true,",
    "\t\t\turl: trustedUploadUrl.toString(),\n\t\t\tbody: formData,\n\t\t\theaders: formData.getHeaders(),\n\t\t\tmaxRedirects: 0,\n\t\t\treturnFullResponse: true,",
)
replace_once(
    generic_path,
    "\t\tconfig.fileName,\n\t);",
    "\t\tconfig.fileName,\n\t\tFILE_SIZE_LIMITS[config.type],\n\t);",
)


# 5. Webhook manager: fixed API endpoint, no credential-controlled destination.
manager_path = "nodes/Max/MaxWebhookManager.ts"
replace_once(
    manager_path,
    "import type { MaxSubscriptionsResponse, MaxTriggerEvent } from './MaxTriggerConfig';",
    "import type { MaxSubscriptionsResponse, MaxTriggerEvent } from './MaxTriggerConfig';\nimport { MAX_API_BASE_URL } from './SecurityUtils';",
)
replace_once(manager_path, "\tprivate readonly DEFAULT_BASE_URL = 'https://platform-api.max.ru';\n\n", "")
replace_once(
    manager_path,
    "\t\tconst baseUrl = (credentials['baseUrl'] as string) || this.DEFAULT_BASE_URL;",
    "\t\tconst baseUrl = MAX_API_BASE_URL;",
)


# 6. Webhook authentication and fail-closed filters.
event_path = "nodes/Max/MaxEventProcessor.ts"
replace_once(
    event_path,
    "import type { MaxWebhookEvent, MaxTriggerEvent } from './MaxTriggerConfig';",
    "import type { MaxWebhookEvent, MaxTriggerEvent } from './MaxTriggerConfig';\nimport { validateMaxWebhookSecret } from './SecurityUtils';",
)
replace_once(
    event_path,
    "\t\t\tconst events = this.getNodeParameter('events') as MaxTriggerEvent[];\n\n\t\t\tconsole.log('Max Trigger - Processing webhook event');",
    "\t\t\tconst events = this.getNodeParameter('events') as MaxTriggerEvent[];\n\n\t\t\tconst expectedSecret =\n\t\t\t\ttypeof additionalFields['secret'] === 'string' ? additionalFields['secret'].trim() : '';\n\t\t\tif (expectedSecret) {\n\t\t\t\tconst headers = this.getHeaderData();\n\t\t\t\tconst receivedSecret =\n\t\t\t\t\theaders['x-max-bot-api-secret'] ?? headers['X-Max-Bot-Api-Secret'];\n\t\t\t\tif (!validateMaxWebhookSecret(expectedSecret, receivedSecret)) {\n\t\t\t\t\tconsole.log('Max Trigger - Rejected webhook with invalid secret');\n\t\t\t\t\tthis.getResponseObject().status(401).json({ error: 'Unauthorized' });\n\t\t\t\t\treturn { noWebhookResponse: true };\n\t\t\t\t}\n\t\t\t}\n\n\t\t\tconsole.log('Max Trigger - Processing webhook event');",
)
replace_once(
    event_path,
    "\t\t} catch (filterError) {\n\t\t\tconsole.log('Max Trigger - Error in filtering, proceeding without filters:', filterError);\n\t\t\t// Continue processing even if filtering fails\n\t\t\treturn true;\n\t\t}",
    "\t\t} catch (filterError) {\n\t\t\tconsole.log('Max Trigger - Error in filtering, rejecting event:', filterError);\n\t\t\treturn false;\n\t\t}",
)
replace_once(
    event_path,
    "\t\tif (chatId === undefined) {\n\t\t\treturn true; // No chat ID to filter on\n\t\t}",
    "\t\tif (chatId === undefined) {\n\t\t\tconsole.log('Max Trigger - Chat ID filter configured, but event has no chat ID');\n\t\t\treturn false;\n\t\t}",
)
replace_once(
    event_path,
    "\t\tif (userId === undefined) {\n\t\t\treturn true; // No user ID to filter on\n\t\t}",
    "\t\tif (userId === undefined) {\n\t\t\tconsole.log('Max Trigger - User ID filter configured, but event has no user ID');\n\t\t\treturn false;\n\t\t}",
)
replace_once(event_path, "\t\tif (chatInfo?.chat_id) {", "\t\tif (chatInfo?.chat_id !== undefined) {")
replace_once(event_path, "\t\tif (userInfo?.user_id) {", "\t\tif (userInfo?.user_id !== undefined) {")


# 7. Refresh endpoint references in documentation.
for documentation_path in ["README.md", "CHANGELOG.md"]:
    content = read(documentation_path)
    write(documentation_path, content.replace("platform-api.max.ru", "platform-api2.max.ru"))


# 8. Focused security regression tests.
write(
    "nodes/Max/tests/SecurityUtils.test.ts",
    r'''import {
	assertTrustedMaxUploadUrl,
	isPublicIpAddress,
	sanitizeAttachmentFileName,
	validateMaxWebhookSecret,
} from '../SecurityUtils';

describe('SecurityUtils', () => {
	it('compares webhook secrets safely', () => {
		expect(validateMaxWebhookSecret('secret-value', 'secret-value')).toBe(true);
		expect(validateMaxWebhookSecret('secret-value', 'wrong-value')).toBe(false);
		expect(validateMaxWebhookSecret('secret-value', undefined)).toBe(false);
	});

	it('sanitizes attachment file names', () => {
		expect(sanitizeAttachmentFileName('../../etc/passwd')).toBe('passwd');
		expect(sanitizeAttachmentFileName('..\\..\\evil.txt')).toBe('..\\..\\evil.txt');
		expect(sanitizeAttachmentFileName('\0')).toBe('file');
	});

	it('accepts only documented MAX upload hosts over HTTPS', () => {
		expect(assertTrustedMaxUploadUrl('https://fu.oneme.ru/upload.do').hostname).toBe('fu.oneme.ru');
		expect(assertTrustedMaxUploadUrl('https://iu.oneme.ru/upload.do').hostname).toBe('iu.oneme.ru');
		expect(assertTrustedMaxUploadUrl('https://vu.okcdn.ru/upload.do').hostname).toBe('vu.okcdn.ru');
		expect(() => assertTrustedMaxUploadUrl('https://fu.oneme.ru.evil.example/upload')).toThrow(
			'untrusted upload host',
		);
		expect(() => assertTrustedMaxUploadUrl('http://fu.oneme.ru/upload')).toThrow('must use HTTPS');
	});

	it('rejects private and non-routable IP addresses', () => {
		expect(isPublicIpAddress('127.0.0.1')).toBe(false);
		expect(isPublicIpAddress('10.0.0.1')).toBe(false);
		expect(isPublicIpAddress('169.254.169.254')).toBe(false);
		expect(isPublicIpAddress('::1')).toBe(false);
		expect(isPublicIpAddress('8.8.8.8')).toBe(true);
	});
});
''',
)

write(
    "nodes/Max/tests/MaxEventProcessorSecurity.test.ts",
    r'''import type { IDataObject, IWebhookFunctions } from 'n8n-workflow';
import { MaxEventProcessor } from '../MaxEventProcessor';
import type { MaxWebhookEvent } from '../MaxTriggerConfig';

describe('MaxEventProcessor security', () => {
	it('rejects a webhook when the configured secret does not match', async () => {
		const response = {
			status: jest.fn().mockReturnThis(),
			json: jest.fn().mockReturnThis(),
		};
		const context = {
			getBodyData: jest.fn().mockReturnValue({
				update_type: 'message_created',
				timestamp: Date.now(),
			} as MaxWebhookEvent),
			getNodeParameter: jest
				.fn()
				.mockReturnValueOnce({ secret: 'expected-secret' } as IDataObject)
				.mockReturnValueOnce(['message_created']),
			getHeaderData: jest.fn().mockReturnValue({ 'x-max-bot-api-secret': 'wrong-secret' }),
			getResponseObject: jest.fn().mockReturnValue(response),
			helpers: { returnJsonArray: jest.fn((data) => data) },
		} as unknown as IWebhookFunctions;

		const result = await new MaxEventProcessor().processWebhookEvent.call(context);

		expect(response.status).toHaveBeenCalledWith(401);
		expect(response.json).toHaveBeenCalledWith({ error: 'Unauthorized' });
		expect(result.noWebhookResponse).toBe(true);
	});

	it('fails closed when a chat filter is configured but the event has no chat ID', () => {
		const event: MaxWebhookEvent = {
			update_type: 'bot_started',
			timestamp: Date.now(),
			user: { user_id: 123 },
		};

		expect(new MaxEventProcessor().passesAdditionalFilters(event, { chatIds: '42' })).toBe(false);
	});

	it('fails closed when a user filter is configured but the event has no user ID', () => {
		const event: MaxWebhookEvent = {
			update_type: 'chat_title_changed',
			timestamp: Date.now(),
			chat: { chat_id: 42, type: 'chat' },
		};

		expect(new MaxEventProcessor().passesAdditionalFilters(event, { userIds: '123' })).toBe(false);
	});
});
''',
)

print("Security hardening applied successfully")
