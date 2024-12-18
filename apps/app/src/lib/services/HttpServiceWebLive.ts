import type { HttpService } from '$lib/services/HttpService';
import { Err, tryAsync } from '@repo/shared';

export const createHttpServiceWebLive = (): HttpService => ({
	async post({ formData, url, schema, headers }) {
		const responseResult = await tryAsync({
			try: () =>
				window.fetch(url, {
					method: 'POST',
					body: formData,
					headers,
				}),
			catch: (error) =>
				({
					_tag: 'NetworkError',
					message:
						error instanceof Error ? error.message : 'Please try again later.',
				}) as const,
		});
		if (!responseResult.ok) return responseResult;

		const response = responseResult.data;
		if (!response.ok) {
			return Err({
				_tag: 'HttpError',
				message: `Request failed with status ${response.status}.`,
			} as const);
		}
		const parseResult = await tryAsync({
			try: async () => {
				const json = await response.json();
				return schema.parse(json);
			},
			catch: (error) =>
				({
					_tag: 'ParseError',
					message:
						error instanceof Error ? error.message : 'Please try again later.',
				}) as const,
		});
		return parseResult;
	},
});
