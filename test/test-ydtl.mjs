import fs from 'fs';
import ytdl from '@distube/ytdl-core';

const videoUrl = 'https://www.youtube.com/watch?v=Uf5Gk7cFhI8';

console.log('Downloading with both audio and video...');

const stream = ytdl(videoUrl, {
	filter: (format) => format.hasVideo && format.hasAudio,
	quality: 'highest',
});

stream.pipe(fs.createWriteStream('test.mp4'));

stream.on('info', (info) => {
	console.log('Downloading:', info.videoDetails.title);
});

stream.on('end', () => {
	console.log('✅ Download complete: test.mp4');
});
