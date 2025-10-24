import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import path from 'path';

const YT_DLP_PATH = path.join(__dirname, 'bin', 'yt-dlp');
const TEST_VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const OUTPUT_PATH = path.join(__dirname, 'test-video.mp4');

async function downloadToLocal(videoUrl: string, outputPath: string) {
	console.log(`▶️ Starting download for ${videoUrl}`);

	const fileStream = createWriteStream(outputPath);

	// Use spawn for better streaming
	const child = spawn(YT_DLP_PATH, [
		'-f',
		'best',
		'--no-progress',
		'--newline',
		'-o',
		'-',
		videoUrl,
	]);

	child.stdout.pipe(fileStream);

	child.stderr.on('data', (data) => {
		console.log(`yt-dlp: ${data.toString().trim()}`);
	});

	return new Promise<void>((resolve, reject) => {
		child.on('exit', (code) => {
			if (code !== 0) {
				reject(new Error(`yt-dlp exited with code ${code}`));
			} else {
				fileStream.end(() => {
					console.log(`✅ Download completed: ${outputPath}`);
					resolve();
				});
			}
		});

		child.on('error', (err) => {
			console.error('❌ Error spawning yt-dlp:', err);
			reject(err);
		});

		fileStream.on('error', (err) => {
			console.error('❌ Error writing file:', err);
			child.kill();
			reject(err);
		});
	});
}

(async () => {
	try {
		await downloadToLocal(TEST_VIDEO_URL, OUTPUT_PATH);
		console.log('✅ Test complete. Check your file at:', OUTPUT_PATH);
	} catch (err) {
		console.error('❌ Error during test:', err);
	}
})();
