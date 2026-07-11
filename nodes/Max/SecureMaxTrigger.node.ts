import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { MaxTrigger as OriginalMaxTrigger } from './MaxTrigger.node';
import type { MaxWebhookEvent } from './MaxTriggerConfig';
import {
	createSecuredMaxContext,
	parseAllowedIds,
	validateMaxWebhookSecret,
} from './SecurityUtils';

const originalTrigger = new OriginalMaxTrigger();

function passesFailClosedFilters(body: MaxWebhookEvent, additionalFields: IDataObject): boolean {
	const allowedChatIds = parseAllowedIds(additionalFields['chatIds']);
	if (allowedChatIds.length > 0) {
		const chatId = body.chat?.chat_id ?? body.message?.recipient?.chat_id ?? body.chat_id;
		if (chatId === undefined || !allowedChatIds.includes(String(chatId))) return false;
	}

	const allowedUserIds = parseAllowedIds(additionalFields['userIds']);
	if (allowedUserIds.length > 0) {
		const userId =
			body.user?.user_id ??
			body.message?.sender?.user_id ??
			body.callback?.user?.user_id ??
			body.user_id;
		if (userId === undefined || !allowedUserIds.includes(String(userId))) return false;
	}

	return true;
}

export class SecureMaxTrigger implements INodeType {
	description: INodeTypeDescription = JSON.parse(
		JSON.stringify(originalTrigger.description),
	) as INodeTypeDescription;

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				return await originalTrigger.webhookMethods.default.checkExists.call(
					createSecuredMaxContext(this),
				);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				return await originalTrigger.webhookMethods.default.create.call(
					createSecuredMaxContext(this),
				);
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				return await originalTrigger.webhookMethods.default.delete.call(
					createSecuredMaxContext(this),
				);
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const additionalFields = this.getNodeParameter('additionalFields', {}) as IDataObject;
		const expectedSecret =
			typeof additionalFields['secret'] === 'string' ? additionalFields['secret'].trim() : '';

		if (expectedSecret) {
			const headers = this.getHeaderData();
			const actualSecret = headers['x-max-bot-api-secret'] ?? headers['X-Max-Bot-Api-Secret'];
			if (!validateMaxWebhookSecret(expectedSecret, actualSecret)) {
				this.getResponseObject().status(401).json({ error: 'Unauthorized' });
				return { noWebhookResponse: true };
			}
		}

		const body = this.getBodyData() as unknown as MaxWebhookEvent;
		if (!body || !passesFailClosedFilters(body, additionalFields)) {
			return { workflowData: [] };
		}

		return await originalTrigger.webhook.call(createSecuredMaxContext(this));
	}
}

export { passesFailClosedFilters };
