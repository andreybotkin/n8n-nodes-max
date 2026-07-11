import type { IDataObject, IHttpRequestOptions } from 'n8n-workflow';
import { SecureMax } from '../SecureMax.node';
import { passesFailClosedFilters } from '../SecureMaxTrigger.node';
import type { MaxWebhookEvent } from '../MaxTriggerConfig';
import { hardenMaxHttpRequest, MAX_API_BASE_URL, validateMaxWebhookSecret } from '../SecurityUtils';

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
