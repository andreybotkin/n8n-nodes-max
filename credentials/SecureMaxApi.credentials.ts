import type { Icon, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';
import { MAX_API_BASE_URL } from '../nodes/Max/SecurityUtils';

export class SecureMaxApi implements ICredentialType {
	name = 'maxApi';
	displayName = 'Max API';
	icon: Icon = 'file:max.svg';
	documentationUrl = 'https://dev.max.ru/docs-api';

	properties: INodeProperties[] = [
		{
			displayName: 'Access Token',
			name: 'accessToken',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			description: 'The bot access token. Get it from MAX for Business.',
		},
	];

	test: ICredentialTestRequest = {
		request: {
			baseURL: MAX_API_BASE_URL,
			url: '/me',
			headers: {
				Authorization: '={{$credentials.accessToken}}',
			},
		},
	};
}
