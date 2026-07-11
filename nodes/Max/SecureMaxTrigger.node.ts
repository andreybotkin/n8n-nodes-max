import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { MaxTrigger as OriginalMaxTrigger } from './MaxTrigger.node';
import type { MaxTriggerEvent, MaxWebhookEvent } from './MaxTriggerConfig';
import {
	buildMaxWebhookFingerprint,
	createSecuredMaxContext,
	parseAllowedIds,
	resolveMaxWebhookSecret,
	validateMaxWebhookSecret,
} from './SecurityUtils';

const originalTrigger = new OriginalMaxTrigger();
const SUBSCRIPTION_FINGERPRINT_KEY = 'maxWebhookSubscriptionFingerprint';

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

async function getCurrentSubscriptionFingerprint(context: IHookFunctions): Promise<string> {
	const additionalFields = context.getNodeParameter('additionalFields', {}) as IDataObject;
	const credentials = await context.getCredentials('maxApi');
	const secret = resolveMaxWebhookSecret(credentials, additionalFields);
	const events = context.getNodeParameter('events') as MaxTriggerEvent[];
	const webhookUrl = context.getNodeWebhookUrl('default');
	if (!webhookUrl) {
		throw new NodeOperationError(context.getNode(), 'MAX webhook URL is not available');
	}

	return buildMaxWebhookFingerprint({
		webhookUrl,
		events,
		secret,
		version:
			typeof additionalFields['version'] === 'string' ? additionalFields['version'] : undefined,
	});
}

export class SecureMaxTrigger implements INodeType {
	description: INodeTypeDescription = JSON.parse(
		JSON.stringify(originalTrigger.description),
	) as INodeTypeDescription;

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const fingerprint = await getCurrentSubscriptionFingerprint(this);
				const staticData = this.getWorkflowStaticData('node') as IDataObject;
				if (staticData[SUBSCRIPTION_FINGERPRINT_KEY] !== fingerprint) {
					return false;
				}

				return await originalTrigger.webhookMethods.default.checkExists.call(
					createSecuredMaxContext(this),
				);
			},
			async create(this: IHookFunctions): Promise<boolean> {
				const fingerprint = await getCurrentSubscriptionFingerprint(this);
				const securedContext = createSecuredMaxContext(this);

				const deleted = await originalTrigger.webhookMethods.default.delete.call(securedContext);
				if (!deleted) {
					throw new NodeOperationError(
						this.getNode(),
						'Failed to replace the existing MAX webhook subscription',
					);
				}

				const created = await originalTrigger.webhookMethods.default.create.call(securedContext);
				if (created) {
					const staticData = this.getWorkflowStaticData('node') as IDataObject;
					staticData[SUBSCRIPTION_FINGERPRINT_KEY] = fingerprint;
				}
				return created;
			},
			async delete(this: IHookFunctions): Promise<boolean> {
				const deleted = await originalTrigger.webhookMethods.default.delete.call(
					createSecuredMaxContext(this),
				);
				if (deleted) {
					const staticData = this.getWorkflowStaticData('node') as IDataObject;
					delete staticData[SUBSCRIPTION_FINGERPRINT_KEY];
				}
				return deleted;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const additionalFields = this.getNodeParameter('additionalFields', {}) as IDataObject;
		let expectedSecret: string;
		try {
			const credentials = await this.getCredentials('maxApi');
			expectedSecret = resolveMaxWebhookSecret(credentials, additionalFields);
		} catch {
			this.getResponseObject().status(401).json({ error: 'Unauthorized' });
			return { noWebhookResponse: true };
		}

		const headers = this.getHeaderData();
		const actualSecret = headers['x-max-bot-api-secret'] ?? headers['X-Max-Bot-Api-Secret'];
		if (!validateMaxWebhookSecret(expectedSecret, actualSecret)) {
			this.getResponseObject().status(401).json({ error: 'Unauthorized' });
			return { noWebhookResponse: true };
		}

		const body = this.getBodyData() as unknown as MaxWebhookEvent;
		if (!body || !passesFailClosedFilters(body, additionalFields)) {
			return { workflowData: [] };
		}

		return await originalTrigger.webhook.call(createSecuredMaxContext(this));
	}
}

export { getCurrentSubscriptionFingerprint, passesFailClosedFilters };
