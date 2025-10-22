import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import path from 'path';

export class YoutubeFileSyncStack extends cdk.Stack {
	constructor(scope: Construct, id: string, props?: cdk.StackProps) {
		super(scope, id, props);

		// create S3 bucket to store videos
		const videosBucket = new s3.Bucket(this, 'VideosBucket', {
			versioned: false,
			removalPolicy: cdk.RemovalPolicy.DESTROY,
			autoDeleteObjects: true,
			bucketName: 'youtube-file-sync-videos-bucket',
		});

		// create DynamoDB table to store state(of the videos synced)
		const stateTable = new dynamodb.Table(this, 'StateTable', {
			partitionKey: { name: 'videoId', type: dynamodb.AttributeType.STRING },
			removalPolicy: cdk.RemovalPolicy.DESTROY,
		});

		// create SQS queue for video processing
		const videoQueue = new Queue(this, 'VideoDownloadQueue', {
			visibilityTimeout: cdk.Duration.minutes(5),
		});

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

		// Video Downloader Lambda
		const youtubeDownloaderLambda = new NodejsFunction(
			this,
			'YoutubeDownloaderFunction',
			{
				runtime: lambda.Runtime.NODEJS_20_X,
				entry: path.join(__dirname, '../lambda/youtube-downloader.ts'),
				handler: 'handler',
				bundling: {
					minify: true,
					externalModules: [],
				},
				environment: {
					BUCKET_NAME: videosBucket.bucketName,
					TABLE_NAME: stateTable.tableName,
				},
				timeout: cdk.Duration.minutes(2),
			},
		);

		// grant necessary permissions to the Lambda functions
		videosBucket.grantPut(youtubeDownloaderLambda);
		stateTable.grantReadWriteData(youtubeDownloaderLambda);
		videoQueue.grantSendMessages(youtubeSearchLambda);
		videoQueue.grantConsumeMessages(youtubeDownloaderLambda);

		// Connect SQS queue to Downloader Lambda
		youtubeDownloaderLambda.addEventSource(
			new cdk.aws_lambda_event_sources.SqsEventSource(videoQueue),
		);

		// create EventBridge rule to trigger Lambda function every hour
		new events.Rule(this, 'ScheduleRule', {
			schedule: events.Schedule.rate(cdk.Duration.hours(1)),
			targets: [new targets.LambdaFunction(youtubeSearchLambda)],
		});
	}
}
