import type {
	IDataObject,
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
} from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { Max as OriginalMax } from './Max.node';
import { cloneDescriptionWithoutUrlAttachments, createSecuredMaxContext } from './SecurityUtils';

const originalNode = new OriginalMax();

export class SecureMax implements INodeType {
	description: INodeTypeDescription = cloneDescriptionWithoutUrlAttachments(
		originalNode.description,
	);

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const resource = this.getNodeParameter('resource', 0);
		const operation = this.getNodeParameter('operation', 0);

		if (resource === 'message' && operation === 'sendMessage') {
			const items = this.getInputData();
			for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
				const additionalFields = this.getNodeParameter(
					'additionalFields',
					itemIndex,
					{},
				) as IDataObject;
				const attachments = additionalFields['attachments'] as IDataObject | undefined;
				const configuredAttachments = attachments?.['attachment'];
				if (
					Array.isArray(configuredAttachments) &&
					configuredAttachments.some(
						(attachment) =>
							attachment &&
							typeof attachment === 'object' &&
							(attachment as IDataObject)['inputType'] === 'url',
					)
				) {
					throw new NodeOperationError(
						this.getNode(),
						'URL attachments are disabled for security. Use Binary Data or an existing MAX token.',
						{ itemIndex },
					);
				}
			}
		}

		return await originalNode.execute.call(createSecuredMaxContext(this));
	}
}
