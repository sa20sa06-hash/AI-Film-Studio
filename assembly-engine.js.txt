/* Optional in-browser MP4 assembly using ffmpeg.wasm.
 * This uses only publicly hosted JavaScript/WASM assets; no account or paid service is used.
 * A first load downloads a large WASM core. Large files can exceed mobile browser memory limits.
 */
const FFMPEG_PACKAGE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.10/dist/esm/index.js';
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
let ffmpegInstance = null;
let ffmpegLoaded = false;
let loadingPromise = null;
let loadError = null;

async function toBlobURL(url, mimeType) {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return URL.createObjectURL(new Blob([await response.arrayBuffer()], { type: mimeType }));
}

async function load(onProgress = () => {}, onLog = () => {}) {
  if (ffmpegLoaded && ffmpegInstance) return ffmpegInstance;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    onProgress({ stage: 'downloading', percent: 1 });
    const { FFmpeg } = await import(FFMPEG_PACKAGE);
    const ffmpeg = new FFmpeg();
    ffmpeg.on('log', ({ message }) => onLog(String(message || '')));
    ffmpeg.on('progress', ({ progress, time }) => onProgress({ stage: 'processing', percent: Math.max(0, Math.min(99, Math.round((progress || 0) * 100))), time }));
    const coreURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript');
    const wasmURL = await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm');
    await ffmpeg.load({ coreURL, wasmURL });
    ffmpegInstance = ffmpeg;
    ffmpegLoaded = true;
    onProgress({ stage: 'ready', percent: 100 });
    return ffmpeg;
  })().catch(error => {
    loadError = error;
    throw error;
  }).finally(() => { loadingPromise = null; });
  return loadingPromise;
}

function safeExtension(name) {
  const ext = String(name || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
  return ['mp4','webm','mov','m4v','mkv','avi','mpeg','mpg','3gp','ts','mp3','wav','m4a','aac','ogg','opus','flac'].includes(ext) ? ext : 'mp4';
}

async function mergeVideos(items, options = {}, onProgress = () => {}, onLog = () => {}) {
  const ffmpeg = await load(onProgress, onLog);
  const videos = (items || []).filter(item => item?.file && (item.kind === 'video' || String(item.file.type || '').startsWith('video/')));
  if (videos.length < 2) throw new Error('Choose at least two video clips before merging.');
  if (videos.some(item => item.file.size > 350 * 1024 * 1024)) {
    throw new Error('At least one clip is larger than 350 MB. Try shorter or smaller clips on a phone.');
  }
  const totalBytes = videos.reduce((sum, item) => sum + item.file.size, 0);
  if (totalBytes > 600 * 1024 * 1024) {
    throw new Error('The selected clips total more than 600 MB. Process fewer clips at a time on a phone to reduce the risk of browser memory failure.');
  }
  // Clean up leftovers from a previous job within this page session.
  try { const existing = await ffmpeg.listDir('/'); for (const entry of existing) { if (entry.name.startsWith('studio_')) await ffmpeg.deleteFile(entry.name).catch(() => {}); } } catch {}

  const inputLines = [];
  for (let i = 0; i < videos.length; i++) {
    const item = videos[i];
    const ext = safeExtension(item.file.name || item.name);
    const name = `studio_input_${String(i + 1).padStart(3, '0')}.${ext}`;
    const bytes = new Uint8Array(await item.file.arrayBuffer());
    await ffmpeg.writeFile(name, bytes);
    inputLines.push(`file '${name}'`);
    onProgress({ stage: 'preparing', percent: Math.round(((i + 1) / videos.length) * 12), message: `Loaded ${i + 1}/${videos.length}` });
  }
  await ffmpeg.writeFile('studio_concat.txt', new TextEncoder().encode(inputLines.join('\n') + '\n'));
  const format = options.format === 'WebM' ? 'webm' : 'mp4';
  const outputName = `studio_output.${format}`;
  let code = 1;
  let firstFailure = '';
  onProgress({ stage: 'merging', percent: 15 });
  // Fast path: preserve source quality if all clips have compatible streams.
  try {
    code = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'studio_concat.txt', '-c', 'copy', ...(format === 'mp4' ? ['-movflags', '+faststart'] : []), outputName]);
  } catch (error) { firstFailure = error?.message || String(error); code = 1; }
  if (code !== 0) {
    await ffmpeg.deleteFile(outputName).catch(() => {});
    onProgress({ stage: 'normalizing', percent: 35 });
    // Compatibility path; normalized output can take substantially longer and use more RAM.
    const width = options.quality === '1080' ? 1920 : 1280;
    const height = options.quality === '1080' ? 1080 : 720;
    const videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=30`;
    let args;
    if (format === 'mp4') {
      args = ['-f','concat','-safe','0','-i','studio_concat.txt','-vf',videoFilter,'-c:v','libx264','-preset','ultrafast','-crf','24','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart',outputName];
    } else {
      args = ['-f','concat','-safe','0','-i','studio_concat.txt','-vf',videoFilter,'-c:v','libvpx-vp9','-deadline','realtime','-cpu-used','8','-crf','34','-b:v','0','-c:a','libopus','-b:a','96k',outputName];
    }
    try { code = await ffmpeg.exec(args); } catch (error) { throw new Error(`Could not merge these clips. Fast path: ${firstFailure || 'incompatible streams'}. Transcoding: ${error?.message || error}`); }
  }
  if (code !== 0) throw new Error('FFmpeg could not merge these clips. Try MP4 files from the same source, fewer clips, or smaller files.');
  let finalOutputName = outputName;
  if (options.audioFile) {
    onProgress({ stage: 'addingAudio', percent: 92 });
    if (options.audioFile.size > 350 * 1024 * 1024) throw new Error('The selected audio file is larger than 350 MB. Choose a shorter audio file.');
    const audioExt = safeExtension(options.audioFile.name || 'audio.mp3');
    const audioName = `studio_external_audio.${audioExt}`;
    const audioBytes = new Uint8Array(await options.audioFile.arrayBuffer());
    await ffmpeg.writeFile(audioName, audioBytes);
    const withAudio = `studio_output_with_audio.${format}`;
    const delayMs = Math.round(Math.max(0, Math.min(3600, Number(options.audioOffsetSeconds) || 0)) * 1000);
    const audioFilter = `[1:a]adelay=${delayMs}|${delayMs},apad[a]`;
    const audioArgs = ['-i', outputName, '-i', audioName, '-filter_complex', audioFilter, '-map', '0:v:0', '-map', '[a]', '-c:v', 'copy'];
    if (format === 'mp4') audioArgs.push('-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart');
    else audioArgs.push('-c:a', 'libopus', '-b:a', '128k');
    audioArgs.push('-shortest', withAudio);
    let audioCode = 1;
    try { audioCode = await ffmpeg.exec(audioArgs); } catch (error) { throw new Error(`Video merge completed, but the audio track could not be attached: ${error?.message || error}`); }
    if (audioCode !== 0) throw new Error('Video merge completed, but the selected audio could not be attached. Try MP3 or WAV and retry without the extra audio track if needed.');
    finalOutputName = withAudio;
  }
  const data = await ffmpeg.readFile(finalOutputName);
  if (!(data instanceof Uint8Array) || data.byteLength === 0) throw new Error('FFmpeg did not produce a usable output file.');
  const mime = format === 'webm' ? 'video/webm' : 'video/mp4';
  const blob = new Blob([data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength)], { type: mime });
  onProgress({ stage: 'complete', percent: 100 });
  return { blob, mime, filename: `ai-film-studio-export-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`, bytes: blob.size, count: videos.length, audioAttached: Boolean(options.audioFile) };
}

window.AssemblyEngineBridge = { load, mergeVideos, get loadError() { return loadError; } };
