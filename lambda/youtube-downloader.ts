import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { SQSHandler, SQSEvent } from 'aws-lambda';
import { Upload } from '@aws-sdk/lib-storage';
import {
	CloudWatchClient,
	PutMetricDataCommand,
	StandardUnit,
} from '@aws-sdk/client-cloudwatch';

import { spawn } from 'child_process';
import * as fs from 'fs';
import { pipeline } from 'stream/promises';
import { validateEnv } from './utils/validate-env';

validateEnv([
	'BUCKET_NAME',
	'TABLE_NAME',
	'COOKIE_S3_KEY',
	'COOKIE_MAX_AGE_HOURS',
]);

// Configuration constants
const BUCKET_NAME = process.env.BUCKET_NAME!;
const TABLE_NAME = process.env.TABLE_NAME!;
const COOKIE_S3_KEY = process.env.COOKIE_S3_KEY!;
const COOKIE_MAX_AGE_HOURS = parseInt(process.env.COOKIE_MAX_AGE_HOURS!);
const COOKIE_LOCAL_PATH = '/tmp/cookies.txt';
const COOKIE_TMP_PATH = '/tmp/cookies.txt.tmp';

// Initialize AWS clients
const s3Client = new S3Client({});
const ddbClient = new DynamoDBClient({});
const ddbDocClient = DynamoDBDocumentClient.from(ddbClient);
const cloudwatch = new CloudWatchClient({});

async function recordMetric(
	name: string,
	value: number,
	unit: StandardUnit = StandardUnit.Count,
) {
	await cloudwatch.send(
		new PutMetricDataCommand({
			Namespace: 'YoutubeFileSync',
			MetricData: [{ MetricName: name, Unit: unit, Value: value }],
		}),
	);
}

function log(event: string, data: Record<string, any> = {}) {
	console.log(
		JSON.stringify({ event, timestamp: new Date().toISOString(), ...data }),
	);
}

// Ensures cookie file is present and up-to-date
async function ensureCookieFileIfConfigured(): Promise<void> {
	if (!COOKIE_S3_KEY || !BUCKET_NAME) {
		console.log('Cookie configuration not set, skipping cookie download.');
		return;
	}

	try {
		if (fs.existsSync(COOKIE_LOCAL_PATH)) {
			const stat = fs.statSync(COOKIE_LOCAL_PATH);
			const ageHours = (Date.now() - stat.mtimeMs) / (1000 * 60 * 60);

			if (ageHours < COOKIE_MAX_AGE_HOURS) {
				console.log(
					`Using existing fresh cookie file (${ageHours.toFixed(2)}h old)`,
				);
				return;
			}
		}

		// Download cookie file from S3
		const resp = await s3Client.send(
			new GetObjectCommand({
				Bucket: BUCKET_NAME,
				Key: COOKIE_S3_KEY,
			}),
		);

		// Stream cookie file to temporary location
		await pipeline(
			resp.Body as NodeJS.ReadableStream,
			fs.createWriteStream(COOKIE_TMP_PATH, { mode: 0o600 }),
		);

		fs.renameSync(COOKIE_TMP_PATH, COOKIE_LOCAL_PATH);
		fs.chmodSync(COOKIE_LOCAL_PATH, 0o600);
	} catch (err) {
		console.warn('Failed to download cookies:', err);
		if (fs.existsSync(COOKIE_TMP_PATH)) fs.unlinkSync(COOKIE_TMP_PATH);
	}
}

// Main download function with retry logic
export async function downloadToS3(
	videoUrl: string,
	s3Key: string,
): Promise<void> {
	const clientStrategies = ['ios', 'ios,web', 'web', 'android_creator'];

	for (const client of clientStrategies) {
		try {
			await attemptDownload(videoUrl, s3Key, client);
			return;
		} catch (err: any) {
			console.warn(`Download failed with ${client}: ${err.message}`);
			if (client === clientStrategies[clientStrategies.length - 1]) {
				throw err;
			}
		}
	}
}

// Single download attempt with specific player client
async function attemptDownload(
	videoUrl: string,
	s3Key: string,
	playerClient: string,
): Promise<void> {
	await ensureCookieFileIfConfigured();
	const tempFile = `/tmp/video_${Date.now()}.mp4`;

	try {
		// Configure yt-dlp arguments
		const args = [
			'-f',
			'worst[ext=mp4]/worstvideo+worstaudio/worst',
			'--no-progress',
			'--cache-dir',
			'/tmp/yt-dlp-cache',
			'--paths',
			'temp:/tmp',
			'--no-playlist',
			'--force-ipv4',
			'--extractor-args',
			`youtube:player_client=${playerClient}`,
			'--no-abort-on-error',
			'--merge-output-format',
			'mp4',
			'-o',
			tempFile,
		];

		if (fs.existsSync(COOKIE_LOCAL_PATH)) {
			args.push('--cookies', COOKIE_LOCAL_PATH);
		}

		args.push(videoUrl);

		// Download video using yt-dlp
		await new Promise<void>((resolve, reject) => {
			const child = spawn('yt-dlp', args, {
				stdio: ['ignore', 'pipe', 'pipe'],
				cwd: '/tmp',
			});

			child.stderr.on('data', (data) => {
				data
					.toString()
					.trim()
					.split('\n')
					.forEach((line: string) => console.log(`yt-dlp: ${line}`));
			});

			child.on('error', reject);
			child.on('close', (code) => {
				code === 0
					? resolve()
					: reject(new Error(`yt-dlp exited with code ${code}`));
			});
		});

		// Verify download and upload to S3
		const stats = fs.statSync(tempFile);
		if (stats.size === 0) throw new Error('Downloaded file is empty');

		const upload = new Upload({
			client: s3Client,
			params: {
				Bucket: BUCKET_NAME,
				Key: s3Key,
				Body: fs.createReadStream(tempFile),
				ContentType: 'video/mp4',
			},
		});

		await upload.done();
		console.log(
			`✅ [VIDEO DOWNLOAD SUCCESS] Video successfully downloaded and uploaded to S3:
				• S3 Key: ${s3Key}
				• Player Client: ${playerClient}
				• Temp File: ${tempFile}
				• File Size: ${(stats.size / (1024 * 1024)).toFixed(2)} MB
				• Timestamp: ${new Date().toISOString()}`,
		);
	} catch (err: any) {
		console.error(
			`❌ [VIDEO DOWNLOAD FAILED]
			• URL: ${videoUrl}
			• Player Client: ${playerClient}
			• S3 Key: ${s3Key}
			• Error: ${err.message}
			• Timestamp: ${new Date().toISOString()}`,
		);
		throw err;
	} finally {
		// Cleanup temporary file
		if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
	}
}

// Lambda handler for processing SQS messages
export const handler: SQSHandler = async (event: SQSEvent) => {
	log('BatchStart', { recordCount: event.Records.length });
	for (const record of event.Records) {
		let videoId: string = '';
		let title: string = '';

		try {
			const body = JSON.parse(record.body);
			if (!body || !body.videoId) {
				log('InvalidMessage', {
					recordId: record.messageId,
					body: record.body,
				});
				return;
			}
			({ videoId, title } = body);


			// Check if video already exists in DynamoDB
			const existing = await ddbDocClient.send(
				new GetCommand({ TableName: TABLE_NAME, Key: { videoId } }),
			);

			if (existing.Item) {
				console.log(`Skipping already downloaded video: ${videoId}`);
				continue;
			}

			// Process video download
			const start = Date.now();
			const safeTitle = title.replace(/[^a-z0-9 -]/gi, '_').substring(0, 100);
			const s3Key = `videos/${safeTitle}_${videoId}.mp4`;

			await downloadToS3(`https://www.youtube.com/watch?v=${videoId}`, s3Key);

			// Record successful download in DynamoDB
			await ddbDocClient.send(
				new PutCommand({
					TableName: TABLE_NAME,
					Item: {
						videoId,
						title,
						s3Key,
						s3Bucket: BUCKET_NAME,
						downloadedAt: new Date().toISOString(),
					},
					ConditionExpression: 'attribute_not_exists(videoId)',
				}),
			);
			const duration = (Date.now() - start) / 1000;

			await recordMetric('VideosDownloaded', 1);
			await recordMetric('DownloadDuration', duration, 'Seconds');
			log('DownloadSuccess', {
				videoId,
				duration,
				s3Key,
				bucket: BUCKET_NAME,
			});

		} catch (err: any) {
			await recordMetric('DownloadFailures', 1);
			log('DownloadError', {
				videoId: videoId || '(unknown)',
				recordId: record.messageId,
				body: record.body,
				error: err.message,
				stack: err.stack,
			});

		}
	}
	log('BatchComplete');
};
