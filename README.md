# Serverless YouTube File Sync

This is a high-performance, serverless application built on AWS that automates downloading YouTube videos. It runs on an hourly schedule, finds new videos based on a defined search query, saves them to S3, and tracks downloaded videos in DynamoDB to prevent duplicates.

The entire infrastructure is defined with the AWS CDK and deployed as a custom `arm64` Docker container, providing cost-effective and powerful execution.

## Solution Architecture

The application uses a decoupled, event-driven architecture:

1.  **Schedule:** An **Amazon EventBridge Rule** triggers the process hourly.
2.  **Search:** The rule invokes the `Youtube` Lambda. This function queries the YouTube v3 API and enqueues new video IDs into an SQS queue.
3.  **Queue:** An **Amazon SQS Queue** receives the download jobs, decoupling the search logic from the heavy-lifting download process.
4.  **Download:** The SQS queue triggers the `youtube-downloader` Lambda. This function runs on a custom **`arm64` Docker image** containing static builds of `ffmpeg` and `yt-dlp`.
5.  **Process:**
    - The downloader first checks **DynamoDB** to see if the video has already been processed.
    - It fetches a `cookies.txt` file from S3, caching it in `/tmp` to avoid re-downloads.
    - Uses yt-dlp with multiple player_client strategies (web, ios, etc.) for resilient downloads.
    - The video is saved to the Lambda's `/tmp` filesystem.
6.  **Store:** Once the download is complete, the file is streamed from `/tmp` to an **S3 Bucket**.
7.  **Track:** A new item is written to the **DynamoDB table** to mark the video as complete.

## Key Features

- **High-Performance `arm64` Runtime:** Runs on AWS Graviton processors (`arm64`) for better performance and lower cost.
- **Custom Docker Runtime:** Uses a custom `Dockerfile` with a `nodejs:20-arm64` base, with static `ffmpeg` and `yt-dlp` binaries built-in for maximum reliability.
- **Robust Download Logic:** Automatically retries downloads using different `player_client` strategies (`ios`, `web`, etc.) to handle YouTube's varying client-side restrictions.
- **Cookie Management:** Securely fetches a `cookies.txt` file from S3, enabling downloads of private or members-only content.
- **Intelligent Caching:** Cookies are cached in the Lambda's `/tmp` directory with a TTL (`COOKIE_MAX_AGE_HOURS`) to minimize S3 `GetObject` calls.
- **Stateful Processing:** A DynamoDB table tracks all downloaded `videoId`s, making the entire process idempotent and preventing duplicate work.
- **Fully Decoupled:** SQS isolates the search and download logic, allowing failures and retries without data loss.
- **Infrastructure as Code:** The entire stack (Lambdas, S3, DynamoDB, SQS, IAM Roles) is defined in a single AWS CDK file.

## Tech Stack

- **Infrastructure as Code:** AWS CDK v2 (TypeScript)
- **Cloud Services:**
  - AWS Lambda
  - Amazon S3 (for video storage and cookie hosting)
  - Amazon DynamoDB (for state management)
  - Amazon SQS (for job queueing)
  - Amazon EventBridge (for scheduling)
  - AWS IAM
  - AWS SSM Parameter Store (for proxy config)
- **Lambda Runtimes:**
  - `Youtube`: Node.js 20.x
  - `youtube-downloader`: Custom Docker (`public.ecr.aws/lambda/nodejs:20-arm64`)
- **Key Binaries (in Docker):** `Python 3.11`, `yt-dlp` (static), `ffmpeg` (static)
- **Key NPM Packages:** `aws-cdk-lib`, `@aws-sdk/v3`, `googleapis`, `esbuild`

## Project Structure

```
.
├── bin/
│   └── youtube-file-sync.ts      # CDK App entry point
├── lambda/
│   ├── youtube-search.ts          # Lambda: Finds new videos and enqueues jobs
│   └── youtube-downloader.ts      # Lambda: Downloads and uploads videos
├── lib/
│   └── youtube-file-sync-stack.ts  # Main CDK stack definition
├── test/                          # Jest tests
├── .dockerignore
├── .gitignore
├── cdk.json                       # CDK project configuration
├── Dockerfile                     # Builds the 'downloader' Lambda image
├── jest.config.js
├── package.json
└── tsconfig.json
```

## Setup and Deployment

### 1. AWS Pre-Deployment Steps

Before deploying, you may need to set up the following resources in your AWS account.

1.  **Upload Cookie File:**

    - Go to the **Amazon S3** console.
    - Create the bucket `youtube-file-sync-videos-bucket`. (The stack will adopt this, or you can let the stack create it first and then upload).
    - Upload your `cookies.txt` file to the following path:
      `s3://youtube-file-sync-videos-bucket/secrets/cookies.txt`

2.  **(Optional) Set up Proxy:**
    - Go to **AWS Systems Manager (SSM) Parameter Store**.
    - Create a parameter with the name `/youtube-sync/proxy-list`.
    - Set the type to `StringList` and add your proxy URLs.

### 2. Deployment Steps

1.  **Clone & Install:**

    ```sh
    git clone https://github.com/Abdulhaleem-6/youtube-file-sync.git
    cd youtube-file-sync
    npm install
    ```

2.  **Set Deploy-Time Variables:**
    Your stack reads environment variables on deployment for the `Youtube` Lambda. Create a `.env` file or export them in your shell:

    ```ini
    # .env
    SEARCH_QUERY="your search query"
    YOUTUBE_API_KEY="your-api-key-here"
    ```

3.  **Bootstrap CDK:**
    You must bootstrap your AWS environment to support `arm64` Docker builds.

    ```sh
    # Replace with your AWS Account ID and Region
    cdk bootstrap aws://<ACCOUNT-ID>/<REGION>
    ```

4.  **Deploy:**
    ```sh
    cdk deploy
    ```

The CDK will now build your TypeScript, create the Docker image, push it to your private ECR, and deploy all the AWS resources.

### Example End-to-End Flow

1. **EventBridge** triggers the `youtube-search` Lambda hourly.
2. The Lambda queries YouTube and sends new video IDs to **SQS**.
3. The SQS queue invokes the `youtube-downloader`.
4. The downloader fetches cookies, downloads the video, uploads it to **S3**, and logs it in **DynamoDB**.
