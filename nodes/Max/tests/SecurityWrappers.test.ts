import type {
	IDataObject,
	IHookFunctions,
	IHttpRequestOptions,
	IWebhookFunctions,
} from 'n8n-workflow';
import { SecureMaxApi } from '../../../credentials/SecureMaxApi.credentials';
import { SecureMax } from '../SecureMax.node';
import { passesFailClosedFilters, SecureMaxTrigger } from '../SecureMaxTrigger.node';
import type { MaxWebhookEvent } from '../MaxTriggerConfig';
import {
	buildMaxWebhookFingerprint,
	hardenMaxHttpRequest,
	MAX_API_BASE_URL,
	requireMaxWebhookSecret,
	resolveMaxWebhookSecret,
	validateMaxWebhookSecret,
} from '../SecurityUtils';

describe('MAX security wrappers', () => {
	it('pins API requests to the official endpoint', () => {
		const request = hardenMaxHttpRequest({
			method: 'GET',
			url: 'https://platform-api.max.ru/me',
			headers: { Authorization: 'secret-token' },
		} as IHttpRequestOptions);

		expect(request.url).toBe(`${MAX_API_BASE_URL}/me`);
		expect(request.headers).toEqual({ Authorization: 'secret-token' });
	});

	it('removes credentials from documented upload hosts and disables redirects', () => {
		const request = hardenMaxHttpRequest({
			method: 'POST',
			url: 'https://fu.oneme.ru/upload.do',
			headers: { Authorization: 'secret-token', 'content-type': 'multipart/form-data' },
		} as IHttpRequestOptions) as IHttpRequestOptions & { maxRedirects?: number };

		expect(request.headers).toEqual({ 'content-type': 'multipart/form-data' });
		expect(request.maxRedirects).toBe(0);
	});

	it('never sends MAX credentials to an untrusted upload host', () => {
		expect(() =>
			hardenMaxHttpRequest({
				method: 'POST',
				url: 'https://attacker.example/upload',
				headers: { Authorization: 'secret-token' },
			} as IHttpRequestOptions),
		).toThrow('Refusing to send MAX credentials to untrusted host');
	});

	it('validates webhook secrets', () => {
		expect(validateMaxWebhookSecret('expected', 'expected')).toBe(true);
		expect(validateMaxWebhookSecret('expected', 'wrong')).toBe(false);
		expect(validateMaxWebhookSecret('expected', undefined)).toBe(false);
	});

	it('requires a webhook secret with the documented format', () => {
		expect(requireMaxWebhookSecret(' bot_secret-123 ')).toBe('bot_secret-123');
		expect(() => requireMaxWebhookSecret('')).toThrow('Webhook Secret is required');
		expect(() => requireMaxWebhookSecret('1234')).toThrow('Webhook Secret is required');
		expect(() => requireMaxWebhookSecret('x'.repeat(257))).toThrow('Webhook Secret is required');
		expect(() => requireMaxWebhookSecret('invalid secret')).toThrow('may contain only');
		expect(() => requireMaxWebhookSecret('invalid$secret')).toThrow('may contain only');
	});

	it('prefers the encrypted credential secret and supports the legacy node field', () => {
		expect(
			resolveMaxWebhookSecret(
				{ webhookSecret: 'credential_secret' },
				{ secret: 'legacy_secret' },
			),
		).toBe('credential_secret');
		expect(resolveMaxWebhookSecret({}, { secret: 'legacy_secret' })).toBe('legacy_secret');
	});

	it('defines webhook secret as a required password credential', () => {
		const property = new SecureMaxApi().properties.find(
			(candidate) => candidate.name === 'webhookSecret',
		);

		expect(property).toMatchObject({
			type: 'string',
			required: true,
			typeOptions: { password: true },
		});
	});

	it('does not expose the legacy webhook secret field in the trigger UI', () => {
		const serializedDescription = JSON.stringify(new SecureMaxTrigger().description);
		expect(serializedDescription).not.toContain('"name":"secret"');
	});

	it('creates a stable fingerprint and changes it for webhook configuration changes', () => {
		const base = {
			webhookUrl: 'https://n8n.example.com/webhook/max',
			events: ['message_created', 'bot_started'],
			secret: 'secret_123',
			version: '0.0.1',
		};
		const first = buildMaxWebhookFingerprint(base);
		const reordered = buildMaxWebhookFingerprint({
			...base,
			events: ['bot_started', 'message_created'],
		});
		const rotatedSecret = buildMaxWebhookFingerprint({ ...base, secret: 'secret_456' });

		expect(reordered).toBe(first);
		expect(rotatedSecret).not.toBe(first);
	});

	it('rejects webhook activation without a valid secret', async () => {
		const context = {
			getNodeParameter: jest.fn().mockReturnValue({}),
			getCredentials: jest.fn().mockResolvedValue({ webhookSecret: '' }),
		} as unknown as IHookFunctions;

		await expect(
			new SecureMaxTrigger().webhookMethods.default.create.call(context),
		).rejects.toThrow('Webhook Secret is required');
	});

	it.each([
		['a missing secret setting', {}, {}, {}],
		['a missing header', { webhookSecret: 'expected' }, {}, {}],
		[
			'an invalid header',
			{ webhookSecret: 'expected' },
			{},
			{ 'x-max-bot-api-secret': 'wrong' },
		],
	])(
		'rejects %s before processing an event',
		async (_case, credentials, additionalFields, headers) => {
			const status = jest.fn();
			const json = jest.fn();
			status.mockReturnValue({ json });
			const context = {
				getNodeParameter: jest.fn().mockReturnValue(additionalFields),
				getCredentials: jest.fn().mockResolvedValue(credentials),
				getHeaderData: jest.fn().mockReturnValue(headers),
				getResponseObject: jest.fn().mockReturnValue({ status }),
				getBodyData: jest.fn(),
			} as unknown as IWebhookFunctions;

			await expect(new SecureMaxTrigger().webhook.call(context)).resolves.toEqual({
				noWebhookResponse: true,
			});
			expect(status).toHaveBeenCalledWith(401);
			expect(json).toHaveBeenCalledWith({ error: 'Unauthorized' });
			expect(context.getBodyData).not.toHaveBeenCalled();
		},
	);

	it('removes URL attachments from the n8n node UI', () => {
		const serializedDescription = JSON.stringify(new SecureMax().description);
		expect(serializedDescription).not.toContain('"value":"url"');
	});

	it('fails closed when a configured filter cannot be evaluated', () => {
		const event = {
			update_type: 'bot_started',
			timestamp: Date.now(),
			user: { user_id: 123 },
		} as MaxWebhookEvent;

		expect(passesFailClosedFilters(event, { chatIds: '42' } as IDataObject)).toBe(false);
	});
});
