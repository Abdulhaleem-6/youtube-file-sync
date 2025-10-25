import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import path from 'path';

export class YoutubeFileSyncStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// Configuration constants
		const COOKIE_S3_KEY = 'secrets/cookies.txt';
		const COOKIE_MAX_AGE_HOURS = '168'; // 7 days in hours

		// S3 bucket for storing downloaded videos
		const videosBucket = new s3.Bucket(this, 'VideosBucket', {
			versioned: false,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			bucketName: 'youtube-file-sync-videos-bucket',
			lifecycleRules: [
				{
					expiration: cdk.Duration.days(1),
				},
			],
		});

		// DynamoDB table for tracking synced videos
		const stateTable = new dynamodb.Table(this, 'StateTable', {
			partitionKey: { name: 'videoId', type: dynamodb.AttributeType.STRING },
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		// Queue for handling video download requests
		const dlq = new Queue(this, 'VideoDownloadDLQ', {
			retentionPeriod: cdk.Duration.days(14),
		});
		const videoQueue = new Queue(this, 'VideoDownloadQueue', {
			visibilityTimeout: cdk.Duration.minutes(20),
			deadLetterQueue: {
				maxReceiveCount: 3,
				queue: dlq,
			},
		});

		// Lambda function for searching YouTube videos
		const youtubeSearchLambda = new NodejsFunction(
			this,
			'YoutubeSearchFunction',
			{
				runtime: lambda.Runtime.NODEJS_20_X,
				entry: path.join(__dirname, '../lambda/youtube-search.ts'),
				handler: 'handler',
				bundling: {
					minify: true,
					externalModules: [],
				},
				environment: {
					QUEUE_URL: videoQueue.queueUrl,
					YOUTUBE_API_KEY: process.env.YOUTUBE_API_KEY ?? '',
					SEARCH_QUERY: process.env.SEARCH_QUERY ?? 'AWS CDK',
				},
				timeout: cdk.Duration.seconds(30),
			},
		);

		// Lambda function for downloading YouTube videos (using Docker)
		const youtubeDownloaderLambda = new lambda.DockerImageFunction(
			this,
			'YoutubeDownloaderFunction',
			{
				code: lambda.DockerImageCode.fromImageAsset(
					path.join(__dirname, '..'),
					{
						file: 'Dockerfile',
					},
				),
				architecture: lambda.Architecture.ARM_64,
				timeout: cdk.Duration.minutes(10),
				memorySize: 3008,
				environment: {
					BUCKET_NAME: videosBucket.bucketName,
					TABLE_NAME: stateTable.tableName,
					COOKIE_S3_KEY,
					COOKIE_MAX_AGE_HOURS,
				},
			},
		);

		// Set up IAM permissions
		videosBucket.grantPut(youtubeDownloaderLambda);
		stateTable.grantReadWriteData(youtubeDownloaderLambda);
		videoQueue.grantSendMessages(youtubeSearchLambda);
		videoQueue.grantConsumeMessages(youtubeDownloaderLambda);
		youtubeDownloaderLambda.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ['cloudwatch:PutMetricData'],
				resources: ['*'],
			}),
		);

		// Grant access to cookie file in S3
		const cookieObjectArn = videosBucket.arnForObjects(COOKIE_S3_KEY);
		youtubeDownloaderLambda.addToRolePolicy(
			new iam.PolicyStatement({
				actions: ['s3:GetObject', 's3:GetObjectVersion'],
				resources: [cookieObjectArn],
			}),
		);

		// Connect SQS queue to Downloader Lambda
		youtubeDownloaderLambda.addEventSource(
			new cdk.aws_lambda_event_sources.SqsEventSource(videoQueue),
		);

		// Schedule YouTube search to run hourly
		new events.Rule(this, 'ScheduleRule', {
			schedule: events.Schedule.rate(cdk.Duration.hours(1)),
			targets: [new targets.LambdaFunction(youtubeSearchLambda)],
		});
	}
}
