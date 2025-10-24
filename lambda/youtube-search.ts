import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { google } from 'googleapis';

// Initialize SQS client
const sqs = new SQSClient({});

// Lambda function handler
export const handler = async () => {
	try {
		// Retrieve environment variables
		const query = process.env.SEARCH_QUERY!;
		const apiKey = process.env.YOUTUBE_API_KEY!;
		const queueUrl = process.env.QUEUE_URL!;

		// Validate environment variables
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

		// Initialize YouTube API client
		const youtube = google.youtube({
			version: 'v3',
			auth: apiKey,
		});

		// Search YouTube for videos based on the query
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

		// Extract video items from the response
		const videos = res.data.items ?? [];

		// Send each video to SQS
		for (const v of videos) {
			const videoId = v.id?.videoId!;
			const title = v.snippet?.title ?? 'Untitled';

			// Send video details to SQS
			await sqs.send(
				new SendMessageCommand({
					QueueUrl: queueUrl,
					MessageBody: JSON.stringify({ videoId, title }),
				}),
			);
		}

		console.log('✅ Finished enqueueing videos');
	} catch (error) {
		console.error('Error processing YouTube search:', error);
		throw error;
	}
};
