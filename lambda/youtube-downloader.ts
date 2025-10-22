import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSHandler, SQSEvent } from 'aws-lambda';
import ytdl from '@distube/ytdl-core';
import { Upload } from '@aws-sdk/lib-storage';

const s3Client = new S3Client({});
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);

const BUCKET_NAME = process.env.BUCKET_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
export const handler: SQSHandler = async (event: SQSEvent) => {
	console.log(`Received ${event.Records.length} video(s) to process.`);

	for (const record of event.Records) {
		let videoId: string;
		let title: string;

		try {
			const body = JSON.parse(record.body);
			videoId = body.videoId;
			title = body.title;

			if (!videoId) {
				throw new Error('Message missing `videoId`');
			}

			console.log(`Checking DynamoDB for: ${videoId}`);
			const existing = await ddbDocClient.send(
				new GetCommand({ TableName: TABLE_NAME, Key: { videoId } }),
			);

			if (existing.Item) {
				console.log(`Already downloaded ${title} (${videoId})! Skipping...`);
				continue;
			}

			console.log(`Processing new video: "${title}" (${videoId})`);
			const safeTitle = title.replace(/[^a-z0-9 -]/gi, '_');
			const s3Key = `videos/${safeTitle} - ${videoId}.mp4`;

			console.log(`... streaming to S3: s3://${BUCKET_NAME}/${s3Key}`);

			// --- MOCK DOWNLOAD/UPLOAD ---
			// console.log(`... simulating download for 2 seconds...`);
			// await sleep(2000); // Simulate the time taken to download

			// // Instead of uploading a video, let's just put a tiny text file
			// // to prove the S3 connection works.
			// await s3Client.send(
			// 	new PutObjectCommand({
			// 		Bucket: BUCKET_NAME,
			// 		Key: s3Key,
			// 		Body: `Mock download of ${videoId} at ${new Date().toISOString()}`,
			// 		ContentType: 'text/plain',
			// 	}),
			// );
			// console.log(`... successfully "uploaded" to S3: ${s3Key}`);
			// --- END OF MOCK ---

			const videoStream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
				quality: 'lowest',
				filter: 'audioandvideo',
				requestOptions: {
					headers: { 'User-Agent': 'Mozilla/5.0' },
				},
			});

			// Create the Uploader
			const uploader = new Upload({
				client: s3Client,
				params: {
					Bucket: BUCKET_NAME,
					Key: s3Key,
					Body: videoStream,
					ContentType: 'video/mp4',
				},
			});

			await uploader.done();
			console.log(`... successfully uploaded "${title}"`);

			// UPDATE DYNAMODB
			console.log(`... writing record to DynamoDB`);
			await ddbDocClient.send(
				new PutCommand({
					TableName: TABLE_NAME,
					Item: {
						videoId: videoId,
						title: title,
						s3Key: s3Key,
						s3Bucket: BUCKET_NAME,
						downloadedAt: new Date().toISOString(),
					},
				}),
			);

			console.log(`✅ Successfully processed "${title}" (${videoId})`);
		} catch (err: any) {
			console.error(`❌ FAILED to process message`, {
				messageBody: record.body,
				error: err.message,
			});
			throw err;
		}
	}
};
