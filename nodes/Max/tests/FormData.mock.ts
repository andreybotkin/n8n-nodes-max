export default class FormDataMock {
	private readonly headers = {
		'content-type': 'multipart/form-data; boundary=--------------------------test-boundary',
	};

	append(_name: string, _value: unknown, _options?: unknown): void {
		// The upload tests validate the request contract, not the form-data implementation.
	}

	getHeaders(): Record<string, string> {
		return { ...this.headers };
	}
}
