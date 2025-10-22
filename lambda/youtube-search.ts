import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { google } from 'googleapis';

const sqs = new SQSClient({});

export const handler = async () => {
	try {
		const query = process.env.SEARCH_QUERY!;
		const apiKey = process.env.YOUTUBE_API_KEY!;
		const queueUrl = process.env.QUEUE_URL!;

		console.log(`--- DEBUGGING ---`);
		console.log(`YOUTUBE_API_KEY: [${apiKey}]`);
		console.log(`QUEUE_URL: [${queueUrl}]`);
		console.log(`SEARCH_QUERY: [${query}]`);
		console.log(`-------------------`);

		if (!apiKey || apiKey.trim() === '') {
			throw new Error(
				'FATAL: YOUTUBE_API_KEY environment variable is not set!',
			);
		}
		if (!queueUrl) {
			throw new Error('FATAL: QUEUE_URL environment variable is not set!');
		}
		if (!query) {
			throw new Error('FATAL: SEARCH_QUERY environment variable is not set!');
		}

		const youtube = google.youtube({
			version: 'v3',
			auth: apiKey,
		});

		console.log(`Searching YouTube for '${query}'`);

		const res = await youtube.search.list({
			key: apiKey,
			part: ['snippet'],
			q: query,
			type: ['video'],
			order: 'date',
			publishedAfter: new Date(
				Date.now() - 30 * 24 * 3600 * 1000,
			).toISOString(),
			videoDuration: 'short',
			maxResults: 3,
		});
		console.log('🚀 ~ handler ~ res:', res);

		const videos = res.data.items ?? [];
		console.log('🚀 ~ handler ~ videos:', videos);

		for (const v of videos) {
			console.log('🚀 ~ handler ~ v:', v);
			const videoId = v.id?.videoId!;
			const title = v.snippet?.title ?? 'Untitled';

			console.log(`Sending video ${title} (${videoId}) to SQS...`);
			await sqs.send(
				new SendMessageCommand({
					QueueUrl: queueUrl,
					MessageBody: JSON.stringify({ videoId, title }),
				}),
			);
		}

		console.log('✅ Finished enqueueing videos');
	} catch (error) {
		console.error('Error processing YouTube search???:', error);
		throw error;
	}
};
