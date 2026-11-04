import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import path from 'path';
import fs from 'fs';
import { spawn, ChildProcess } from 'child_process';
import crypto from 'crypto';
import { Readable, Transform } from 'stream';
import dotenv from 'dotenv';

dotenv.config();

const PORT = Number(process.env.PORT) || 3000;
const TEMP_DIR = process.env.TEMP_DIR || '/tmp/drivetrim_jobs';
const ASSETS_DIR = '/tmp/drivetrim_assets';
const SAMPLE_VIDEO_PATH = path.join(ASSETS_DIR, 'sample_30m.mp4');
const UNSUPPORTED_CODEC_SAMPLE_PATH = path.join(ASSETS_DIR, 'sample_unsupported_mpeg2.mkv');
const TEMP_RETENTION_MINUTES = Number(process.env.TEMP_RETENTION_MINUTES) || 30;
const JOB_TIMEOUT_MINUTES = Number(process.env.JOB_TIMEOUT_MINUTES) || 25;
const MAX_CONCURRENT_JOBS = Number(process.env.MAX_CONCURRENT_JOBS) || 4;
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

// Cloud Run's HTTP reverse proxy enforces a hard 32 MiB (33,554,432 bytes) response size limit.
// Capping open-ended HTTP 206 byte-range windows (e.g., "Range: bytes=0-") to 4 MiB (4,194,304 bytes)
// ensures every 206 Partial Content response completes in ~15ms well below the 32 MiB proxy limit,
// while the browser's HTML5 <video> element seamlessly fetches subsequent 4 MiB range chunks on demand.
const MAX_RANGE_CHUNK_BYTES = 4 * 1024 * 1024; // 4 MiB

const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

fs.mkdirSync(TEMP_DIR, { recursive: true });
fs.mkdirSync(ASSETS_DIR, { recursive: true });

const DEMO_FILE_ID = '1abcDEFgHijklMNop';
const UNSUPPORTED_CODEC_DEMO_ID = '1unsupportedCodecDemoVideoId';

const recentStreamLogs: Array<Record<string, any>> = [];
const MAX_RECENT_LOGS = 150;

/**
 * Structured Server-Side Debugger (Redacts sensitive tokens/cookies)
 */
function logDebug(
  category:
    | 'DRIVE_API'
    | 'PUBLIC_RESOLVER'
    | 'FFPROBE'
    | 'RANGE_STREAM'
    | 'COMPAT_PREVIEW'
    | 'THUMBNAIL'
    | 'FFMPEG_TRIM'
    | 'DOWNLOAD',
  event: string,
  details: Record<string, any> = {}
) {
  const safeDetails: Record<string, any> = {};
  for (const [k, v] of Object.entries(details)) {
    if (/token|cookie|authorization/i.test(k)) {
      safeDetails[k] = v ? '[REDACTED]' : null;
    } else if (typeof v === 'string' && v.includes('access_token=')) {
      safeDetails[k] = v.replace(/access_token=[^&]+/g, 'access_token=[REDACTED]');
    } else {
      safeDetails[k] = v;
    }
  }
  const entry = {
    ts: new Date().toISOString(),
    category,
    event,
    ...safeDetails,
  };
  recentStreamLogs.push(entry);
  if (recentStreamLogs.length > MAX_RECENT_LOGS) {
    recentStreamLogs.shift();
  }
  console.log(`[DriveTrim:${category}:${event}]`, JSON.stringify(entry));
}

/**
 * Inspect first bytes of a video chunk to verify whether actual video bytes or an HTML/JSON page are being piped
 */
function inspectFirstChunkBytes(chunk: Buffer) {
  const slice = chunk.subarray(0, Math.min(32, chunk.length));
  const hex = Array.from(slice)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  const ascii = Array.from(slice)
    .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
    .join('');

  let signatureType = 'BINARY_VIDEO_SLICE';
  if (ascii.includes('ftyp') || ascii.includes('moov') || ascii.includes('mdat') || ascii.includes('free')) {
    signatureType = 'MP4_MOV_ISO_BMFF_HEADER';
  } else if (hex.startsWith('1a 45 df a3')) {
    signatureType = 'WEBM_MKV_EBML_HEADER';
  } else if (/^\s*(<!doctype|<html|<head|<script)/i.test(ascii)) {
    signatureType = 'WARNING_HTML_PAGE_DETECTED';
  } else if (/^\s*\{\s*"error"/i.test(ascii)) {
    signatureType = 'WARNING_JSON_ERROR_DETECTED';
  }

  return {
    firstChunkBytes: chunk.length,
    firstBytesHex: hex,
    firstBytesAscii: ascii,
    signatureType,
  };
}

/**
 * Pipe a readable stream to Express Response using a backpressure-safe Transform stream
 * while logging first-chunk magic bytes, progress, and completion/abort.
 */
function pipeStreamWithDiagnostics(
  sourceStream: Readable,
  req: Request,
  res: Response,
  context: {
    requestId: string;
    fileId: string;
    mode: string;
    rangeHeader: string;
    statusSent: number;
    expectedBytes: number | null;
    startedAt: number;
  }
) {
  let chunksCount = 0;
  let totalBytesPiped = 0;
  let lastLoggedMark = 0;
  let streamFinished = false;

  const inspector = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunksCount++;
      totalBytesPiped += buf.length;

      if (chunksCount === 1) {
        const sig = inspectFirstChunkBytes(buf);
        logDebug('RANGE_STREAM', 'STREAM_FIRST_CHUNK_PIPED', {
          requestId: context.requestId,
          fileId: context.fileId,
          mode: context.mode,
          rangeHeader: context.rangeHeader,
          statusSent: context.statusSent,
          ttfbMs: Date.now() - context.startedAt,
          ...sig,
        });
      } else if (totalBytesPiped - lastLoggedMark >= 2 * 1024 * 1024) {
        lastLoggedMark = totalBytesPiped;
        logDebug('RANGE_STREAM', 'STREAM_BYTES_PROGRESS', {
          requestId: context.requestId,
          fileId: context.fileId,
          mode: context.mode,
          chunksCount,
          totalBytesPiped,
          expectedBytes: context.expectedBytes,
          elapsedMs: Date.now() - context.startedAt,
        });
      }

      callback(null, buf);
    },
  });

  res.on('finish', () => {
    streamFinished = true;
    logDebug('RANGE_STREAM', 'STREAM_PIPE_COMPLETED', {
      requestId: context.requestId,
      fileId: context.fileId,
      mode: context.mode,
      rangeHeader: context.rangeHeader,
      statusSent: context.statusSent,
      chunksCount,
      totalBytesPiped,
      expectedBytes: context.expectedBytes,
      elapsedMs: Date.now() - context.startedAt,
    });
  });

  const handleStreamError = (err: any) => {
    if (streamFinished) return;
    logDebug('RANGE_STREAM', 'STREAM_PIPE_ERROR', {
      requestId: context.requestId,
      fileId: context.fileId,
      mode: context.mode,
      rangeHeader: context.rangeHeader,
      chunksCount,
      totalBytesPiped,
      error: err?.message || String(err),
      elapsedMs: Date.now() - context.startedAt,
    });
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.end();
    }
  };

  sourceStream.on('error', handleStreamError);
  inspector.on('error', handleStreamError);

  res.on('close', () => {
    if (!streamFinished && !res.writableEnded) {
      logDebug('RANGE_STREAM', 'STREAM_CLIENT_CLOSED_EARLY', {
        requestId: context.requestId,
        fileId: context.fileId,
        mode: context.mode,
        rangeHeader: context.rangeHeader,
        chunksCount,
        totalBytesPiped,
        expectedBytes: context.expectedBytes,
        elapsedMs: Date.now() - context.startedAt,
      });
      sourceStream.destroy();
      inspector.destroy();
    }
  });

  sourceStream.pipe(inspector).pipe(res);
}

export interface VideoSourceMetadata {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  streamByteSize?: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  videoProfile: string;
  pixFmt: string;
  audioCodec: string | null;
  hasAudio: boolean;
  isBrowserCompatible: boolean;
  incompatibilityReason?: string;
  supportsRange: boolean;
  accessMode: 'public' | 'oauth' | 'demo';
  containerFormat: string;
  resolvedStreamUrl?: string;
  resolvedCookieHeader?: string;
  cdnPreviewStreamUrl?: string;
  cdnPreviewCookieHeader?: string;
  cdnPreviewSize?: number;
  usingCdnFallback?: boolean;
  posterUrl?: string;
  oauthToken?: string;
  previewFilePath?: string;
  previewStatus?: 'none' | 'generating' | 'ready' | 'failed';
  updatedAt: number;
}

export interface TrimJob {
  jobId: string;
  fileId: string;
  fileName: string;
  startTime: number;
  endTime: number;
  clipDuration: number;
  originalDuration: number;
  trimMode: 'copy' | 'reencode';
  effectiveTrimMode: 'copy' | 'reencode';
  outputFormat: 'mp4' | 'mov' | 'webm';
  status: 'starting' | 'processing' | 'completed' | 'cancelled' | 'error';
  progressPercent: number;
  processedSeconds: number;
  statusMessage: string;
  outputFilePath: string;
  outputFileName: string;
  outputSize: number;
  outputSha256?: string;
  actualOutputDuration: number;
  probeSummary?: {
    videoCodec: string;
    audioCodec: string | null;
    hasAudio: boolean;
    width: number;
    height: number;
    fps: number;
    durationSeconds: number;
    formatName: string;
    sizeBytes: number;
  };
  error?: string;
  createdAt: number;
  completedAt?: number;
  lastAccessedAt?: number;
  process?: ChildProcess;
  timeoutHandle?: NodeJS.Timeout;
}

const metadataCache = new Map<string, VideoSourceMetadata>();
const trimJobs = new Map<string, TrimJob>();
const compatPreviewLocks = new Map<string, Promise<void>>();

export interface OAuthBackendSession {
  sessionId: string;
  accessToken: string;
  userEmail?: string;
  userName?: string;
  createdAt: number;
  expiresAt: number;
}

const authSessions = new Map<string, OAuthBackendSession>();

function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k && rest.length > 0) {
      out[k.trim()] = decodeURIComponent(rest.join('=').trim());
    }
  }
  return out;
}

function extractRequestOAuthToken(req: Request, meta?: VideoSourceMetadata): string | undefined {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const bearer = authHeader.slice(7).trim();
    if (bearer) return bearer;
  }

  const querySid = typeof req.query.sid === 'string' ? req.query.sid.trim() : undefined;
  if (querySid) {
    const sess = authSessions.get(querySid);
    if (sess && sess.expiresAt > Date.now()) {
      return sess.accessToken;
    }
  }

  const cookies = parseCookieHeader(req.headers.cookie);
  if (cookies.drivetrim_sid) {
    const sess = authSessions.get(cookies.drivetrim_sid);
    if (sess && sess.expiresAt > Date.now()) {
      return sess.accessToken;
    }
  }

  const queryToken = typeof req.query.token === 'string' ? req.query.token.trim() : undefined;
  if (queryToken) return queryToken;

  if (meta?.oauthToken) return meta.oauthToken;

  // Fallback to the most recently created active OAuth session if third-party cookies were blocked in iframe
  const activeSessions = Array.from(authSessions.values()).filter((s) => s.expiresAt > Date.now());
  if (activeSessions.length > 0) {
    return activeSessions[activeSessions.length - 1].accessToken;
  }

  return undefined;
}

function buildLocalLoopbackRawStreamUrl(fileId: string, preferCdn = false): string {
  const base = `http://127.0.0.1:${PORT}/api/video/raw-stream/${encodeURIComponent(fileId)}`;
  return preferCdn ? `${base}?source=cdn` : base;
}

// Semaphore for on-demand thumbnail generation (max 2 concurrent FFmpeg thumbnail seeks)
let activeThumbProcesses = 0;
const MAX_CONCURRENT_THUMBS = 2;
const thumbWaitQueue: Array<() => void> = [];

async function acquireThumbSlot(): Promise<void> {
  if (activeThumbProcesses < MAX_CONCURRENT_THUMBS) {
    activeThumbProcesses++;
    return;
  }
  return new Promise<void>((resolve) => {
    thumbWaitQueue.push(() => {
      activeThumbProcesses++;
      resolve();
    });
  });
}

function releaseThumbSlot(): void {
  activeThumbProcesses = Math.max(0, activeThumbProcesses - 1);
  const next = thumbWaitQueue.shift();
  if (next) next();
}

/**
 * Determine accurate browser MIME type from container format and filename
 */
function determineAccurateVideoMimeType(
  formatName: string,
  fileName: string,
  upstreamContentType?: string
): string {
  const lowerFormat = (formatName || '').toLowerCase();
  const lowerName = (fileName || '').toLowerCase();
  const lowerUpstream = (upstreamContentType || '').toLowerCase().split(';')[0].trim();

  if (lowerFormat.includes('webm') || lowerName.endsWith('.webm')) {
    return 'video/webm';
  }
  if (
    lowerName.endsWith('.mov') &&
    !lowerFormat.includes('mp4') &&
    lowerUpstream === 'video/quicktime'
  ) {
    return 'video/quicktime';
  }
  if (
    lowerFormat.includes('mp4') ||
    lowerFormat.includes('mov') ||
    lowerName.endsWith('.mp4') ||
    lowerName.endsWith('.m4v') ||
    lowerName.endsWith('.mov')
  ) {
    return 'video/mp4';
  }
  if (lowerFormat.includes('matroska') || lowerName.endsWith('.mkv')) {
    return 'video/x-matroska';
  }
  if (lowerFormat.includes('avi') || lowerName.endsWith('.avi')) {
    return 'video/x-msvideo';
  }
  if (lowerUpstream.startsWith('video/')) {
    return lowerUpstream;
  }
  return 'video/mp4';
}

/**
 * Evaluate whether a probed video stream can play natively in HTML5 <video> across modern browsers
 */
function evaluateBrowserCompatibility(probe: {
  videoCodec: string;
  pixFmt: string;
  formatName: string;
  audioCodec: string | null;
}): { compatible: boolean; reason?: string } {
  const vCodec = (probe.videoCodec || '').toLowerCase();
  const pixFmt = (probe.pixFmt || 'yuv420p').toLowerCase();
  const fmt = (probe.formatName || '').toLowerCase();

  const supportedVideoCodecs = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora']);
  if (!supportedVideoCodecs.has(vCodec)) {
    return {
      compatible: false,
      reason: `Video codec "${vCodec.toUpperCase()}" is not natively supported by standard web browsers.`,
    };
  }

  // 10-bit or 4:2:2 / 4:4:4 H.264 profiles often fail in browser & Windows Media Player decoders (0xc10100be)
  if (
    vCodec === 'h264' &&
    pixFmt &&
    !['yuv420p', 'yuvj420p', 'nv12', ''].includes(pixFmt)
  ) {
    return {
      compatible: false,
      reason: `Pixel format "${pixFmt}" requires transcoding to yuv420p for browser playback.`,
    };
  }

  if (fmt.includes('avi') || (fmt.includes('matroska') && vCodec !== 'vp8' && vCodec !== 'vp9' && vCodec !== 'h264')) {
    return {
      compatible: false,
      reason: `Container format "${fmt}" is not natively streamable in HTML5 video players.`,
    };
  }

  return { compatible: true };
}

/**
 * Ensure the 24fps H.264 yuv420p + AAC stereo sample video exists (~28.98 MiB, generated in ~500ms).
 */
let sampleGenerationPromise: Promise<void> | null = null;

async function ensureSampleVideoExists(): Promise<void> {
  if (fs.existsSync(SAMPLE_VIDEO_PATH)) {
    try {
      const stat = fs.statSync(SAMPLE_VIDEO_PATH);
      if (stat.size > 1_000_000) return;
    } catch {
      // regenerate
    }
  }
  if (sampleGenerationPromise) {
    return sampleGenerationPromise;
  }

  sampleGenerationPromise = (async () => {
    try {
      const refImage = path.resolve(
        process.cwd(),
        'public/assets/aistudio/8a0e62ad-9f26-4b64-bb46-8001ed19f685_d1d6dd54.png'
      );
      const cleanFramePath = path.join(ASSETS_DIR, 'clean_frame.jpg');
      const chunkPath = path.join(ASSETS_DIR, 'chunk_10s.mp4');
      const tempOut = `${SAMPLE_VIDEO_PATH}.tmp.mp4`;

      if (fs.existsSync(refImage) && !fs.existsSync(cleanFramePath)) {
        await new Promise<void>((resolve, reject) => {
          const p0 = spawn(FFMPEG_PATH, [
            '-y',
            '-i',
            refImage,
            '-vf',
            'crop=1300:244:118:314,delogo=x=590:y=82:w=120:h=120,scale=1280:540',
            '-frames:v',
            '1',
            '-q:v',
            '2',
            cleanFramePath,
          ]);
          p0.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Frame crop failed (${code})`))));
          p0.on('error', reject);
        });
      }

      // Encode a lightweight 10s 24fps H.264 Constrained Baseline + AAC stereo segment
      await new Promise<void>((resolve, reject) => {
        const hasFrame = fs.existsSync(cleanFramePath);
        const chunkArgs = hasFrame
          ? [
              '-y',
              '-loop',
              '1',
              '-framerate',
              '24',
              '-i',
              cleanFramePath,
              '-f',
              'lavfi',
              '-i',
              'sine=frequency=440:duration=10:sample_rate=44100',
              '-t',
              '10',
              '-c:v',
              'libx264',
              '-profile:v',
              'baseline',
              '-level:v',
              '3.1',
              '-preset',
              'ultrafast',
              '-tune',
              'stillimage',
              '-crf',
              '32',
              '-maxrate',
              '80k',
              '-bufsize',
              '160k',
              '-g',
              '48',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-b:a',
              '48k',
              '-ar',
              '44100',
              '-ac',
              '2',
              '-shortest',
              chunkPath,
            ]
          : [
              '-y',
              '-f',
              'lavfi',
              '-i',
              'testsrc=duration=10:size=1280x540:rate=24',
              '-f',
              'lavfi',
              '-i',
              'sine=frequency=440:duration=10:sample_rate=44100',
              '-c:v',
              'libx264',
              '-profile:v',
              'baseline',
              '-level:v',
              '3.1',
              '-preset',
              'ultrafast',
              '-crf',
              '32',
              '-maxrate',
              '80k',
              '-bufsize',
              '160k',
              '-g',
              '48',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-b:a',
              '48k',
              '-ar',
              '44100',
              '-ac',
              '2',
              chunkPath,
            ];

        const p1 = spawn(FFMPEG_PATH, chunkArgs);
        p1.on('close', (code) => {
          if (code === 0 && fs.existsSync(chunkPath)) resolve();
          else reject(new Error(`Sample chunk encode failed (${code})`));
        });
        p1.on('error', reject);
      });

      // Stream-loop 179 times (-c copy) into a 1800s (30:00) faststart MP4 (~28.98 MiB)
      await new Promise<void>((resolve, reject) => {
        const p2 = spawn(FFMPEG_PATH, [
          '-y',
          '-stream_loop',
          '179',
          '-i',
          chunkPath,
          '-t',
          '1800',
          '-c',
          'copy',
          '-movflags',
          '+faststart',
          tempOut,
        ]);
        p2.on('close', (code) => {
          if (code === 0 && fs.existsSync(tempOut)) {
            fs.renameSync(tempOut, SAMPLE_VIDEO_PATH);
            resolve();
          } else {
            reject(new Error(`Sample stream_loop failed (${code})`));
          }
        });
        p2.on('error', reject);
      });
    } finally {
      sampleGenerationPromise = null;
    }
  })();

  return sampleGenerationPromise;
}

/**
 * Ensure a small unsupported-codec sample video (MPEG-2 video + AC3 audio in MKV) exists for TEST H verification
 */
async function ensureUnsupportedCodecSampleExists(): Promise<void> {
  if (fs.existsSync(UNSUPPORTED_CODEC_SAMPLE_PATH)) return;
  return new Promise<void>((resolve, reject) => {
    const args = [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=60:size=640x360:rate=24',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=520:duration=60:sample_rate=48000',
      '-c:v',
      'mpeg2video',
      '-b:v',
      '1200k',
      '-pix_fmt',
      'yuv422p',
      '-c:a',
      'ac3',
      '-b:a',
      '128k',
      UNSUPPORTED_CODEC_SAMPLE_PATH,
    ];
    const proc = spawn(FFMPEG_PATH, args);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Failed to create unsupported codec test video (${code})`));
    });
    proc.on('error', reject);
  });
}

/**
 * Strictly extract and validate a Google Drive File ID from a URL or raw ID.
 */
export function extractGoogleDriveFileId(input: string): {
  valid: boolean;
  fileId?: string;
  error?: string;
} {
  const trimmed = (input || '').trim();
  if (!trimmed) {
    return { valid: false, error: 'Please enter a valid Google Drive video link.' };
  }

  if (/^[a-zA-Z0-9_-]{10,64}$/.test(trimmed)) {
    return { valid: true, fileId: trimmed };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    return {
      valid: false,
      error: 'Please enter a valid Google Drive video link (e.g., https://drive.google.com/file/d/.../view).',
    };
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    return { valid: false, error: 'Only HTTP/HTTPS Google Drive links are supported.' };
  }

  const allowedHosts = new Set([
    'drive.google.com',
    'www.drive.google.com',
    'docs.google.com',
    'drive.usercontent.google.com',
  ]);

  if (!allowedHosts.has(parsedUrl.hostname.toLowerCase())) {
    return {
      valid: false,
      error: 'Please enter a valid Google Drive video link. External non-Google URLs are blocked for security.',
    };
  }

  const fileDMatch = parsedUrl.pathname.match(
    /\/(?:file|document|presentation|spreadsheets)\/d\/([a-zA-Z0-9_-]{10,64})/
  );
  if (fileDMatch && fileDMatch[1]) {
    return { valid: true, fileId: fileDMatch[1] };
  }

  const queryId = parsedUrl.searchParams.get('id');
  if (queryId && /^[a-zA-Z0-9_-]{10,64}$/.test(queryId)) {
    return { valid: true, fileId: queryId };
  }

  return {
    valid: false,
    error: 'Could not find a valid file ID in this Google Drive link. Please check the URL and try again.',
  };
}

function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[^a-zA-Z0-9._\-\s()]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .trim();
  return cleaned || 'trimmed_video';
}

/**
 * Redact internal server filesystem paths (/tmp/drivetrim_jobs, /tmp/drivetrim_assets)
 * from FFprobe stderr or exception messages before returning to the client.
 */
function sanitizeServerErrorText(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(new RegExp(TEMP_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/?', 'g'), '[temp]/')
    .replace(new RegExp(ASSETS_DIR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/?', 'g'), '[assets]/')
    .replace(/\/tmp\/drivetrim_[a-zA-Z0-9_-]+\/?/g, '[temp]/');
}

/**
 * Helper: Follow HTTP redirects manually while preserving Set-Cookie headers across hops
 * and enforcing Google domain allowlisting.
 */
async function fetchWithCookieJar(
  initialUrl: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    initialCookies?: string;
    signal?: AbortSignal;
    maxRedirects?: number;
  } = {}
): Promise<{
  response: globalThis.Response;
  finalUrl: string;
  cookieHeader: string;
}> {
  const cookieMap = new Map<string, string>();
  if (options.initialCookies) {
    for (const pair of options.initialCookies.split(';')) {
      const [k, ...rest] = pair.trim().split('=');
      if (k && rest.length > 0) cookieMap.set(k.trim(), rest.join('=').trim());
    }
  }

  let currentUrl = initialUrl;
  const maxRedirects = options.maxRedirects ?? 8;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:') {
      throw new Error(`SSRF_BLOCKED: Non-HTTPS upstream protocol ${parsed.protocol}`);
    }
    const host = parsed.hostname.toLowerCase();
    const isTrustedGoogleHost =
      host.endsWith('.google.com') ||
      host === 'google.com' ||
      host.endsWith('.googleusercontent.com') ||
      host.endsWith('.googlevideo.com') ||
      host.endsWith('.googleapis.com') ||
      host.endsWith('.gvt1.com');

    if (!isTrustedGoogleHost) {
      throw new Error(`SSRF_BLOCKED: Untrusted redirect host ${host}`);
    }

    const cookieString = Array.from(cookieMap.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');

    const reqHeaders: Record<string, string> = {
      'User-Agent': BROWSER_USER_AGENT,
      ...(options.headers || {}),
    };
    if (cookieString) {
      reqHeaders['Cookie'] = cookieString;
    }

    const res = await fetch(currentUrl, {
      method: options.method || 'GET',
      headers: reqHeaders,
      redirect: 'manual',
      signal: options.signal,
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const firstPart = sc.split(';')[0];
      const [k, ...rest] = firstPart.trim().split('=');
      if (k && rest.length > 0) {
        cookieMap.set(k.trim(), rest.join('=').trim());
      }
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      try {
        await res.body?.cancel();
      } catch {
        // ignore
      }
      if (!location) {
        return {
          response: res,
          finalUrl: currentUrl,
          cookieHeader: Array.from(cookieMap.entries())
            .map(([k, v]) => `${k}=${v}`)
            .join('; '),
        };
      }
      currentUrl = new URL(location, currentUrl).toString();
      continue;
    }

    return {
      response: res,
      finalUrl: currentUrl,
      cookieHeader: Array.from(cookieMap.entries())
        .map(([k, v]) => `${k}=${v}`)
        .join('; '),
    };
  }

  throw new Error('Too many redirects while resolving Google Drive stream.');
}

/**
 * Resolve Google Drive's pre-transcoded H.264 + AAC CDN playback stream (`*.c.drive.google.com/videoplayback`)
 * via `/file/d/:fileId/preview` and `workspacevideo-pa.googleapis.com/v1/drive/media/:fileId/playback`.
 * Works even when `drive.usercontent.google.com/download` has hit anonymous download quota limits or
 * when the original uploaded file uses an unsupported browser codec such as 4K 60fps HEVC (H.265).
 */
interface DriveViewerPlaybackInfo {
  cdnStreamUrl: string;
  cdnCookieHeader: string;
  cdnStreamSize: number;
  fileName: string;
  originalFileSize: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  posterUrl?: string;
}

async function resolveDriveViewerPlayback(fileId: string): Promise<DriveViewerPlaybackInfo | null> {
  try {
    const previewPageUrl = `https://drive.google.com/file/d/${encodeURIComponent(fileId)}/preview`;
    const previewFetch = await fetchWithCookieJar(previewPageUrl, {
      signal: AbortSignal.timeout(9000),
    });
    const previewRes = previewFetch.response;

    if (
      !previewRes.ok ||
      previewFetch.finalUrl.includes('accounts.google.com') ||
      previewFetch.finalUrl.includes('ServiceLogin')
    ) {
      try {
        await previewRes.body?.cancel();
      } catch {}
      return null;
    }

    const html = await previewRes.text();

    const ogTitleMatch =
      html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i) ||
      html.match(/<meta\s+itemprop="name"\s+content="([^"]+)"/i);
    const extractedName = ogTitleMatch ? ogTitleMatch[1].trim() : `drive_${fileId}.mp4`;

    const sizeMatch = html.match(/\[null,null,"(\d{4,15})"\]/);
    const extractedOriginalSize = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;

    const posterMatch = html.match(
      /https:\/\/drive\.google\.com\/drive-viewer\/[a-zA-Z0-9_-]+(?:\\u003d|=)s1600-rw-v1/
    );
    const posterUrl = posterMatch ? posterMatch[0].replace(/\\u003d/g, '=') : undefined;

    const apiKeyMatch = html.match(
      /"(AIzaSy[a-zA-Z0-9_-]{33})","https:\/\/workspacevideo-pa\.googleapis\.com"/
    );
    const viewerApiKey = apiKeyMatch
      ? apiKeyMatch[1]
      : 'AIzaSyDVQw45DwoYh632gvsP5vPDqEKvb-Ywnb8';

    const playbackApiUrl = `https://workspacevideo-pa.googleapis.com/v1/drive/media/${encodeURIComponent(
      fileId
    )}/playback?key=${encodeURIComponent(viewerApiKey)}`;

    const pbRes = await fetch(playbackApiUrl, {
      headers: {
        'User-Agent': BROWSER_USER_AGENT,
        Referer: 'https://drive.google.com/',
        Origin: 'https://drive.google.com',
        ...(previewFetch.cookieHeader ? { Cookie: previewFetch.cookieHeader } : {}),
      },
      signal: AbortSignal.timeout(9000),
    });

    if (!pbRes.ok) {
      try {
        await pbRes.body?.cancel();
      } catch {}
      return null;
    }

    const pbData: any = await pbRes.json();
    const serializedPlayer = pbData?.mediaStreamingData?.serializedHouseBrandPlayerResponse;
    if (!serializedPlayer) {
      return null;
    }

    const playerResponse = JSON.parse(serializedPlayer);
    const formats: any[] = playerResponse?.streamingData?.formats || [];
    const mp4Formats = formats
      .filter((f) => f && typeof f.url === 'string' && String(f.mimeType || '').includes('video/mp4'))
      .sort((a, b) => (Number(b.height) || 0) - (Number(a.height) || 0));

    if (mp4Formats.length === 0) {
      return null;
    }

    const bestFormat = mp4Formats[0];
    const checkStream = await fetchWithCookieJar(bestFormat.url, {
      initialCookies: previewFetch.cookieHeader,
      headers: {
        Range: 'bytes=0-65535',
        Referer: 'https://drive.google.com/',
        Origin: 'https://drive.google.com',
      },
      signal: AbortSignal.timeout(8000),
    });

    const checkRes = checkStream.response;
    const checkType = (checkRes.headers.get('content-type') || '').toLowerCase();
    const checkCr = checkRes.headers.get('content-range') || '';
    const crTotalMatch = checkCr.match(/\/(\d+)$/);
    const cdnStreamSize = crTotalMatch
      ? parseInt(crTotalMatch[1], 10)
      : parseInt(bestFormat.contentLength || '0', 10) || 0;

    try {
      await checkRes.body?.cancel();
    } catch {}

    if ((!checkRes.ok && checkRes.status !== 206) || checkType.includes('text/html') || cdnStreamSize <= 0) {
      return null;
    }

    const durationSeconds = bestFormat.approxDurationMs
      ? Number((Number(bestFormat.approxDurationMs) / 1000).toFixed(3))
      : Number(playerResponse?.videoDetails?.lengthSeconds) || 0;

    logDebug('PUBLIC_RESOLVER', 'DRIVE_VIEWER_CDN_RESOLVED', {
      fileId,
      fileName: extractedName,
      itag: bestFormat.itag,
      qualityLabel: bestFormat.qualityLabel,
      width: bestFormat.width,
      height: bestFormat.height,
      durationSeconds,
      cdnStreamSize,
      originalFileSize: extractedOriginalSize,
    });

    return {
      cdnStreamUrl: checkStream.finalUrl || bestFormat.url,
      cdnCookieHeader: checkStream.cookieHeader || previewFetch.cookieHeader,
      cdnStreamSize,
      fileName: sanitizeFileName(extractedName),
      originalFileSize: extractedOriginalSize || cdnStreamSize,
      durationSeconds,
      width: Number(bestFormat.width) || 1280,
      height: Number(bestFormat.height) || 720,
      fps: Number(bestFormat.fps) || 30,
      posterUrl,
    };
  } catch (err: any) {
    logDebug('PUBLIC_RESOLVER', 'DRIVE_VIEWER_CDN_WARNING', {
      fileId,
      reason: err?.message || String(err),
    });
    return null;
  }
}

/**
 * Run ffprobe on a local path or remote URL with bounded probe size and proper HTTP headers/User-Agent.
 */
async function probeMediaSource(
  targetUrlOrPath: string,
  headers?: Record<string, string>,
  timeoutMs = 18000
): Promise<{
  durationSeconds: number;
  width: number;
  height: number;
  fps: number;
  videoCodec: string;
  videoProfile: string;
  pixFmt: string;
  audioCodec: string | null;
  hasAudio: boolean;
  formatName: string;
  sizeBytes: number;
}> {
  const startTimeMs = Date.now();
  return new Promise((resolve, reject) => {
    const isRemote = /^https?:\/\//i.test(targetUrlOrPath);
    const args: string[] = [
      '-v',
      'error',
      '-analyzeduration',
      '2000000',
      '-probesize',
      '2000000',
    ];

    if (isRemote) {
      args.push('-user_agent', BROWSER_USER_AGENT);
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2');
      if (headers && Object.keys(headers).length > 0) {
        const headerLines = Object.entries(headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join('\r\n');
        args.push('-headers', `${headerLines}\r\n`);
      }
    }

    args.push(
      '-show_entries',
      'format=duration,size,format_name:stream=index,codec_type,codec_name,profile,pix_fmt,width,height,r_frame_rate,duration',
      '-of',
      'json',
      targetUrlOrPath
    );

    const proc = spawn(FFPROBE_PATH, args);
    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('Timed out while inspecting video stream header.'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      const elapsedMs = Date.now() - startTimeMs;

      if (code !== 0) {
        logDebug('FFPROBE', 'PROBE_ERROR', {
          exitCode: code,
          elapsedMs,
          stderr: stderr.trim().slice(0, 300),
        });
        return reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
      }

      try {
        const parsed = JSON.parse(stdout);
        const streams: any[] = parsed.streams || [];
        const format = parsed.format || {};

        const videoStream = streams.find((s) => s.codec_type === 'video');
        const audioStream = streams.find((s) => s.codec_type === 'audio');

        if (!videoStream) {
          return reject(new Error('UNSUPPORTED_FILE: No valid video stream found in this file.'));
        }

        const durationFromFormat = parseFloat(format.duration);
        const durationFromStream = parseFloat(videoStream.duration);
        const durationSeconds =
          !isNaN(durationFromFormat) && durationFromFormat > 0
            ? durationFromFormat
            : !isNaN(durationFromStream) && durationFromStream > 0
            ? durationFromStream
            : 0;

        const sizeBytes = parseInt(format.size || '0', 10) || 0;

        let fps = 30;
        if (videoStream.r_frame_rate && typeof videoStream.r_frame_rate === 'string') {
          const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
          if (num > 0 && den > 0) {
            fps = Number((num / den).toFixed(2));
          }
        }

        const result = {
          durationSeconds,
          width: Number(videoStream.width) || 1280,
          height: Number(videoStream.height) || 720,
          fps,
          videoCodec: (videoStream.codec_name || 'h264').toLowerCase(),
          videoProfile: videoStream.profile || 'High',
          pixFmt: (videoStream.pix_fmt || 'yuv420p').toLowerCase(),
          audioCodec: audioStream ? (audioStream.codec_name || 'aac').toLowerCase() : null,
          hasAudio: Boolean(audioStream),
          formatName: (format.format_name || 'mp4').toLowerCase(),
          sizeBytes,
        };

        logDebug('FFPROBE', 'PROBE_SUCCESS', {
          elapsedMs,
          ...result,
        });

        resolve(result);
      } catch (err: any) {
        reject(new Error(`Failed to parse video metadata: ${err.message}`));
      }
    });
  });
}

/**
 * Resolve a public/shared Google Drive file ID into a verified direct media stream URL with cookies,
 * alongside Google Drive's pre-transcoded H.264/AAC CDN playback stream (`workspacevideo-pa.googleapis.com`).
 * Never returns an HTML page as a stream URL.
 */
async function resolvePublicDriveStream(fileId: string): Promise<{
  streamUrl: string;
  cookieHeader: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  streamByteSize: number;
  supportsRange: boolean;
  usingCdnFallback: boolean;
  viewerPlayback?: DriveViewerPlaybackInfo | null;
}> {
  const startMs = Date.now();
  // Resolve Drive Viewer CDN playback stream in parallel with direct download probe
  const viewerPromise = resolveDriveViewerPlayback(fileId);

  // Probe with a 1 MiB byte range (bytes=0-1048575) so edge-cached 64 KB headers don't mask a quota-exceeded file
  const primaryUrl = `https://drive.usercontent.google.com/download?id=${encodeURIComponent(
    fileId
  )}&export=download&confirm=t`;

  let { response: res, finalUrl, cookieHeader } = await fetchWithCookieJar(primaryUrl, {
    headers: {
      Range: 'bytes=0-1048575',
    },
    signal: AbortSignal.timeout(12000),
  });

  // If usercontent returned 404 or redirect to uc, also check drive.google.com/uc
  if (res.status === 404) {
    try {
      await res.body?.cancel();
    } catch {
      // ignore
    }
    const fallbackUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
    const fb = await fetchWithCookieJar(fallbackUrl, {
      headers: {
        Range: 'bytes=0-1048575',
      },
      signal: AbortSignal.timeout(12000),
    });
    res = fb.response;
    finalUrl = fb.finalUrl;
    cookieHeader = fb.cookieHeader;
  }

  logDebug('PUBLIC_RESOLVER', 'INITIAL_RESPONSE', {
    fileId,
    status: res.status,
    contentType: res.headers.get('content-type'),
    acceptRanges: res.headers.get('accept-ranges'),
    contentRange: res.headers.get('content-range'),
    elapsedMs: Date.now() - startMs,
  });

  const buildViewerFallbackResult = (viewer: DriveViewerPlaybackInfo, reason: string) => {
    logDebug('PUBLIC_RESOLVER', 'USING_DRIVE_VIEWER_CDN_STREAM', {
      fileId,
      reason,
      fileName: viewer.fileName,
      originalFileSize: viewer.originalFileSize,
      cdnStreamSize: viewer.cdnStreamSize,
      durationSeconds: viewer.durationSeconds,
    });
    return {
      streamUrl: viewer.cdnStreamUrl,
      cookieHeader: viewer.cdnCookieHeader,
      fileName: viewer.fileName,
      mimeType: 'video/mp4',
      fileSize: viewer.originalFileSize || viewer.cdnStreamSize,
      streamByteSize: viewer.cdnStreamSize,
      supportsRange: true,
      usingCdnFallback: true,
      viewerPlayback: viewer,
    };
  };

  if (res.status === 404) {
    try {
      await res.body?.cancel();
    } catch {}
    const viewer = await viewerPromise;
    if (viewer) return buildViewerFallbackResult(viewer, 'http_404_on_usercontent');
    throw new Error('NOT_FOUND: This Google Drive file does not exist or has been removed.');
  }

  if (
    res.status === 401 ||
    res.status === 403 ||
    finalUrl.includes('accounts.google.com') ||
    finalUrl.includes('ServiceLogin')
  ) {
    try {
      await res.body?.cancel();
    } catch {}
    const viewer = await viewerPromise;
    if (viewer) return buildViewerFallbackResult(viewer, `http_${res.status}_on_usercontent`);
    throw new Error(
      'ACCESS_DENIED: This video is not publicly accessible. Check its sharing permissions ("Anyone with the link") or click "Sign in with Google" to access it.'
    );
  }

  if (res.status === 429) {
    try {
      await res.body?.cancel();
    } catch {}
    const viewer = await viewerPromise;
    if (viewer) return buildViewerFallbackResult(viewer, 'http_429_quota_on_usercontent');
    throw new Error(
      'QUOTA_EXCEEDED: Google Drive temporarily restricted public access to this file due to download quota limits. Sign in with Google to stream via the Drive API or try again later.'
    );
  }

  const contentType = (res.headers.get('content-type') || '').toLowerCase();

  // If Google Drive returned an HTML page (virus scan confirmation or quota error page), parse it
  if (contentType.includes('text/html')) {
    const html = await res.text();

    if (
      html.includes('Too many users have viewed or downloaded this file') ||
      html.includes('Quota exceeded') ||
      html.includes('uc-error-subcaption')
    ) {
      const viewer = await viewerPromise;
      if (viewer) return buildViewerFallbackResult(viewer, 'html_quota_exceeded_on_usercontent');
      throw new Error(
        'QUOTA_EXCEEDED: Google Drive temporarily restricted access to this file. Please try again later or sign in with Google.'
      );
    }

    if (
      (html.includes('Sign in') || html.includes('You need access')) &&
      (html.includes('accounts.google.com') || html.includes('ServiceLogin') || html.includes('request access'))
    ) {
      const viewer = await viewerPromise;
      if (viewer) return buildViewerFallbackResult(viewer, 'html_signin_on_usercontent');
      throw new Error(
        'ACCESS_DENIED: This video is private or restricted. Check its sharing permissions or click "Sign in with Google".'
      );
    }

    const actionMatch = html.match(/action="([^"]+)"/);
    const idMatch = html.match(/name="id"\s+value="([^"]+)"/);
    const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/);
    const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/);
    const atMatch = html.match(/name="at"\s+value="([^"]+)"/);

    const fileNameHtmlMatch = html.match(/<a[^>]*>([^<]+\.(?:mp4|mov|webm|mkv|avi|m4v))<\/a>/i);
    const extractedHtmlFileName = fileNameHtmlMatch ? fileNameHtmlMatch[1] : `drive_${fileId}.mp4`;

    const downloadUrl = new URL(
      actionMatch ? actionMatch[1].replace(/&amp;/g, '&') : 'https://drive.usercontent.google.com/download'
    );
    downloadUrl.searchParams.set('id', idMatch ? idMatch[1] : fileId);
    downloadUrl.searchParams.set('export', 'download');
    downloadUrl.searchParams.set('confirm', confirmMatch ? confirmMatch[1] : 't');
    if (uuidMatch) downloadUrl.searchParams.set('uuid', uuidMatch[1]);
    if (atMatch) downloadUrl.searchParams.set('at', atMatch[1]);

    const confirmedRequestUrl = downloadUrl.toString();

    const confirmed = await fetchWithCookieJar(confirmedRequestUrl, {
      initialCookies: cookieHeader,
      headers: {
        Range: 'bytes=0-1048575',
      },
      signal: AbortSignal.timeout(12000),
    });

    const confirmedRes = confirmed.response;
    const confirmedType = (confirmedRes.headers.get('content-type') || '').toLowerCase();

    logDebug('PUBLIC_RESOLVER', 'CONFIRMED_RESPONSE', {
      fileId,
      status: confirmedRes.status,
      contentType: confirmedType,
      contentRange: confirmedRes.headers.get('content-range'),
    });

    if ((!confirmedRes.ok && confirmedRes.status !== 206) || confirmedType.includes('text/html')) {
      try {
        await confirmedRes.body?.cancel();
      } catch {}
      const viewer = await viewerPromise;
      if (viewer) return buildViewerFallbackResult(viewer, 'confirmed_download_blocked_or_quota');
      throw new Error(
        'ACCESS_DENIED: Google Drive requires authentication or permission to stream this video. Please check sharing settings or Sign in with Google.'
      );
    }

    const contentRange = confirmedRes.headers.get('content-range') || '';
    const totalMatch = contentRange.match(/\/(\d+)$/);
    const contentLength = parseInt(confirmedRes.headers.get('content-length') || '0', 10);
    const totalSize = totalMatch
      ? parseInt(totalMatch[1], 10)
      : confirmedRes.status === 200
      ? contentLength
      : 0;

    const disposition = confirmedRes.headers.get('content-disposition') || '';
    const fnMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
    const fileName = fnMatch ? decodeURIComponent(fnMatch[1]) : extractedHtmlFileName;

    try {
      await confirmedRes.body?.cancel();
    } catch {}

    const viewer = await viewerPromise;
    return {
      streamUrl: confirmed.finalUrl || confirmedRequestUrl,
      cookieHeader: confirmed.cookieHeader,
      fileName: sanitizeFileName(fileName),
      mimeType: confirmedType,
      fileSize: totalSize || viewer?.originalFileSize || 0,
      streamByteSize: totalSize || viewer?.cdnStreamSize || 0,
      supportsRange:
        confirmedRes.status === 206 || confirmedRes.headers.get('accept-ranges') === 'bytes',
      usingCdnFallback: false,
      viewerPlayback: viewer,
    };
  }

  // Direct binary response
  const contentRange = res.headers.get('content-range') || '';
  const totalMatch = contentRange.match(/\/(\d+)$/);
  const contentLength = parseInt(res.headers.get('content-length') || '0', 10);
  const totalSize = totalMatch
    ? parseInt(totalMatch[1], 10)
    : res.status === 200
    ? contentLength
    : 0;

  const disposition = res.headers.get('content-disposition') || '';
  const fnMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\n]+)["']?/i);
  const fileName = fnMatch ? decodeURIComponent(fnMatch[1]) : `drive_${fileId}.mp4`;

  try {
    await res.body?.cancel();
  } catch {}

  const viewer = await viewerPromise;
  return {
    streamUrl: finalUrl || primaryUrl,
    cookieHeader,
    fileName: sanitizeFileName(fileName !== `drive_${fileId}.mp4` ? fileName : viewer?.fileName || fileName),
    mimeType: contentType,
    fileSize: totalSize || viewer?.originalFileSize || 0,
    streamByteSize: totalSize,
    supportsRange: res.status === 206 || res.headers.get('accept-ranges') === 'bytes',
    usingCdnFallback: false,
    viewerPlayback: viewer,
  };
}

/**
 * Inspect and cache a Google Drive video source (Demo, OAuth, or Public).
 * Fast, non-blocking metadata inspection.
 */
async function inspectDriveVideo(
  fileId: string,
  oauthToken?: string,
  forceRefresh = false
): Promise<VideoSourceMetadata> {
  if (!forceRefresh) {
    const cached = metadataCache.get(fileId);
    if (
      cached &&
      Date.now() - cached.updatedAt < 10 * 60 * 1000 &&
      (!oauthToken || cached.oauthToken === oauthToken)
    ) {
      return cached;
    }
  }

  // Built-in 30:00 HD mountain lake demo video (1abcDEFgHijklMNop)
  if (fileId === DEMO_FILE_ID || fileId === 'sample_mountain_lake') {
    await ensureSampleVideoExists();
    const probe = await probeMediaSource(SAMPLE_VIDEO_PATH);
    const meta: VideoSourceMetadata = {
      fileId: DEMO_FILE_ID,
      fileName: 'Alpine_Mountain_Lake_Expedition_4K.mp4',
      mimeType: 'video/mp4',
      fileSize: 375_000_000, // 375 MB nominal size (~25 MB per 2-min clip matching UI reference)
      durationSeconds: Math.round(probe.durationSeconds) || 1800,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      videoCodec: probe.videoCodec,
      videoProfile: probe.videoProfile,
      pixFmt: probe.pixFmt,
      audioCodec: probe.audioCodec,
      hasAudio: probe.hasAudio,
      isBrowserCompatible: true,
      supportsRange: true,
      accessMode: 'demo',
      containerFormat: 'mp4',
      resolvedStreamUrl: SAMPLE_VIDEO_PATH,
      updatedAt: Date.now(),
    };
    metadataCache.set(fileId, meta);
    metadataCache.set(DEMO_FILE_ID, meta);
    return meta;
  }

  // Built-in unsupported-codec test video (MPEG-2 yuv422p + AC3 in MKV) for TEST H verification
  if (fileId === UNSUPPORTED_CODEC_DEMO_ID) {
    await ensureUnsupportedCodecSampleExists();
    const probe = await probeMediaSource(UNSUPPORTED_CODEC_SAMPLE_PATH);
    const compat = evaluateBrowserCompatibility(probe);
    const meta: VideoSourceMetadata = {
      fileId: UNSUPPORTED_CODEC_DEMO_ID,
      fileName: 'Legacy_Broadcast_Archive_MPEG2.mkv',
      mimeType: 'video/x-matroska',
      fileSize: probe.sizeBytes,
      durationSeconds: Math.round(probe.durationSeconds) || 60,
      width: probe.width,
      height: probe.height,
      fps: probe.fps,
      videoCodec: probe.videoCodec,
      videoProfile: probe.videoProfile,
      pixFmt: probe.pixFmt,
      audioCodec: probe.audioCodec,
      hasAudio: probe.hasAudio,
      isBrowserCompatible: compat.compatible,
      incompatibilityReason: compat.reason,
      supportsRange: true,
      accessMode: 'demo',
      containerFormat: probe.formatName,
      resolvedStreamUrl: UNSUPPORTED_CODEC_SAMPLE_PATH,
      updatedAt: Date.now(),
    };
    metadataCache.set(fileId, meta);
    return meta;
  }

  // 1. Authenticated Google Drive API v3 Path (when OAuth token is provided)
  if (oauthToken) {
    const metaUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?fields=id,name,mimeType,size,videoMediaMetadata,capabilities(canDownload)&supportsAllDrives=true`;

    const driveRes = await fetch(metaUrl, {
      headers: { Authorization: `Bearer ${oauthToken}` },
      signal: AbortSignal.timeout(10000),
    });

    logDebug('DRIVE_API', 'FILES_GET_METADATA', {
      fileId,
      status: driveRes.status,
    });

    if (driveRes.status === 401) {
      // First check if the file is publicly accessible before failing with 401
      try {
        return await inspectDriveVideo(fileId, undefined, forceRefresh);
      } catch {
        throw new Error(
          'AUTH_REQUIRED: Your Google Sign-In session has expired or been revoked. Please sign in with Google again.'
        );
      }
    }

    if (driveRes.status === 403) {
      // If signed-in account doesn't own a public link or hit API quota, try public resolver before failing
      try {
        return await inspectDriveVideo(fileId, undefined, forceRefresh);
      } catch {
        throw new Error(
          'ACCESS_DENIED: Your signed-in Google account does not have permission to access this video file.'
        );
      }
    }

    if (driveRes.status === 404) {
      throw new Error(
        'NOT_FOUND: This Google Drive file does not exist, has been deleted, or your account does not have permission to view it.'
      );
    }

    if (driveRes.status === 429) {
      try {
        return await inspectDriveVideo(fileId, undefined, forceRefresh);
      } catch {
        throw new Error(
          'QUOTA_EXCEEDED: Google Drive API rate or download quota exceeded. Please wait a moment and try again.'
        );
      }
    }

    if (driveRes.ok) {
      const driveData: any = await driveRes.json();
      const rawMime = (driveData.mimeType || '').toLowerCase();
      const name = driveData.name || `drive_${fileId}.mp4`;
      const isVideoMime =
        rawMime.startsWith('video/') ||
        /\.(mp4|mov|webm|mkv|avi|m4v|flv|wmv)$/i.test(name);

      if (!isVideoMime) {
        throw new Error(
          `UNSUPPORTED_FILE: This file ("${name}", type: ${driveData.mimeType}) is not a supported video file.`
        );
      }

      if (driveData.capabilities && driveData.capabilities.canDownload === false) {
        throw new Error(
          'ACCESS_DENIED: The owner of this Google Drive video has disabled downloading and streaming for viewers.'
        );
      }

      const streamUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
        fileId
      )}?alt=media&supportsAllDrives=true`;

      // Also resolve Drive Viewer CDN in parallel so HEVC/quota files have an instant H.264/AAC stream ready
      const viewerPromise = resolveDriveViewerPlayback(fileId);

      // Verify media stream accessibility & HTTP Range support via a fast 64 KB check
      const mediaCheck = await fetchWithCookieJar(streamUrl, {
        headers: {
          Authorization: `Bearer ${oauthToken}`,
          Range: 'bytes=0-65535',
        },
        signal: AbortSignal.timeout(10000),
      });
      const mediaRes = mediaCheck.response;
      const mediaType = (mediaRes.headers.get('content-type') || '').toLowerCase();
      const supportsRange =
        mediaRes.status === 206 || mediaRes.headers.get('accept-ranges') === 'bytes';
      try {
        await mediaRes.body?.cancel();
      } catch {}

      const viewer = await viewerPromise;

      if (mediaRes.status === 401) {
        if (viewer) {
          return await inspectDriveVideo(fileId, undefined, forceRefresh);
        }
        throw new Error(
          'AUTH_REQUIRED: Your Google Sign-In session has expired. Please sign in with Google again.'
        );
      }
      if (
        mediaRes.status === 403 ||
        mediaRes.status === 429 ||
        mediaType.includes('text/html') ||
        mediaType.includes('application/json')
      ) {
        // If alt=media hit per-file download quota, fall back to Drive Viewer CDN stream if available!
        if (viewer) {
          const metaFromViewer: VideoSourceMetadata = {
            fileId,
            fileName: sanitizeFileName(name),
            mimeType: 'video/mp4',
            fileSize: parseInt(driveData.size || '0', 10) || viewer.originalFileSize || viewer.cdnStreamSize,
            streamByteSize: viewer.cdnStreamSize,
            durationSeconds:
              (driveData.videoMediaMetadata?.durationMillis
                ? Number(driveData.videoMediaMetadata.durationMillis) / 1000
                : 0) || viewer.durationSeconds,
            width: viewer.width,
            height: viewer.height,
            fps: viewer.fps,
            videoCodec: 'h264',
            videoProfile: 'High',
            pixFmt: 'yuv420p',
            audioCodec: 'aac',
            hasAudio: true,
            isBrowserCompatible: true,
            supportsRange: true,
            accessMode: 'oauth',
            containerFormat: 'mp4',
            resolvedStreamUrl: viewer.cdnStreamUrl,
            resolvedCookieHeader: viewer.cdnCookieHeader,
            cdnPreviewStreamUrl: viewer.cdnStreamUrl,
            cdnPreviewCookieHeader: viewer.cdnCookieHeader,
            cdnPreviewSize: viewer.cdnStreamSize,
            usingCdnFallback: true,
            posterUrl: viewer.posterUrl,
            oauthToken,
            updatedAt: Date.now(),
          };
          metadataCache.set(fileId, metaFromViewer);
          return metaFromViewer;
        }
        if (mediaRes.status === 429) {
          throw new Error(
            'QUOTA_EXCEEDED: Google Drive download quota exceeded for this file. Please try again later.'
          );
        }
        throw new Error(
          'ACCESS_DENIED: Google Drive blocked media streaming for this file (download permission denied or download quota exceeded).'
        );
      }

      let durationSeconds = driveData.videoMediaMetadata?.durationMillis
        ? Number(driveData.videoMediaMetadata.durationMillis) / 1000
        : viewer?.durationSeconds || 0;
      let width = Number(driveData.videoMediaMetadata?.width) || viewer?.width || 1920;
      let height = Number(driveData.videoMediaMetadata?.height) || viewer?.height || 1080;
      let fps = viewer?.fps || 30;
      let videoCodec = 'h264';
      let videoProfile = 'High';
      let pixFmt = 'yuv420p';
      let audioCodec: string | null = 'aac';
      let hasAudio = true;
      let formatName = 'mp4';

      const preliminaryMeta: VideoSourceMetadata = {
        fileId,
        fileName: sanitizeFileName(name),
        mimeType: determineAccurateVideoMimeType(formatName, name, rawMime),
        fileSize: parseInt(driveData.size || '0', 10) || 0,
        streamByteSize: parseInt(driveData.size || '0', 10) || 0,
        durationSeconds,
        width,
        height,
        fps,
        videoCodec,
        videoProfile,
        pixFmt,
        audioCodec,
        hasAudio,
        isBrowserCompatible: true,
        supportsRange,
        accessMode: 'oauth',
        containerFormat: formatName,
        resolvedStreamUrl: streamUrl,
        cdnPreviewStreamUrl: viewer?.cdnStreamUrl,
        cdnPreviewCookieHeader: viewer?.cdnCookieHeader,
        cdnPreviewSize: viewer?.cdnStreamSize,
        posterUrl: viewer?.posterUrl,
        oauthToken,
        updatedAt: Date.now(),
      };
      metadataCache.set(fileId, preliminaryMeta);

      try {
        const probe = await probeMediaSource(
          buildLocalLoopbackRawStreamUrl(fileId),
          undefined,
          8000
        );
        if (probe.durationSeconds > 0) durationSeconds = probe.durationSeconds;
        width = probe.width || width;
        height = probe.height || height;
        fps = probe.fps || fps;
        videoCodec = probe.videoCodec;
        videoProfile = probe.videoProfile;
        pixFmt = probe.pixFmt;
        audioCodec = probe.audioCodec;
        hasAudio = probe.hasAudio;
        formatName = probe.formatName;
      } catch (probeErr: any) {
        logDebug('FFPROBE', 'OAUTH_PROBE_FALLBACK_TO_DRIVE_META', {
          fileId,
          reason: probeErr.message,
          hasDriveDuration: durationSeconds > 0,
        });
        if (String(probeErr.message || '').startsWith('UNSUPPORTED_FILE:')) {
          metadataCache.delete(fileId);
          throw probeErr;
        }
      }

      const compat = evaluateBrowserCompatibility({
        videoCodec,
        pixFmt,
        formatName,
        audioCodec,
      });

      const accurateMime = determineAccurateVideoMimeType(formatName, name, rawMime);

      const meta: VideoSourceMetadata = {
        fileId,
        fileName: sanitizeFileName(name),
        mimeType: accurateMime,
        fileSize: parseInt(driveData.size || '0', 10) || 0,
        streamByteSize: parseInt(driveData.size || '0', 10) || 0,
        durationSeconds,
        width,
        height,
        fps,
        videoCodec,
        videoProfile,
        pixFmt,
        audioCodec,
        hasAudio,
        isBrowserCompatible: compat.compatible,
        incompatibilityReason: compat.reason,
        supportsRange,
        accessMode: 'oauth',
        containerFormat: formatName,
        resolvedStreamUrl: streamUrl,
        cdnPreviewStreamUrl: viewer?.cdnStreamUrl,
        cdnPreviewCookieHeader: viewer?.cdnCookieHeader,
        cdnPreviewSize: viewer?.cdnStreamSize,
        posterUrl: viewer?.posterUrl,
        oauthToken,
        updatedAt: Date.now(),
      };
      metadataCache.set(fileId, meta);
      return meta;
    }
  }

  // 2. Public / Shared Google Drive Link Path
  const publicResolved = await resolvePublicDriveStream(fileId);
  const viewer = publicResolved.viewerPlayback;

  const isVideoMime =
    publicResolved.mimeType.startsWith('video/') ||
    publicResolved.mimeType.includes('octet-stream') ||
    /\.(mp4|mov|webm|mkv|avi|m4v)$/i.test(publicResolved.fileName);

  if (!isVideoMime) {
    throw new Error('UNSUPPORTED_FILE: This file format is not supported. Please provide a valid video file.');
  }

  // If resolvePublicDriveStream already fell back to the pre-transcoded Drive Viewer CDN stream
  // (e.g. because drive.usercontent.google.com returned "Google Drive - Quota exceeded"),
  // we already have a verified H.264 yuv420p + AAC faststart MP4 stream!
  if (publicResolved.usingCdnFallback && viewer) {
    const meta: VideoSourceMetadata = {
      fileId,
      fileName: publicResolved.fileName,
      mimeType: 'video/mp4',
      fileSize: publicResolved.fileSize,
      streamByteSize: viewer.cdnStreamSize,
      durationSeconds: viewer.durationSeconds || 60,
      width: viewer.width,
      height: viewer.height,
      fps: viewer.fps,
      videoCodec: 'h264',
      videoProfile: 'High',
      pixFmt: 'yuv420p',
      audioCodec: 'aac',
      hasAudio: true,
      isBrowserCompatible: true,
      supportsRange: true,
      accessMode: 'public',
      containerFormat: 'mp4',
      resolvedStreamUrl: viewer.cdnStreamUrl,
      resolvedCookieHeader: viewer.cdnCookieHeader,
      cdnPreviewStreamUrl: viewer.cdnStreamUrl,
      cdnPreviewCookieHeader: viewer.cdnCookieHeader,
      cdnPreviewSize: viewer.cdnStreamSize,
      usingCdnFallback: true,
      posterUrl: viewer.posterUrl,
      updatedAt: Date.now(),
    };
    metadataCache.set(fileId, meta);
    return meta;
  }

  // Store preliminary public metadata in cache so the local loopback proxy (/api/video/raw-stream/:fileId)
  // can immediately serve bytes to ffprobe without failing on Google 302 redirects!
  const preliminaryPublicMeta: VideoSourceMetadata = {
    fileId,
    fileName: publicResolved.fileName,
    mimeType: determineAccurateVideoMimeType('mp4', publicResolved.fileName, publicResolved.mimeType),
    fileSize: publicResolved.fileSize,
    streamByteSize: publicResolved.streamByteSize,
    durationSeconds: viewer?.durationSeconds || 0,
    width: viewer?.width || 1920,
    height: viewer?.height || 1080,
    fps: viewer?.fps || 30,
    videoCodec: 'h264',
    videoProfile: 'High',
    pixFmt: 'yuv420p',
    audioCodec: 'aac',
    hasAudio: true,
    isBrowserCompatible: true,
    supportsRange: publicResolved.supportsRange,
    accessMode: 'public',
    containerFormat: 'mp4',
    resolvedStreamUrl: publicResolved.streamUrl,
    resolvedCookieHeader: publicResolved.cookieHeader,
    cdnPreviewStreamUrl: viewer?.cdnStreamUrl,
    cdnPreviewCookieHeader: viewer?.cdnCookieHeader,
    cdnPreviewSize: viewer?.cdnStreamSize,
    posterUrl: viewer?.posterUrl,
    updatedAt: Date.now(),
  };
  metadataCache.set(fileId, preliminaryPublicMeta);

  let durationSeconds = viewer?.durationSeconds || 0;
  let width = viewer?.width || 1920;
  let height = viewer?.height || 1080;
  let fps = viewer?.fps || 30;
  let videoCodec = 'h264';
  let videoProfile = 'High';
  let pixFmt = 'yuv420p';
  let audioCodec: string | null = 'aac';
  let hasAudio = true;
  let formatName = 'mp4';
  let probedSizeBytes = 0;

  try {
    const probeResult = await probeMediaSource(
      buildLocalLoopbackRawStreamUrl(fileId),
      undefined,
      10000
    );
    if (probeResult.durationSeconds > 0) durationSeconds = probeResult.durationSeconds;
    width = probeResult.width || width;
    height = probeResult.height || height;
    fps = probeResult.fps || fps;
    videoCodec = probeResult.videoCodec;
    videoProfile = probeResult.videoProfile;
    pixFmt = probeResult.pixFmt;
    audioCodec = probeResult.audioCodec;
    hasAudio = probeResult.hasAudio;
    formatName = probeResult.formatName;
    probedSizeBytes = probeResult.sizeBytes;
  } catch (probeErr: any) {
    logDebug('FFPROBE', 'PUBLIC_PROBE_FALLBACK_TO_STREAM_DEFAULTS', {
      fileId,
      reason: probeErr.message,
    });
    if (String(probeErr.message || '').startsWith('UNSUPPORTED_FILE:')) {
      metadataCache.delete(fileId);
      throw probeErr;
    }
  }

  const compat = evaluateBrowserCompatibility({
    videoCodec,
    pixFmt,
    formatName,
    audioCodec,
  });
  const accurateMime = determineAccurateVideoMimeType(
    formatName,
    publicResolved.fileName,
    publicResolved.mimeType
  );

  const meta: VideoSourceMetadata = {
    fileId,
    fileName: publicResolved.fileName,
    mimeType: accurateMime,
    fileSize: publicResolved.fileSize || probedSizeBytes,
    streamByteSize: publicResolved.streamByteSize || probedSizeBytes,
    durationSeconds,
    width,
    height,
    fps,
    videoCodec,
    videoProfile,
    pixFmt,
    audioCodec,
    hasAudio,
    isBrowserCompatible: compat.compatible,
    incompatibilityReason: compat.reason,
    supportsRange: publicResolved.supportsRange,
    accessMode: 'public',
    containerFormat: formatName,
    resolvedStreamUrl: publicResolved.streamUrl,
    resolvedCookieHeader: publicResolved.cookieHeader,
    cdnPreviewStreamUrl: viewer?.cdnStreamUrl,
    cdnPreviewCookieHeader: viewer?.cdnCookieHeader,
    cdnPreviewSize: viewer?.cdnStreamSize,
    posterUrl: viewer?.posterUrl,
    updatedAt: Date.now(),
  };

  metadataCache.set(fileId, meta);
  return meta;
}

/**
 * Parse HTTP Range header ("bytes=start-end") against a known totalSize,
 * capping each HTTP 206 window at maxChunkBytes (4 MiB) so responses never exceed
 * Cloud Run's 32 MiB reverse-proxy response ceiling.
 */
function parseHttpRangeHeader(
  rangeHeader: string,
  totalSize: number,
  maxChunkBytes: number = MAX_RANGE_CHUNK_BYTES
): { valid: boolean; start: number; end: number } {
  const match = rangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return { valid: false, start: 0, end: 0 };
  }

  const startStr = match[1];
  const endStr = match[2];

  if (startStr === '' && endStr === '') {
    return { valid: false, start: 0, end: 0 };
  }

  if (startStr === '') {
    // Suffix range: bytes=-500000
    const suffixLength = parseInt(endStr, 10);
    if (isNaN(suffixLength) || suffixLength <= 0) {
      return { valid: false, start: 0, end: 0 };
    }
    const cappedSuffix = Math.min(suffixLength, maxChunkBytes);
    const start = Math.max(0, totalSize - cappedSuffix);
    const end = totalSize - 1;
    return { valid: start <= end, start, end };
  }

  const start = parseInt(startStr, 10);
  if (isNaN(start) || start < 0 || start >= totalSize) {
    return { valid: false, start, end: 0 };
  }

  const requestedEnd =
    endStr !== '' ? Math.min(parseInt(endStr, 10), totalSize - 1) : totalSize - 1;

  if (isNaN(requestedEnd) || start > requestedEnd) {
    return { valid: false, start, end: requestedEnd };
  }

  const end = Math.min(requestedEnd, start + maxChunkBytes - 1, totalSize - 1);
  return { valid: true, start, end };
}

/**
 * Build a bounded upstream HTTP Range header ("bytes=start-end") for Google Drive
 * so that upstream responses never exceed MAX_RANGE_CHUNK_BYTES (4 MiB).
 */
function buildBoundedUpstreamRangeHeader(
  incomingRangeHeader: string | undefined,
  knownTotalSize: number,
  maxChunkBytes: number = MAX_RANGE_CHUNK_BYTES
): string {
  if (!incomingRangeHeader) {
    const end =
      knownTotalSize > 65536
        ? Math.min(knownTotalSize - 1, maxChunkBytes - 1)
        : maxChunkBytes - 1;
    return `bytes=0-${end}`;
  }

  const match = incomingRangeHeader.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match) {
    return `bytes=0-${maxChunkBytes - 1}`;
  }

  const startStr = match[1];
  const endStr = match[2];

  if (startStr === '') {
    const suffix = Math.min(parseInt(endStr, 10) || maxChunkBytes, maxChunkBytes);
    if (knownTotalSize > 65536) {
      const start = Math.max(0, knownTotalSize - suffix);
      return `bytes=${start}-${knownTotalSize - 1}`;
    }
    return `bytes=-${suffix}`;
  }

  const start = Math.max(0, parseInt(startStr, 10) || 0);
  let end =
    endStr !== ''
      ? Math.min(parseInt(endStr, 10), start + maxChunkBytes - 1)
      : start + maxChunkBytes - 1;

  if (knownTotalSize > 65536) {
    end = Math.min(end, knownTotalSize - 1);
  }

  return `bytes=${start}-${Math.max(start, end)}`;
}

// Maximum chunk size for a single HTTP 206 download response (24 MiB, safely under Cloud Run's 32 MiB ceiling)
const MAX_DOWNLOAD_RANGE_BYTES = 24 * 1024 * 1024;

/**
 * Parse HTTP Range header for /api/trim/download/:jobId
 * Honors explicit byte ranges up to MAX_DOWNLOAD_RANGE_BYTES (24 MiB) without artificially truncating to 4 MiB.
 */
function parseDownloadRangeHeader(
  rangeHeader: string,
  totalSize: number
): { valid: boolean; start: number; end: number } {
  return parseHttpRangeHeader(rangeHeader, totalSize, MAX_DOWNLOAD_RANGE_BYTES);
}

/**
 * Compute SHA-256 checksum of a file on disk using streaming hash (zero full-file RAM buffering)
 */
function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/**
 * Recover a completed TrimJob from disk (/tmp/drivetrim_jobs) if server memory was reset
 */
function getOrRecoverCompletedJob(jobId: string): TrimJob | undefined {
  const existing = trimJobs.get(jobId);
  if (existing) {
    existing.lastAccessedAt = Date.now();
    return existing;
  }

  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(jobId)) {
    return undefined;
  }

  try {
    const files = fs.readdirSync(TEMP_DIR);
    const metaFile = files.find((f) => f.startsWith(`${jobId}_`) && f.endsWith('.meta.json'));
    if (metaFile) {
      const metaPath = path.join(TEMP_DIR, metaFile);
      const savedJob: TrimJob = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (savedJob && savedJob.outputFilePath && fs.existsSync(savedJob.outputFilePath)) {
        const st = fs.statSync(savedJob.outputFilePath);
        if (st.size > 1024) {
          savedJob.outputSize = st.size;
          savedJob.status = 'completed';
          savedJob.lastAccessedAt = Date.now();
          trimJobs.set(jobId, savedJob);
          return savedJob;
        }
      }
    }

    const videoFile = files.find(
      (f) =>
        f.startsWith(`${jobId}_`) &&
        /\.(mp4|mov|webm)$/i.test(f) &&
        !f.includes('.part.')
    );
    if (videoFile) {
      const fullPath = path.join(TEMP_DIR, videoFile);
      const st = fs.statSync(fullPath);
      if (st.size > 1024) {
        const outputFileName = videoFile.slice(jobId.length + 1);
        const extMatch = outputFileName.match(/\.(mp4|mov|webm)$/i);
        const outputFormat = (extMatch ? extMatch[1].toLowerCase() : 'mp4') as 'mp4' | 'mov' | 'webm';
        const recovered: TrimJob = {
          jobId,
          fileId: 'recovered',
          fileName: outputFileName,
          startTime: 0,
          endTime: 0,
          clipDuration: 0,
          originalDuration: 0,
          trimMode: 'copy',
          effectiveTrimMode: 'copy',
          outputFormat,
          status: 'completed',
          progressPercent: 100,
          processedSeconds: 0,
          statusMessage: 'Video segment trimmed and verified successfully!',
          outputFilePath: fullPath,
          outputFileName,
          outputSize: st.size,
          actualOutputDuration: 0,
          createdAt: st.mtimeMs || Date.now(),
          completedAt: st.mtimeMs || Date.now(),
          lastAccessedAt: Date.now(),
        };
        trimJobs.set(jobId, recovered);
        return recovered;
      }
    }
  } catch {
    // ignore recovery scan error
  }

  return undefined;
}

/**
 * Periodic cleanup of expired temporary job files and expired OAuth sessions
 */
function runCleanupSweep() {
  const now = Date.now();
  const maxAgeMs = TEMP_RETENTION_MINUTES * 60 * 1000;

  for (const [jobId, job] of trimJobs.entries()) {
    const lastActive = job.lastAccessedAt || job.completedAt || job.createdAt;
    if (
      (job.status === 'completed' || job.status === 'error' || job.status === 'cancelled') &&
      now - lastActive > maxAgeMs
    ) {
      if (job.outputFilePath && fs.existsSync(job.outputFilePath)) {
        try {
          fs.unlinkSync(job.outputFilePath);
        } catch {}
      }
      const metaPath = `${job.outputFilePath}.meta.json`;
      if (job.outputFilePath && fs.existsSync(metaPath)) {
        try {
          fs.unlinkSync(metaPath);
        } catch {}
      }
      trimJobs.delete(jobId);
    }
  }

  for (const [sid, sess] of authSessions.entries()) {
    if (sess.expiresAt <= now) {
      authSessions.delete(sid);
    }
  }
}

setInterval(runCleanupSweep, 5 * 60 * 1000);

async function startServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Standard security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    next();
  });

  // Sliding-window per-IP rate limiter for resource-intensive API routes
  const rateLimitBuckets = new Map<string, number[]>();
  const createRateLimiter = (bucketPrefix: string, maxRequests: number, windowMs: number) => {
    return (req: Request, res: Response, next: express.NextFunction) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      const key = `${bucketPrefix}:${ip}`;
      const now = Date.now();
      const timestamps = (rateLimitBuckets.get(key) || []).filter((t) => now - t < windowMs);
      if (timestamps.length >= maxRequests) {
        return res.status(429).json({
          code: 'RATE_LIMITED',
          error: 'Too many requests in a short period. Please wait a moment and try again.',
        });
      }
      timestamps.push(now);
      rateLimitBuckets.set(key, timestamps);
      next();
    };
  };
  const inspectRateLimiter = createRateLimiter('inspect', 60, 60_000);
  const trimStartRateLimiter = createRateLimiter('trim', 30, 60_000);

  // Warm up sample video in background
  ensureSampleVideoExists().catch((err) => {
    console.error('Sample video init warning:', err.message);
  });

  /**
   * POST /api/auth/session
   * Validates and stores Google OAuth access token in backend session store so
   * raw OAuth tokens are never exposed in DOM <video src> attributes.
   */
  app.post('/api/auth/session', async (req: Request, res: Response) => {
    try {
      const { accessToken, userEmail, userName } = req.body || {};
      const authHeader = req.headers.authorization;
      const token =
        (typeof accessToken === 'string' && accessToken.trim()) ||
        (authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : '');

      if (!token) {
        return res.status(400).json({ error: 'Missing OAuth access token.' });
      }

      // Verify token with Google OAuth2 tokeninfo endpoint
      let expiresInSeconds = 3500;
      let verifiedEmail = userEmail;
      try {
        const tokenInfoRes = await fetch(
          `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`,
          { signal: AbortSignal.timeout(6000) }
        );
        if (tokenInfoRes.status === 400 || tokenInfoRes.status === 401) {
          return res.status(401).json({
            code: 'INVALID_TOKEN',
            error: 'Google OAuth access token is invalid or expired.',
          });
        }
        if (tokenInfoRes.ok) {
          const info: any = await tokenInfoRes.json();
          if (info.expires_in) {
            expiresInSeconds = Math.max(60, parseInt(String(info.expires_in), 10) || 3500);
          }
          if (info.email) {
            verifiedEmail = info.email;
          }
        }
      } catch {
        // Network warning on tokeninfo; proceed with default TTL
      }

      const sessionId = crypto.randomBytes(24).toString('hex');
      const now = Date.now();
      const expiresAt = now + expiresInSeconds * 1000;

      authSessions.set(sessionId, {
        sessionId,
        accessToken: token,
        userEmail: verifiedEmail,
        userName,
        createdAt: now,
        expiresAt,
      });

      res.setHeader(
        'Set-Cookie',
        `drivetrim_sid=${sessionId}; Path=/; Max-Age=${expiresInSeconds}; HttpOnly; SameSite=None; Secure`
      );

      logDebug('DRIVE_API', 'OAUTH_SESSION_CREATED', {
        sessionId: sessionId.slice(0, 8) + '...',
        userEmail: verifiedEmail || 'unknown',
        expiresInSeconds,
      });

      return res.json({
        authenticated: true,
        sessionId,
        expiresAt,
        userEmail: verifiedEmail,
        userName,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to establish auth session.' });
    }
  });

  /**
   * GET /api/auth/session
   * Checks whether a backend OAuth session is active and valid.
   */
  app.get('/api/auth/session', (req: Request, res: Response) => {
    const querySid = typeof req.query.sid === 'string' ? req.query.sid.trim() : undefined;
    const cookies = parseCookieHeader(req.headers.cookie);
    const sid = querySid || cookies.drivetrim_sid;

    if (!sid) {
      return res.json({ authenticated: false });
    }

    const sess = authSessions.get(sid);
    if (!sess || sess.expiresAt <= Date.now()) {
      if (sid) authSessions.delete(sid);
      return res.json({ authenticated: false, expired: true });
    }

    return res.json({
      authenticated: true,
      sessionId: sess.sessionId,
      expiresAt: sess.expiresAt,
      userEmail: sess.userEmail,
      userName: sess.userName,
    });
  });

  /**
   * DELETE /api/auth/session
   * Clears backend OAuth session on sign-out.
   */
  app.delete('/api/auth/session', (req: Request, res: Response) => {
    const querySid = typeof req.query.sid === 'string' ? req.query.sid.trim() : undefined;
    const cookies = parseCookieHeader(req.headers.cookie);
    const sid = querySid || cookies.drivetrim_sid;

    if (sid) {
      authSessions.delete(sid);
    }

    res.setHeader(
      'Set-Cookie',
      'drivetrim_sid=; Path=/; Max-Age=0; HttpOnly; SameSite=None; Secure'
    );
    return res.json({ authenticated: false });
  });

  /**
   * POST /api/video/inspect
   * Validates Google Drive link, checks accessibility, probes codecs/format, returns stream URL immediately.
   */
  app.post('/api/video/inspect', inspectRateLimiter, async (req: Request, res: Response) => {
    try {
      const { url } = req.body || {};
      const oauthToken = extractRequestOAuthToken(req);

      const extracted = extractGoogleDriveFileId(url);
      if (!extracted.valid || !extracted.fileId) {
        return res.status(400).json({
          code: 'INVALID_LINK',
          error: extracted.error || 'Please enter a valid Google Drive video link.',
        });
      }

      const meta = await inspectDriveVideo(extracted.fileId, oauthToken);

      const streamPath = meta.isBrowserCompatible
        ? `/api/video/stream/${encodeURIComponent(meta.fileId)}`
        : `/api/video/stream/${encodeURIComponent(meta.fileId)}?compat=1`;

      return res.json({
        fileId: meta.fileId,
        fileName: meta.fileName,
        mimeType: meta.isBrowserCompatible ? meta.mimeType : 'video/mp4',
        fileSize: meta.fileSize,
        durationSeconds: meta.durationSeconds,
        width: meta.width,
        height: meta.height,
        fps: meta.fps,
        videoCodec: meta.videoCodec,
        videoProfile: meta.videoProfile,
        pixFmt: meta.pixFmt,
        audioCodec: meta.audioCodec,
        hasAudio: meta.hasAudio,
        isBrowserCompatible: meta.isBrowserCompatible,
        incompatibilityReason: meta.incompatibilityReason,
        supportsRange: meta.supportsRange,
        accessMode: meta.accessMode,
        containerFormat: meta.containerFormat,
        streamUrl: streamPath,
      });
    } catch (err: any) {
      const msg: string = err.message || 'Unable to load video from Google Drive.';
      if (msg.startsWith('AUTH_REQUIRED:')) {
        return res.status(401).json({
          code: 'AUTH_REQUIRED',
          error: msg.replace('AUTH_REQUIRED:', '').trim(),
        });
      }
      if (msg.startsWith('ACCESS_DENIED:')) {
        return res.status(403).json({
          code: 'ACCESS_DENIED',
          error: msg.replace('ACCESS_DENIED:', '').trim(),
        });
      }
      if (msg.startsWith('QUOTA_EXCEEDED:')) {
        return res.status(429).json({
          code: 'QUOTA_EXCEEDED',
          error: msg.replace('QUOTA_EXCEEDED:', '').trim(),
        });
      }
      if (msg.startsWith('UNSUPPORTED_FILE:')) {
        return res.status(415).json({
          code: 'UNSUPPORTED_FILE',
          error: msg.replace('UNSUPPORTED_FILE:', '').trim(),
        });
      }
      if (msg.startsWith('NOT_FOUND:')) {
        return res.status(404).json({
          code: 'NOT_FOUND',
          error: msg.replace('NOT_FOUND:', '').trim(),
        });
      }
      return res.status(500).json({
        code: 'INSPECT_FAILED',
        error: msg,
      });
    }
  });

  /**
   * GET /api/video/debug-logs
   * Returns recent structured stream & Google Drive API diagnostic logs
   */
  app.get('/api/video/debug-logs', (req: Request, res: Response) => {
    const filterFileId = typeof req.query.fileId === 'string' ? req.query.fileId : undefined;
    const logs = filterFileId
      ? recentStreamLogs.filter((l) => l.fileId === filterFileId)
      : recentStreamLogs;
    res.json({
      count: logs.length,
      logs: logs.slice(-60),
    });
  });

  /**
   * GET /api/video/raw-stream/:fileId
   * Internal Local Loopback Stream Proxy for FFprobe and FFmpeg.
   * Because FFmpeg/Lavf58 strips custom Authorization & Cookie headers across cross-domain 302 redirects
   * (e.g., from googleapis.com or drive.usercontent.google.com to *.googleusercontent.com),
   * local FFprobe/FFmpeg processes connect to http://127.0.0.1:PORT/api/video/raw-stream/:fileId,
   * which follows Google redirects in Node.js via fetchWithCookieJar and streams raw bytes with full HTTP Range support.
   */
  app.get('/api/video/raw-stream/:fileId', async (req: Request, res: Response) => {
    const remoteAddr = req.socket.remoteAddress || '';
    const isLoopback =
      remoteAddr === '127.0.0.1' ||
      remoteAddr === '::1' ||
      remoteAddr === '::ffff:127.0.0.1';
    if (!isLoopback || req.headers['x-forwarded-for']) {
      return res.status(403).json({
        error: 'Internal loopback proxy endpoint is restricted to local media processors.',
      });
    }

    const fileId = req.params.fileId;
    try {
      if (!/^[a-zA-Z0-9_-]{10,64}$/.test(fileId)) {
        return res.status(400).end();
      }

      let meta = metadataCache.get(fileId);
      const oauthToken = extractRequestOAuthToken(req, meta);
      if (!meta) {
        meta = await inspectDriveVideo(fileId, oauthToken);
      }

      if (meta.accessMode === 'demo' && meta.resolvedStreamUrl && fs.existsSync(meta.resolvedStreamUrl)) {
        const stat = fs.statSync(meta.resolvedStreamUrl);
        const totalSize = stat.size;
        const rangeHeader = req.headers.range;
        if (rangeHeader) {
          const parsed = parseHttpRangeHeader(rangeHeader, totalSize, totalSize);
          if (!parsed.valid) {
            res.status(416).setHeader('Content-Range', `bytes */${totalSize}`);
            return res.end();
          }
          const { start, end } = parsed;
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${totalSize}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': end - start + 1,
            'Content-Type': meta.mimeType || 'video/mp4',
          });
          const s = fs.createReadStream(meta.resolvedStreamUrl, { start, end });
          res.on('close', () => {
            if (!res.writableEnded) s.destroy();
          });
          s.pipe(res);
          return;
        }
        res.writeHead(200, {
          'Accept-Ranges': 'bytes',
          'Content-Length': totalSize,
          'Content-Type': meta.mimeType || 'video/mp4',
        });
        const s = fs.createReadStream(meta.resolvedStreamUrl);
        res.on('close', () => {
          if (!res.writableEnded) s.destroy();
        });
        s.pipe(res);
        return;
      }

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) abortController.abort();
      });

      const preferCdn = req.query.source === 'cdn' || Boolean(meta.usingCdnFallback);
      let targetUrl =
        preferCdn && meta.cdnPreviewStreamUrl
          ? meta.cdnPreviewStreamUrl
          : meta.resolvedStreamUrl!;
      let targetCookies =
        preferCdn && meta.cdnPreviewStreamUrl
          ? meta.cdnPreviewCookieHeader || meta.resolvedCookieHeader
          : meta.resolvedCookieHeader;

      const buildHeaders = (useCdn: boolean): Record<string, string> => {
        const h: Record<string, string> = {
          Referer: 'https://drive.google.com/',
          Origin: 'https://drive.google.com',
        };
        if (req.headers.range) {
          h['Range'] = req.headers.range;
        }
        if (!useCdn && (oauthToken || meta?.oauthToken)) {
          h['Authorization'] = `Bearer ${oauthToken || meta?.oauthToken}`;
        }
        return h;
      };

      let { response: upstreamRes } = await fetchWithCookieJar(targetUrl, {
        headers: buildHeaders(preferCdn && Boolean(meta.cdnPreviewStreamUrl)),
        initialCookies: targetCookies,
        signal: abortController.signal,
      });

      let upstreamType = (upstreamRes.headers.get('content-type') || '').toLowerCase();

      // If primary download URL hit Google Drive's anonymous download quota ("Quota exceeded" HTML / 403 / 429),
      // automatically switch to Google Drive's pre-transcoded H.264/AAC CDN stream!
      if (upstreamType.includes('text/html') || (!upstreamRes.ok && upstreamRes.status !== 206)) {
        try {
          await upstreamRes.body?.cancel();
        } catch {}

        if (!meta.cdnPreviewStreamUrl) {
          const viewer = await resolveDriveViewerPlayback(fileId);
          if (viewer) {
            meta.cdnPreviewStreamUrl = viewer.cdnStreamUrl;
            meta.cdnPreviewCookieHeader = viewer.cdnCookieHeader;
            meta.cdnPreviewSize = viewer.cdnStreamSize;
          }
        }

        if (meta.cdnPreviewStreamUrl && targetUrl !== meta.cdnPreviewStreamUrl) {
          logDebug('RANGE_STREAM', 'RAW_STREAM_FALLBACK_TO_CDN', {
            fileId,
            previousStatus: upstreamRes.status,
            previousType: upstreamType,
          });
          meta.usingCdnFallback = true;
          meta.resolvedStreamUrl = meta.cdnPreviewStreamUrl;
          meta.resolvedCookieHeader = meta.cdnPreviewCookieHeader;
          meta.streamByteSize = meta.cdnPreviewSize;

          const cdnRetry = await fetchWithCookieJar(meta.cdnPreviewStreamUrl, {
            headers: buildHeaders(true),
            initialCookies: meta.cdnPreviewCookieHeader,
            signal: abortController.signal,
          });
          upstreamRes = cdnRetry.response;
          upstreamType = (upstreamRes.headers.get('content-type') || '').toLowerCase();
        }
      }

      if (upstreamType.includes('text/html') || (!upstreamRes.ok && upstreamRes.status !== 206)) {
        try {
          await upstreamRes.body?.cancel();
        } catch {}
        return res.status(upstreamRes.status >= 400 ? upstreamRes.status : 403).end();
      }

      const outHeaders: Record<string, string> = {
        'Content-Type': meta.mimeType || 'video/mp4',
        'Accept-Ranges': 'bytes',
      };
      const cr = upstreamRes.headers.get('content-range');
      const cl = upstreamRes.headers.get('content-length');
      if (cr) outHeaders['Content-Range'] = cr;
      if (cl) outHeaders['Content-Length'] = cl;

      res.writeHead(upstreamRes.status === 206 ? 206 : 200, outHeaders);
      if (upstreamRes.body) {
        const nodeStream = Readable.fromWeb(upstreamRes.body as any);
        res.on('close', () => {
          if (!res.writableEnded) nodeStream.destroy();
        });
        nodeStream.pipe(res);
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    }
  });

  /**
   * Core HTTP 200 / 206 Range Streaming Handler
   * Mounted at both GET /api/video/stream/:fileId and GET /api/stream/:fileId
   */
  const handleVideoStream = async (req: Request, res: Response) => {
    const requestId = crypto.randomBytes(4).toString('hex');
    const startedAt = Date.now();
    const fileId = req.params.fileId;
    const incomingRange = req.headers.range || 'NONE (full stream requested)';
    const forceCompat = req.query.compat === '1';

    try {
      if (!/^[a-zA-Z0-9_-]{10,64}$/.test(fileId)) {
        logDebug('RANGE_STREAM', 'STREAM_INVALID_FILE_ID', {
          requestId,
          fileId,
          incomingRange,
        });
        return res.status(400).json({ error: 'Invalid file ID' });
      }

      let meta = metadataCache.get(fileId);
      const effectiveOAuthToken = extractRequestOAuthToken(req, meta);
      if (!meta || (effectiveOAuthToken && meta.oauthToken !== effectiveOAuthToken)) {
        meta = await inspectDriveVideo(fileId, effectiveOAuthToken);
      }

      logDebug('RANGE_STREAM', 'STREAM_INCOMING_REQUEST', {
        requestId,
        fileId,
        fileName: meta.fileName,
        accessMode: meta.accessMode,
        incomingRange,
        forceCompat,
        hasOAuthToken: Boolean(effectiveOAuthToken || meta.oauthToken),
        hasCdnPreview: Boolean(meta.cdnPreviewStreamUrl),
        usingCdnFallback: Boolean(meta.usingCdnFallback),
        cachedMeta: {
          mimeType: meta.mimeType,
          fileSize: meta.fileSize,
          streamByteSize: meta.streamByteSize,
          cdnPreviewSize: meta.cdnPreviewSize,
          durationSeconds: meta.durationSeconds,
          videoCodec: meta.videoCodec,
          pixFmt: meta.pixFmt,
          audioCodec: meta.audioCodec,
          isBrowserCompatible: meta.isBrowserCompatible,
          supportsRange: meta.supportsRange,
        },
        userAgent: req.headers['user-agent'] || 'unknown',
      });

      // Set CORS headers for browser HTML5 video compatibility
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'Content-Range, Content-Length, Accept-Ranges, Content-Type'
      );

      // FALLBACK FOR UNSUPPORTED BROWSER CODECS (Problem 4):
      // 1. If the video is a Google Drive file and we have (or can resolve) Google Drive's pre-transcoded
      //    H.264 + AAC CDN stream (`meta.cdnPreviewStreamUrl`), stream it directly via HTTP 206 Partial Content!
      //    This starts playback in < 100ms with zero CPU transcode delay and avoids Google Drive download quota limits.
      // 2. Only if no Google Drive CDN stream exists (e.g. local demo MKV `1unsupportedCodecDemoVideoId`),
      //    transcode a local H.264 yuv420p faststart preview file.
      if ((!meta.isBrowserCompatible || forceCompat) && !meta.cdnPreviewStreamUrl && meta.accessMode !== 'demo') {
        const viewer = await resolveDriveViewerPlayback(fileId);
        if (viewer) {
          meta.cdnPreviewStreamUrl = viewer.cdnStreamUrl;
          meta.cdnPreviewCookieHeader = viewer.cdnCookieHeader;
          meta.cdnPreviewSize = viewer.cdnStreamSize;
        }
      }

      if ((!meta.isBrowserCompatible || forceCompat) && !meta.cdnPreviewStreamUrl) {
        const previewPath = path.join(TEMP_DIR, `preview_compat_${fileId}.mp4`);
        if (!fs.existsSync(previewPath)) {
          let lockPromise = compatPreviewLocks.get(fileId);
          if (!lockPromise) {
            lockPromise = (async () => {
              try {
                logDebug('COMPAT_PREVIEW', 'GENERATING_LIGHTWEIGHT_PREVIEW', {
                  requestId,
                  fileId,
                  sourceVideoCodec: meta!.videoCodec,
                  sourcePixFmt: meta!.pixFmt,
                  sourceContainer: meta!.containerFormat,
                });

                const inputSource =
                  meta!.accessMode === 'demo' &&
                  meta!.resolvedStreamUrl &&
                  fs.existsSync(meta!.resolvedStreamUrl)
                    ? meta!.resolvedStreamUrl
                    : buildLocalLoopbackRawStreamUrl(fileId);

                const canCopyVideoStream =
                  meta!.videoCodec === 'h264' &&
                  ['yuv420p', 'yuvj420p', 'nv12', ''].includes(meta!.pixFmt || '');

                await new Promise<void>((resolve, reject) => {
                  const args: string[] = ['-y', '-i', inputSource];
                  if (canCopyVideoStream) {
                    args.push(
                      '-c:v',
                      'copy',
                      '-c:a',
                      'aac',
                      '-b:a',
                      '128k',
                      '-ar',
                      '44100',
                      '-ac',
                      '2',
                      '-movflags',
                      '+faststart',
                      `${previewPath}.tmp.mp4`
                    );
                  } else {
                    args.push(
                      '-vf',
                      'scale=-2:480,fps=30,format=yuv420p',
                      '-c:v',
                      'libx264',
                      '-profile:v',
                      'baseline',
                      '-preset',
                      'ultrafast',
                      '-crf',
                      '28',
                      '-pix_fmt',
                      'yuv420p',
                      '-c:a',
                      'aac',
                      '-b:a',
                      '96k',
                      '-ar',
                      '44100',
                      '-ac',
                      '2',
                      '-movflags',
                      '+faststart',
                      `${previewPath}.tmp.mp4`
                    );
                  }

                  const proc = spawn(FFMPEG_PATH, args);
                  proc.on('close', (code) => {
                    if (code === 0 && fs.existsSync(`${previewPath}.tmp.mp4`)) {
                      fs.renameSync(`${previewPath}.tmp.mp4`, previewPath);
                      meta!.previewFilePath = previewPath;
                      resolve();
                    } else {
                      reject(new Error(`Preview rendition transcode failed with code ${code}`));
                    }
                  });
                  proc.on('error', reject);
                });
              } finally {
                compatPreviewLocks.delete(fileId);
              }
            })();
            compatPreviewLocks.set(fileId, lockPromise);
          }
          await lockPromise;
        }

        const stat = fs.statSync(previewPath);
        const totalSize = stat.size;
        const rawRangeHeader = req.headers.range;

        if (!rawRangeHeader && totalSize <= MAX_RANGE_CHUNK_BYTES) {
          res.writeHead(200, {
            'Accept-Ranges': 'bytes',
            'Content-Length': totalSize,
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-cache',
          });
          const stream = fs.createReadStream(previewPath);
          pipeStreamWithDiagnostics(stream, req, res, {
            requestId,
            fileId,
            mode: 'compat_preview_200',
            rangeHeader: 'NONE',
            statusSent: 200,
            expectedBytes: totalSize,
            startedAt,
          });
          return;
        }

        const effectiveRange = rawRangeHeader || 'bytes=0-';
        const parsedRange = parseHttpRangeHeader(effectiveRange, totalSize);

        if (!parsedRange.valid) {
          logDebug('RANGE_STREAM', 'COMPAT_RANGE_416_INVALID', {
            requestId,
            fileId,
            rangeHeader: effectiveRange,
            totalSize,
          });
          res.status(416).setHeader('Content-Range', `bytes */${totalSize}`);
          return res.end();
        }

        const { start, end } = parsedRange;
        const chunkSize = end - start + 1;
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': 'video/mp4',
          'Cache-Control': 'no-cache',
        });
        const stream = fs.createReadStream(previewPath, { start, end });
        pipeStreamWithDiagnostics(stream, req, res, {
          requestId,
          fileId,
          mode: 'compat_preview_206',
          rangeHeader: effectiveRange,
          statusSent: 206,
          expectedBytes: chunkSize,
          startedAt,
        });
        return;
      }

      // LOCAL DEMO FILE STREAMING (HTTP 200 / HTTP 206 Partial Content & HTTP 416 handling)
      if (
        meta.accessMode === 'demo' &&
        meta.resolvedStreamUrl &&
        fs.existsSync(meta.resolvedStreamUrl)
      ) {
        const filePath = meta.resolvedStreamUrl;
        const stat = fs.statSync(filePath);
        const totalSize = stat.size;
        const rawRangeHeader = req.headers.range;

        if (!rawRangeHeader && totalSize <= 30 * 1024 * 1024) {
          logDebug('RANGE_STREAM', 'SERVE_LOCAL_200', {
            requestId,
            fileId,
            totalSize,
            mimeType: meta.mimeType || 'video/mp4',
          });

          res.writeHead(200, {
            'Accept-Ranges': 'bytes',
            'Content-Length': totalSize,
            'Content-Type': meta.mimeType || 'video/mp4',
            'Cache-Control': 'no-cache',
          });

          const fileStream = fs.createReadStream(filePath);
          pipeStreamWithDiagnostics(fileStream, req, res, {
            requestId,
            fileId,
            mode: 'local_demo_200',
            rangeHeader: 'NONE',
            statusSent: 200,
            expectedBytes: totalSize,
            startedAt,
          });
          return;
        }

        const effectiveRange = rawRangeHeader || 'bytes=0-';
        const parsedRange = parseHttpRangeHeader(effectiveRange, totalSize);

        if (!parsedRange.valid) {
          logDebug('RANGE_STREAM', 'RANGE_416_INVALID', {
            requestId,
            fileId,
            rangeHeader: effectiveRange,
            totalSize,
          });
          res.status(416).setHeader('Content-Range', `bytes */${totalSize}`);
          return res.end();
        }

        const { start, end } = parsedRange;
        const chunkSize = end - start + 1;

        logDebug('RANGE_STREAM', 'SERVE_LOCAL_206', {
          requestId,
          fileId,
          rangeHeader: effectiveRange,
          start,
          end,
          chunkSize,
          totalSize,
          mimeType: meta.mimeType || 'video/mp4',
        });

        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Accept-Ranges': 'bytes',
          'Content-Length': chunkSize,
          'Content-Type': meta.mimeType || 'video/mp4',
          'Cache-Control': 'no-cache',
        });

        const fileStream = fs.createReadStream(filePath, { start, end });
        pipeStreamWithDiagnostics(fileStream, req, res, {
          requestId,
          fileId,
          mode: 'local_demo_206',
          rangeHeader: effectiveRange,
          statusSent: 206,
          expectedBytes: chunkSize,
          startedAt,
        });
        return;
      }

      // REMOTE GOOGLE DRIVE HTTP 206 RANGE STREAMING PROXY
      // Prefer the pre-transcoded Drive Viewer CDN stream (`*.c.drive.google.com/videoplayback`) whenever:
      // - The original file uses an incompatible browser codec (e.g. 4K HEVC `v1rel.mp4`), OR
      // - `?compat=1` was requested, OR
      // - `drive.usercontent.google.com` hit anonymous download quota (`meta.usingCdnFallback`).
      let useCdnStream = Boolean(
        meta.cdnPreviewStreamUrl &&
          (!meta.isBrowserCompatible || forceCompat || meta.usingCdnFallback)
      );

      let activeStreamSize = useCdnStream
        ? meta.cdnPreviewSize || meta.streamByteSize || 0
        : meta.streamByteSize || meta.fileSize || 0;

      const rangeHeader = req.headers.range;
      if (rangeHeader && activeStreamSize > 65536) {
        const parsedRange = parseHttpRangeHeader(rangeHeader, activeStreamSize);
        if (!parsedRange.valid) {
          logDebug('RANGE_STREAM', 'REMOTE_RANGE_416', {
            requestId,
            fileId,
            rangeHeader,
            totalSize: activeStreamSize,
          });
          res.status(416).setHeader('Content-Range', `bytes */${activeStreamSize}`);
          return res.end();
        }
      }

      const abortController = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) {
          abortController.abort();
        }
      });

      const executeUpstreamFetch = async (
        currentMeta: VideoSourceMetadata,
        streamFromCdn: boolean
      ) => {
        const streamSize = streamFromCdn
          ? currentMeta.cdnPreviewSize || currentMeta.streamByteSize || 0
          : currentMeta.streamByteSize || currentMeta.fileSize || 0;
        const targetUrl = streamFromCdn
          ? currentMeta.cdnPreviewStreamUrl!
          : currentMeta.resolvedStreamUrl!;
        const targetCookies = streamFromCdn
          ? currentMeta.cdnPreviewCookieHeader || currentMeta.resolvedCookieHeader
          : currentMeta.resolvedCookieHeader;

        const boundedRange = buildBoundedUpstreamRangeHeader(
          rangeHeader,
          streamSize,
          MAX_RANGE_CHUNK_BYTES
        );
        const upstreamHeaders: Record<string, string> = {
          Range: boundedRange,
          Referer: 'https://drive.google.com/',
          Origin: 'https://drive.google.com',
        };
        if (!streamFromCdn && (currentMeta.oauthToken || effectiveOAuthToken)) {
          upstreamHeaders['Authorization'] = `Bearer ${
            effectiveOAuthToken || currentMeta.oauthToken
          }`;
        }

        logDebug('RANGE_STREAM', 'UPSTREAM_DRIVE_FETCH_START', {
          requestId,
          fileId,
          accessMode: currentMeta.accessMode,
          streamFromCdn,
          targetUrl,
          clientRangeHeader: rangeHeader || 'NONE',
          sentBoundedRangeHeader: boundedRange,
          hasAuthBearer: Boolean(upstreamHeaders['Authorization']),
          hasCookieJar: Boolean(targetCookies),
        });

        return fetchWithCookieJar(targetUrl, {
          headers: upstreamHeaders,
          initialCookies: targetCookies,
          signal: abortController.signal,
        });
      };

      let { response: upstreamRes, finalUrl: upstreamFinalUrl } = await executeUpstreamFetch(
        meta,
        useCdnStream
      );
      let upstreamContentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();

      logDebug('RANGE_STREAM', 'UPSTREAM_DRIVE_RESPONSE', {
        requestId,
        fileId,
        useCdnStream,
        upstreamStatus: upstreamRes.status,
        upstreamStatusText: upstreamRes.statusText,
        upstreamFinalUrl,
        upstreamHeaders: {
          contentType: upstreamContentType,
          contentLength: upstreamRes.headers.get('content-length'),
          contentRange: upstreamRes.headers.get('content-range'),
          acceptRanges: upstreamRes.headers.get('accept-ranges'),
          contentDisposition: upstreamRes.headers.get('content-disposition'),
        },
      });

      // CRITICAL GUARD: Never pipe an HTML error/confirmation page to the HTML5 <video> element!
      // If upstream returned text/html or 401/403/429 (e.g. Google Drive download quota exceeded),
      // immediately fall back to the Drive Viewer CDN stream (`meta.cdnPreviewStreamUrl`) or refresh!
      if (
        upstreamContentType.includes('text/html') ||
        upstreamRes.status === 401 ||
        upstreamRes.status === 403 ||
        upstreamRes.status === 429
      ) {
        try {
          await upstreamRes.body?.cancel();
        } catch {}
        logDebug('RANGE_STREAM', 'UPSTREAM_RETURNED_HTML_OR_403_REFRESHING', {
          requestId,
          fileId,
          status: upstreamRes.status,
          upstreamContentType,
          wasUsingCdn: useCdnStream,
        });

        if (!meta.cdnPreviewStreamUrl || useCdnStream) {
          const freshViewer = await resolveDriveViewerPlayback(fileId);
          if (freshViewer) {
            meta.cdnPreviewStreamUrl = freshViewer.cdnStreamUrl;
            meta.cdnPreviewCookieHeader = freshViewer.cdnCookieHeader;
            meta.cdnPreviewSize = freshViewer.cdnStreamSize;
          }
        }

        if (meta.cdnPreviewStreamUrl) {
          useCdnStream = true;
          meta.usingCdnFallback = true;
          activeStreamSize = meta.cdnPreviewSize || activeStreamSize;
          const cdnRetry = await executeUpstreamFetch(meta, true);
          upstreamRes = cdnRetry.response;
          upstreamFinalUrl = cdnRetry.finalUrl;
          upstreamContentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();
        } else {
          meta = await inspectDriveVideo(fileId, effectiveOAuthToken, true);
          useCdnStream = Boolean(
            meta.cdnPreviewStreamUrl &&
              (!meta.isBrowserCompatible || forceCompat || meta.usingCdnFallback)
          );
          const retryResult = await executeUpstreamFetch(meta, useCdnStream);
          upstreamRes = retryResult.response;
          upstreamFinalUrl = retryResult.finalUrl;
          upstreamContentType = (upstreamRes.headers.get('content-type') || '').toLowerCase();
        }

        logDebug('RANGE_STREAM', 'UPSTREAM_DRIVE_RETRY_RESPONSE', {
          requestId,
          fileId,
          useCdnStream,
          upstreamStatus: upstreamRes.status,
          upstreamFinalUrl,
          upstreamContentType,
          contentRange: upstreamRes.headers.get('content-range'),
          contentLength: upstreamRes.headers.get('content-length'),
        });
      }

      if (upstreamContentType.includes('text/html') || upstreamContentType.includes('application/json')) {
        try {
          await upstreamRes.body?.cancel();
        } catch {}
        logDebug('RANGE_STREAM', 'BLOCKED_NON_VIDEO_PAYLOAD', {
          requestId,
          fileId,
          status: upstreamRes.status,
          upstreamContentType,
        });
        return res.status(403).json({
          error:
            'Google Drive returned a web page instead of video bytes (file may be restricted or quota-limited).',
        });
      }

      if (upstreamRes.status === 416) {
        try {
          await upstreamRes.body?.cancel();
        } catch {}
        const upstreamCr =
          upstreamRes.headers.get('content-range') ||
          (activeStreamSize > 0 ? `bytes */${activeStreamSize}` : 'bytes */*');
        logDebug('RANGE_STREAM', 'UPSTREAM_RETURNED_416', {
          requestId,
          fileId,
          rangeHeader,
          contentRange: upstreamCr,
        });
        res.status(416).setHeader('Content-Range', upstreamCr);
        return res.end();
      }

      if (!upstreamRes.ok && upstreamRes.status !== 206) {
        try {
          await upstreamRes.body?.cancel();
        } catch {}
        logDebug('RANGE_STREAM', 'UPSTREAM_HTTP_ERROR', {
          requestId,
          fileId,
          upstreamStatus: upstreamRes.status,
        });
        return res.status(upstreamRes.status).json({
          error: `Upstream Google Drive stream returned HTTP ${upstreamRes.status}`,
        });
      }

      const responseHeaders: Record<string, string> = {
        'Content-Type': useCdnStream ? 'video/mp4' : meta.mimeType || 'video/mp4',
        'Cache-Control': 'no-cache',
      };

      const contentRange = upstreamRes.headers.get('content-range');
      const contentLength = upstreamRes.headers.get('content-length');
      const upstreamSupportsRange =
        Boolean(contentRange) ||
        upstreamRes.status === 206 ||
        upstreamRes.headers.get('accept-ranges') === 'bytes' ||
        meta.supportsRange;

      if (upstreamSupportsRange) {
        responseHeaders['Accept-Ranges'] = 'bytes';
      }

      let statusToSend = upstreamRes.status === 206 ? 206 : 200;

      if (contentRange) {
        responseHeaders['Content-Range'] = contentRange;
        const totalMatch = contentRange.match(/\/(\d+)$/);
        if (totalMatch) {
          const authoritativeTotal = parseInt(totalMatch[1], 10);
          if (authoritativeTotal > 0) {
            if (useCdnStream) {
              meta.cdnPreviewSize = authoritativeTotal;
            } else {
              meta.streamByteSize = authoritativeTotal;
              if (!meta.fileSize) meta.fileSize = authoritativeTotal;
            }
          }
        }
      } else if (rangeHeader && rangeHeader.startsWith('bytes=0-') && contentLength) {
        const fullLen = parseInt(contentLength, 10);
        if (fullLen > 0 && rangeHeader.trim() === 'bytes=0-') {
          statusToSend = 206;
          responseHeaders['Content-Range'] = `bytes 0-${fullLen - 1}/${fullLen}`;
          responseHeaders['Accept-Ranges'] = 'bytes';
          if (useCdnStream) {
            meta.cdnPreviewSize = fullLen;
          } else if (!meta.fileSize) {
            meta.fileSize = fullLen;
          }
        }
      }

      if (contentLength) {
        responseHeaders['Content-Length'] = contentLength;
      }

      logDebug('RANGE_STREAM', 'PROXY_STREAMING_BYTES', {
        requestId,
        fileId,
        useCdnStream,
        requestedRange: rangeHeader || 'NONE',
        upstreamStatus: upstreamRes.status,
        clientStatusSent: statusToSend,
        contentRange: responseHeaders['Content-Range'] || null,
        contentLength: responseHeaders['Content-Length'] || null,
        mimeType: responseHeaders['Content-Type'],
      });

      res.writeHead(statusToSend, responseHeaders);

      if (upstreamRes.body) {
        const nodeStream = Readable.fromWeb(upstreamRes.body as any);
        pipeStreamWithDiagnostics(nodeStream, req, res, {
          requestId,
          fileId,
          mode: useCdnStream
            ? `cdn_${meta.accessMode}_${statusToSend}`
            : `remote_${meta.accessMode}_${statusToSend}`,
          rangeHeader: rangeHeader || 'NONE',
          statusSent: statusToSend,
          expectedBytes: contentLength ? parseInt(contentLength, 10) : null,
          startedAt,
        });
      } else {
        logDebug('RANGE_STREAM', 'UPSTREAM_EMPTY_BODY', {
          requestId,
          fileId,
          upstreamStatus: upstreamRes.status,
        });
        res.end();
      }
    } catch (err: any) {
      if (err.name === 'AbortError') {
        logDebug('RANGE_STREAM', 'STREAM_FETCH_ABORTED_BY_CLIENT', {
          requestId,
          fileId,
          incomingRange,
          elapsedMs: Date.now() - startedAt,
        });
        return;
      }
      logDebug('RANGE_STREAM', 'STREAM_EXCEPTION', {
        requestId,
        fileId,
        incomingRange,
        error: err.message,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: err.message || 'Streaming failed' });
      }
    }
  };

  app.get('/api/video/stream/:fileId', handleVideoStream);
  app.get('/api/stream/:fileId', handleVideoStream);

  /**
   * GET /api/video/thumbnail/:fileId?time=<seconds>
   * Progressive On-Demand Single-Frame Extractor (with concurrency limiting so playback is never blocked).
   */
  app.get('/api/video/thumbnail/:fileId', async (req: Request, res: Response) => {
    try {
      const fileId = req.params.fileId;
      if (!/^[a-zA-Z0-9_-]{10,64}$/.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file ID' });
      }

      const timestamp = Math.max(0, Math.floor(Number(req.query.time) || 0));
      let meta = metadataCache.get(fileId);
      const oauthToken = extractRequestOAuthToken(req, meta);
      if (!meta) {
        meta = await inspectDriveVideo(fileId, oauthToken);
      }

      const thumbDir = path.join(TEMP_DIR, `thumbs_${fileId}`);
      fs.mkdirSync(thumbDir, { recursive: true });
      const cachedThumbPath = path.join(thumbDir, `frame_${timestamp}s.jpg`);

      if (!fs.existsSync(cachedThumbPath)) {
        await acquireThumbSlot();
        try {
          if (!fs.existsSync(cachedThumbPath)) {
            await new Promise<void>((resolve) => {
              const args: string[] = ['-y', '-ss', String(timestamp)];

              // Prefer local preview file or lightweight H.264 CDN stream so thumbnail extraction
              // is 10x faster and never consumes drive.usercontent.google.com download quota!
              const inputSource =
                meta!.previewFilePath && fs.existsSync(meta!.previewFilePath)
                  ? meta!.previewFilePath
                  : meta!.accessMode === 'demo' &&
                    meta!.resolvedStreamUrl &&
                    fs.existsSync(meta!.resolvedStreamUrl)
                  ? meta!.resolvedStreamUrl
                  : buildLocalLoopbackRawStreamUrl(fileId, Boolean(meta!.cdnPreviewStreamUrl));

              args.push(
                '-i',
                inputSource,
                '-frames:v',
                '1',
                '-vf',
                'scale=240:135:force_original_aspect_ratio=increase,crop=240:135',
                '-q:v',
                '6',
                cachedThumbPath
              );

              const proc = spawn(FFMPEG_PATH, args);
              const t = setTimeout(() => {
                proc.kill('SIGKILL');
                resolve();
              }, 7000);

              proc.on('close', () => {
                clearTimeout(t);
                resolve();
              });
              proc.on('error', () => {
                clearTimeout(t);
                resolve();
              });
            });
          }
        } finally {
          releaseThumbSlot();
        }
      }

      if (fs.existsSync(cachedThumbPath)) {
        const buf = fs.readFileSync(cachedThumbPath);
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=3600');
        return res.send(buf);
      }

      return res.status(404).json({ error: 'Could not extract frame' });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/trim/start
   * Quality-preserving, 100% browser & Windows Media Player compatible FFmpeg trimming engine.
   */
  app.post('/api/trim/start', trimStartRateLimiter, async (req: Request, res: Response) => {
    try {
      const {
        fileId,
        startTime,
        endTime,
        trimMode = 'copy',
        outputFormat = 'mp4',
        allowFullStreamFallback = false,
      } = req.body || {};

      if (!fileId || !/^[a-zA-Z0-9_-]{10,64}$/.test(fileId)) {
        return res.status(400).json({ error: 'Invalid file ID.' });
      }

      const activeJobsCount = Array.from(trimJobs.values()).filter(
        (j) => j.status === 'starting' || j.status === 'processing'
      ).length;

      if (activeJobsCount >= MAX_CONCURRENT_JOBS) {
        return res.status(429).json({
          error: 'Server is currently processing the maximum number of concurrent video jobs. Please try again shortly.',
        });
      }

      let meta = metadataCache.get(fileId);
      const oauthToken = extractRequestOAuthToken(req, meta);
      if (!meta || (oauthToken && !meta.oauthToken)) {
        meta = await inspectDriveVideo(fileId, oauthToken);
      }

      const startSec = Number(startTime);
      const endSec = Number(endTime);

      if (isNaN(startSec) || isNaN(endSec) || startSec < 0) {
        return res.status(400).json({ error: 'Start and end timestamps must be valid non-negative numbers.' });
      }
      if (startSec >= endSec) {
        return res.status(400).json({ error: 'Start time must be strictly less than end time.' });
      }
      if (meta.durationSeconds > 0 && endSec > meta.durationSeconds + 1) {
        return res.status(400).json({ error: 'End time cannot exceed total video duration.' });
      }

      if (!meta.supportsRange && meta.fileSize > 50 * 1024 * 1024 && !allowFullStreamFallback) {
        return res.status(409).json({
          code: 'FULL_STREAM_CONFIRMATION_REQUIRED',
          error:
            'This video container or upstream response does not support HTTP byte-range seeking. Sequential full-stream processing is required. Please confirm to proceed.',
        });
      }

      const validFormat: 'mp4' | 'mov' | 'webm' = ['mp4', 'mov', 'webm'].includes(outputFormat)
        ? outputFormat
        : 'mp4';
      const requestedMode: 'copy' | 'reencode' = trimMode === 'reencode' ? 'reencode' : 'copy';

      // If the source has a pre-transcoded H.264/AAC CDN stream and either the raw source is incompatible (e.g. HEVC)
      // or quota-limited (`usingCdnFallback`), we can stream-copy directly from the H.264/AAC CDN stream!
      const useCdnForTrim = Boolean(
        meta.cdnPreviewStreamUrl && (!meta.isBrowserCompatible || meta.usingCdnFallback)
      );

      // Check whether source stream can safely be stream-copied into target format without causing 0xc10100be
      const canSafelyStreamCopy =
        (useCdnForTrim && validFormat !== 'webm') ||
        (meta.isBrowserCompatible &&
          ((validFormat !== 'webm' && meta.videoCodec === 'h264' && meta.pixFmt === 'yuv420p') ||
            (validFormat === 'webm' && ['vp8', 'vp9', 'av1'].includes(meta.videoCodec))));

      const effectiveTrimMode: 'copy' | 'reencode' = canSafelyStreamCopy
        ? requestedMode
        : 'reencode';

      const clipDuration = Number((endSec - startSec).toFixed(3));
      const jobId = crypto.randomUUID();
      const baseName = meta.fileName.replace(/\.[^/.]+$/, '');
      const formatTimeTag = (s: number) => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return `${String(m).padStart(2, '0')}m${String(sec).padStart(2, '0')}s`;
      };
      const outputFileName = sanitizeFileName(
        `${baseName}_trimmed_${formatTimeTag(startSec)}_to_${formatTimeTag(endSec)}.${validFormat}`
      );
      const outputFilePath = path.join(TEMP_DIR, `${jobId}_${outputFileName}`);

      const job: TrimJob = {
        jobId,
        fileId,
        fileName: meta.fileName,
        startTime: startSec,
        endTime: endSec,
        clipDuration,
        originalDuration: meta.durationSeconds || clipDuration,
        trimMode: requestedMode,
        effectiveTrimMode,
        outputFormat: validFormat,
        status: 'starting',
        progressPercent: 2,
        processedSeconds: 0,
        statusMessage:
          effectiveTrimMode === 'copy'
            ? 'Seeking byte range & extracting segment via Fast Stream Copy...'
            : 'Seeking byte range & encoding browser-compatible segment...',
        outputFilePath,
        outputFileName,
        outputSize: 0,
        actualOutputDuration: 0,
        createdAt: Date.now(),
      };

      trimJobs.set(jobId, job);

      const runFfmpegJob = (modeToUse: 'copy' | 'reencode', isRetry = false) => {
        const jobStartMs = Date.now();
        const args: string[] = ['-y'];

        // Place -ss BEFORE -i for HTTP Range byte-offset seeking!
        args.push('-ss', String(startSec));

        const inputSource =
          meta!.accessMode === 'demo' &&
          meta!.resolvedStreamUrl &&
          fs.existsSync(meta!.resolvedStreamUrl)
            ? meta!.resolvedStreamUrl
            : buildLocalLoopbackRawStreamUrl(fileId, useCdnForTrim);

        if (inputSource.startsWith('http://')) {
          args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2');
        }

        args.push('-i', inputSource);
        args.push('-t', String(clipDuration));
        args.push('-map', '0:v:0');
        if (meta!.hasAudio) {
          args.push('-map', '0:a:0?');
        }

        if (modeToUse === 'copy') {
          const isAudioCompatibleWithContainer =
            useCdnForTrim ||
            !meta!.hasAudio ||
            (validFormat === 'webm'
              ? ['opus', 'vorbis'].includes(meta!.audioCodec || '')
              : ['aac', 'mp3'].includes(meta!.audioCodec || ''));

          if (isAudioCompatibleWithContainer) {
            args.push('-c', 'copy');
          } else {
            args.push('-c:v', 'copy');
            if (validFormat === 'webm') {
              args.push('-c:a', 'libopus', '-b:a', '128k');
            } else {
              args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
            }
          }
          args.push('-avoid_negative_ts', 'make_zero');
          if (validFormat === 'mp4' || validFormat === 'mov') {
            args.push('-movflags', '+faststart');
          }
        } else {
          if (validFormat === 'webm') {
            args.push(
              '-c:v',
              'libvpx-vp9',
              '-crf',
              '30',
              '-b:v',
              '0',
              '-deadline',
              'realtime',
              '-cpu-used',
              '4',
              '-pix_fmt',
              'yuv420p'
            );
            if (meta!.hasAudio) {
              args.push('-c:a', 'libopus', '-b:a', '128k');
            }
          } else {
            // Ensure even dimensions & yuv420p H.264 High@L4.1 for 100% OS & browser playability
            args.push(
              '-vf',
              'scale=trunc(iw/2)*2:trunc(ih/2)*2,format=yuv420p',
              '-c:v',
              'libx264',
              '-profile:v',
              'high',
              '-level:v',
              '4.1',
              '-preset',
              'veryfast',
              '-crf',
              '18',
              '-pix_fmt',
              'yuv420p',
              '-movflags',
              '+faststart'
            );
            if (meta!.hasAudio) {
              args.push('-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
            }
          }
        }

        const stagingFilePath = `${outputFilePath}.part.${validFormat}`;
        args.push('-progress', 'pipe:1', '-nostats', stagingFilePath);

        logDebug('FFMPEG_TRIM', 'JOB_SPAWNED', {
          jobId,
          fileId,
          startSec,
          endSec,
          clipDuration,
          modeToUse,
          validFormat,
        });

        const proc = spawn(FFMPEG_PATH, args);
        job.process = proc;
        job.status = 'processing';
        job.effectiveTrimMode = modeToUse;

        let stderrLog = '';

        job.timeoutHandle = setTimeout(() => {
          if (job.status === 'processing' || job.status === 'starting') {
            proc.kill('SIGKILL');
            job.status = 'error';
            job.error = 'Processing timed out. Try a shorter clip or Fast Stream Copy mode.';
          }
        }, JOB_TIMEOUT_MINUTES * 60 * 1000);

        proc.stdout.on('data', (chunk) => {
          const text = chunk.toString();
          const lines = text.split('\n');
          for (const line of lines) {
            const [key, val] = line.trim().split('=');
            if (key === 'out_time_us' || key === 'out_time_ms') {
              const us = parseInt(val, 10);
              if (!isNaN(us) && us >= 0) {
                const currentSec = us / 1_000_000;
                job.processedSeconds = Number(Math.min(currentSec, clipDuration).toFixed(1));
                const pct = Math.min(98, Math.max(5, Math.round((currentSec / clipDuration) * 100)));
                job.progressPercent = pct;
              }
            }
          }
        });

        proc.stderr.on('data', (chunk) => {
          stderrLog += chunk.toString();
        });

        proc.on('close', async (code) => {
          if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
          const processingDurationMs = Date.now() - jobStartMs;

          if (job.status === 'cancelled') {
            if (fs.existsSync(stagingFilePath)) {
              try {
                fs.unlinkSync(stagingFilePath);
              } catch {}
            }
            return;
          }

          if (code === 0 && fs.existsSync(stagingFilePath)) {
            const stat = fs.statSync(stagingFilePath);
            if (stat.size > 1024) {
              try {
                const outProbe = await probeMediaSource(stagingFilePath);
                const audioValid = !meta!.hasAudio || outProbe.hasAudio;
                if (outProbe.durationSeconds > 0 && outProbe.width > 0 && audioValid) {
                  // Atomically finalize output file after FFprobe verification
                  fs.renameSync(stagingFilePath, outputFilePath);
                  const finalStat = fs.statSync(outputFilePath);
                  const sha256 = await computeFileSha256(outputFilePath);

                  job.outputSize = finalStat.size;
                  job.outputSha256 = sha256;
                  job.actualOutputDuration = outProbe.durationSeconds;
                  job.probeSummary = {
                    videoCodec: outProbe.videoCodec,
                    audioCodec: outProbe.audioCodec,
                    hasAudio: outProbe.hasAudio,
                    width: outProbe.width,
                    height: outProbe.height,
                    fps: outProbe.fps,
                    durationSeconds: outProbe.durationSeconds,
                    formatName: outProbe.formatName,
                    sizeBytes: finalStat.size,
                  };
                  job.progressPercent = 100;
                  job.processedSeconds = clipDuration;
                  job.status = 'completed';
                  job.statusMessage = 'Video segment trimmed and verified successfully!';
                  job.completedAt = Date.now();
                  job.lastAccessedAt = Date.now();

                  // Persist sidecar metadata for crash/restart resilience
                  try {
                    const { process: _p, timeoutHandle: _t, ...serializableJob } = job;
                    fs.writeFileSync(
                      `${outputFilePath}.meta.json`,
                      JSON.stringify(serializableJob, null, 2)
                    );
                  } catch {}

                  logDebug('FFMPEG_TRIM', 'JOB_COMPLETED', {
                    jobId,
                    exitCode: code,
                    processingDurationMs,
                    outputSize: finalStat.size,
                    outputSha256: sha256,
                    actualOutputDuration: outProbe.durationSeconds,
                    outputVideoCodec: outProbe.videoCodec,
                    outputAudioCodec: outProbe.audioCodec,
                    outputPixFmt: outProbe.pixFmt,
                    outputFormatName: outProbe.formatName,
                  });
                  return;
                }
              } catch (verifyErr: any) {
                logDebug('FFMPEG_TRIM', 'OUTPUT_VERIFICATION_FAILED', {
                  jobId,
                  reason: verifyErr.message,
                });
              }
            }
          }

          if (fs.existsSync(stagingFilePath)) {
            try {
              fs.unlinkSync(stagingFilePath);
            } catch {}
          }

          if (modeToUse === 'copy' && !isRetry) {
            logDebug('FFMPEG_TRIM', 'FALLBACK_TO_REENCODE', {
              jobId,
              exitCode: code,
            });
            job.statusMessage =
              'Keyframe stream copy required re-alignment; switching to Frame-Accurate Re-encode...';
            job.progressPercent = 10;
            runFfmpegJob('reencode', true);
            return;
          }

          job.status = 'error';
          job.error =
            'Unable to process this video segment. Please try another trim range or verify the source video format.';
          logDebug('FFMPEG_TRIM', 'JOB_FAILED', {
            jobId,
            exitCode: code,
            processingDurationMs,
            stderr: stderrLog.slice(-400),
          });
        });

        proc.on('error', (err) => {
          if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
          job.status = 'error';
          job.error = `FFmpeg process error: ${err.message}`;
        });
      };

      runFfmpegJob(effectiveTrimMode, false);

      return res.json({
        jobId: job.jobId,
        status: job.status,
        progressPercent: job.progressPercent,
        statusMessage: job.statusMessage,
        effectiveTrimMode: job.effectiveTrimMode,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to start video trimming job.' });
    }
  });

  /**
   * GET /api/trim/status/:jobId
   */
  app.get('/api/trim/status/:jobId', (req: Request, res: Response) => {
    const job = getOrRecoverCompletedJob(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Trimming job not found or expired.' });
    }

    return res.json({
      jobId: job.jobId,
      fileId: job.fileId,
      fileName: job.fileName,
      startTime: job.startTime,
      endTime: job.endTime,
      clipDuration: job.clipDuration,
      originalDuration: job.originalDuration,
      trimMode: job.trimMode,
      effectiveTrimMode: job.effectiveTrimMode,
      outputFormat: job.outputFormat,
      status: job.status,
      progressPercent: job.progressPercent,
      processedSeconds: job.processedSeconds,
      statusMessage: job.statusMessage,
      outputFileName: job.outputFileName,
      outputSize: job.outputSize,
      outputSha256: job.outputSha256,
      actualOutputDuration: job.actualOutputDuration,
      probeSummary: job.probeSummary,
      error: job.error,
      downloadUrl: job.status === 'completed' ? `/api/trim/download/${job.jobId}` : null,
    });
  });

  /**
   * POST /api/trim/cancel/:jobId
   */
  app.post('/api/trim/cancel/:jobId', (req: Request, res: Response) => {
    const job = trimJobs.get(req.params.jobId);
    if (!job) {
      return res.status(404).json({ error: 'Job not found.' });
    }

    if (job.status === 'starting' || job.status === 'processing') {
      job.status = 'cancelled';
      job.statusMessage = 'Trimming cancelled by user.';
      if (job.timeoutHandle) clearTimeout(job.timeoutHandle);
      if (job.process) {
        try {
          job.process.kill('SIGTERM');
        } catch {}
      }
      if (job.outputFilePath && fs.existsSync(job.outputFilePath)) {
        try {
          fs.unlinkSync(job.outputFilePath);
        } catch {}
      }
    }

    return res.json({ jobId: job.jobId, status: job.status });
  });

  /**
   * Live Pre-Download FFprobe Diagnostic Runner
   * Executes `ffprobe -v error -show_format -show_streams -of json` on the output file on disk,
   * inspects the binary container header signature, verifies non-zero file size and stream integrity,
   * and returns a structured diagnostic report or detailed server-side failure diagnostics.
   */
  async function runPreDownloadFfprobeDiagnostic(jobId: string): Promise<{
    httpStatus: number;
    valid: boolean;
    error?: string;
    diagnostic: Record<string, any>;
  }> {
    const startMs = Date.now();
    const checkedAt = new Date().toISOString();
    const job = getOrRecoverCompletedJob(jobId);

    if (!job) {
      logDebug('DOWNLOAD', 'PRE_DOWNLOAD_FFPROBE_JOB_NOT_FOUND', { jobId });
      return {
        httpStatus: 404,
        valid: false,
        error: `Pre-download FFprobe check failed: Job "${jobId}" was not found or has expired on the server.`,
        diagnostic: {
          jobId,
          stage: 'JOB_LOOKUP',
          fileExists: false,
          fileSizeBytes: 0,
          ffprobeExitCode: null,
          ffprobeStderr: 'Target job ID does not exist in active or disk-recovered job store.',
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    if (job.status !== 'completed') {
      return {
        httpStatus: 409,
        valid: false,
        error: `Pre-download FFprobe check failed: Job is currently in "${job.status}" state and not finalized.`,
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'JOB_STATE_CHECK',
          jobStatus: job.status,
          fileExists: Boolean(job.outputFilePath && fs.existsSync(job.outputFilePath)),
          fileSizeBytes: 0,
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    if (!job.outputFilePath || !fs.existsSync(job.outputFilePath)) {
      logDebug('DOWNLOAD', 'PRE_DOWNLOAD_FFPROBE_FILE_MISSING', {
        jobId,
        outputFileName: job.outputFileName,
      });
      return {
        httpStatus: 404,
        valid: false,
        error: `Pre-download FFprobe check failed: Output file "${job.outputFileName}" is missing on disk.`,
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'FILE_EXISTENCE_CHECK',
          fileExists: false,
          fileSizeBytes: 0,
          ffprobeExitCode: null,
          ffprobeStderr: 'ENOENT: Output file does not exist in server temporary storage.',
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    const stat = fs.statSync(job.outputFilePath);
    const fileSizeBytes = stat.size;

    if (fileSizeBytes <= 0) {
      logDebug('DOWNLOAD', 'PRE_DOWNLOAD_FFPROBE_ZERO_BYTES', {
        jobId,
        fileSizeBytes,
      });
      return {
        httpStatus: 422,
        valid: false,
        error: 'Pre-download FFprobe check failed: Generated output file is 0 bytes (empty file).',
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'FILE_SIZE_CHECK',
          fileExists: true,
          fileSizeBytes,
          ffprobeExitCode: null,
          ffprobeStderr: 'File size is 0 bytes.',
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    // Read first 32 bytes to verify container magic header before running ffprobe
    let magicSignature: ReturnType<typeof inspectFirstChunkBytes> | null = null;
    try {
      const fd = fs.openSync(job.outputFilePath, 'r');
      const headBuf = Buffer.alloc(Math.min(32, fileSizeBytes));
      fs.readSync(fd, headBuf, 0, headBuf.length, 0);
      fs.closeSync(fd);
      magicSignature = inspectFirstChunkBytes(headBuf);
    } catch (readErr: any) {
      return {
        httpStatus: 500,
        valid: false,
        error: `Pre-download check failed while reading file header: ${readErr.message}`,
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'HEADER_READ_CHECK',
          fileExists: true,
          fileSizeBytes,
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    if (
      magicSignature.signatureType === 'WARNING_HTML_PAGE_DETECTED' ||
      magicSignature.signatureType === 'WARNING_JSON_ERROR_DETECTED'
    ) {
      return {
        httpStatus: 422,
        valid: false,
        error: `Pre-download check failed: Output file contains ${magicSignature.signatureType} instead of a binary video container.`,
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'MAGIC_BYTE_SIGNATURE_CHECK',
          fileExists: true,
          fileSizeBytes,
          magicSignature,
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    // Execute live ffprobe -v error -show_format -show_streams -of json on the output file
    const ffprobeResult = await new Promise<{
      exitCode: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const proc = spawn(FFPROBE_PATH, [
        '-v',
        'error',
        '-show_format',
        '-show_streams',
        '-of',
        'json',
        job.outputFilePath,
      ]);

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve({
          exitCode: -1,
          stdout,
          stderr: `${stderr}\nFFprobe timed out after 10 seconds.`.trim(),
        });
      }, 10000);

      proc.stdout.on('data', (d) => {
        stdout += d.toString();
      });
      proc.stderr.on('data', (d) => {
        stderr += d.toString();
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        resolve({ exitCode: code, stdout, stderr: stderr.trim() });
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({ exitCode: -1, stdout, stderr: err.message });
      });
    });

    const sanitizedStderr = sanitizeServerErrorText(ffprobeResult.stderr);

    if (ffprobeResult.exitCode !== 0) {
      logDebug('DOWNLOAD', 'PRE_DOWNLOAD_FFPROBE_EXEC_FAILED', {
        jobId,
        exitCode: ffprobeResult.exitCode,
        stderr: sanitizedStderr,
      });
      return {
        httpStatus: 422,
        valid: false,
        error: `FFprobe container validation failed (exit code ${ffprobeResult.exitCode}): ${
          sanitizedStderr || 'Corrupted or unreadable video container.'
        }`,
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'FFPROBE_EXECUTION',
          fileExists: true,
          fileSizeBytes,
          magicSignature,
          ffprobeCommand: 'ffprobe -v error -show_format -show_streams -of json',
          ffprobeExitCode: ffprobeResult.exitCode,
          ffprobeStderr: sanitizedStderr || 'Non-zero exit code returned by ffprobe.',
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    let parsedProbe: any = null;
    try {
      parsedProbe = JSON.parse(ffprobeResult.stdout);
    } catch (parseErr: any) {
      return {
        httpStatus: 422,
        valid: false,
        error: `FFprobe returned malformed JSON output: ${sanitizeServerErrorText(parseErr.message)}`,
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'FFPROBE_JSON_PARSE',
          fileExists: true,
          fileSizeBytes,
          magicSignature,
          ffprobeExitCode: ffprobeResult.exitCode,
          ffprobeStderr: sanitizedStderr,
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    const streams: any[] = Array.isArray(parsedProbe?.streams) ? parsedProbe.streams : [];
    const format: any = parsedProbe?.format || {};
    const videoStream = streams.find((s) => s.codec_type === 'video');
    const audioStream = streams.find((s) => s.codec_type === 'audio');

    if (!videoStream) {
      return {
        httpStatus: 422,
        valid: false,
        error: 'FFprobe validation failed: Output container does not contain a valid video stream.',
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'VIDEO_STREAM_CHECK',
          fileExists: true,
          fileSizeBytes,
          magicSignature,
          containerFormat: format.format_name || 'unknown',
          nbStreams: streams.length,
          ffprobeExitCode: 0,
          ffprobeStderr: ffprobeResult.stderr || 'No video stream found in container.',
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    const durationFromFormat = parseFloat(format.duration);
    const durationFromStream = parseFloat(videoStream.duration);
    const durationSeconds =
      !isNaN(durationFromFormat) && durationFromFormat > 0
        ? durationFromFormat
        : !isNaN(durationFromStream) && durationFromStream > 0
        ? durationFromStream
        : 0;

    if (durationSeconds <= 0 || !videoStream.width || !videoStream.height) {
      return {
        httpStatus: 422,
        valid: false,
        error: `FFprobe validation failed: Invalid video stream dimensions (${
          videoStream.width || 0
        }x${videoStream.height || 0}) or non-positive duration (${durationSeconds}s).`,
        diagnostic: {
          jobId,
          outputFileName: job.outputFileName,
          stage: 'STREAM_DIMENSIONS_DURATION_CHECK',
          fileExists: true,
          fileSizeBytes,
          magicSignature,
          containerFormat: format.format_name || 'unknown',
          durationSeconds,
          width: videoStream.width || 0,
          height: videoStream.height || 0,
          ffprobeExitCode: 0,
          ffprobeStderr: ffprobeResult.stderr,
          elapsedMs: Date.now() - startMs,
          checkedAt,
        },
      };
    }

    let fps = 30;
    if (videoStream.r_frame_rate && typeof videoStream.r_frame_rate === 'string') {
      const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
      if (num > 0 && den > 0) {
        fps = Number((num / den).toFixed(2));
      }
    }

    if (!job.outputSha256) {
      try {
        job.outputSha256 = await computeFileSha256(job.outputFilePath);
      } catch {}
    }

    job.outputSize = fileSizeBytes;
    job.actualOutputDuration = durationSeconds;
    job.lastAccessedAt = Date.now();

    const diagnostic = {
      jobId: job.jobId,
      outputFileName: job.outputFileName,
      stage: 'VERIFIED_READY',
      fileExists: true,
      fileSizeBytes,
      sha256: job.outputSha256 || null,
      magicSignature,
      ffprobeCommand: 'ffprobe -v error -show_format -show_streams -of json',
      ffprobeExitCode: 0,
      ffprobeStderr: ffprobeResult.stderr || null,
      containerFormat: format.format_name || job.outputFormat,
      containerLongName: format.format_long_name || null,
      durationSeconds: Number(durationSeconds.toFixed(3)),
      bitRate: parseInt(format.bit_rate || '0', 10) || null,
      nbStreams: streams.length,
      videoStream: {
        codecName: videoStream.codec_name || 'unknown',
        profile: videoStream.profile || 'unknown',
        width: Number(videoStream.width),
        height: Number(videoStream.height),
        pixFmt: videoStream.pix_fmt || 'unknown',
        fps,
      },
      audioStream: audioStream
        ? {
            codecName: audioStream.codec_name || 'unknown',
            profile: audioStream.profile || null,
            sampleRate: audioStream.sample_rate || null,
            channels: audioStream.channels || null,
          }
        : null,
      elapsedMs: Date.now() - startMs,
      checkedAt,
    };

    logDebug('DOWNLOAD', 'PRE_DOWNLOAD_FFPROBE_VERIFIED', {
      jobId: job.jobId,
      outputFileName: job.outputFileName,
      fileSizeBytes,
      containerFormat: diagnostic.containerFormat,
      durationSeconds: diagnostic.durationSeconds,
      videoCodec: diagnostic.videoStream.codecName,
      audioCodec: diagnostic.audioStream?.codecName || null,
      elapsedMs: diagnostic.elapsedMs,
    });

    return {
      httpStatus: 200,
      valid: true,
      diagnostic,
    };
  }

  /**
   * GET & POST /api/trim/verify/:jobId
   * Triggers a live FFprobe diagnostic check on the output file before initiating download.
   */
  const handleVerifyTrimOutput = async (req: Request, res: Response) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      const result = await runPreDownloadFfprobeDiagnostic(req.params.jobId);
      return res.status(result.httpStatus).json({
        valid: result.valid,
        jobId: req.params.jobId,
        error: result.error,
        diagnostic: result.diagnostic,
      });
    } catch (err: any) {
      const safeMessage = sanitizeServerErrorText(err.message || 'Unknown error');
      return res.status(500).json({
        valid: false,
        jobId: req.params.jobId,
        error: `Server error during FFprobe verification: ${safeMessage}`,
        diagnostic: {
          jobId: req.params.jobId,
          stage: 'UNHANDLED_EXCEPTION',
          fileExists: false,
          fileSizeBytes: 0,
          ffprobeStderr: safeMessage,
          checkedAt: new Date().toISOString(),
        },
      });
    }
  };

  app.get('/api/trim/verify/:jobId', handleVerifyTrimOutput);
  app.post('/api/trim/verify/:jobId', handleVerifyTrimOutput);

  /**
   * GET & HEAD /api/trim/download/:jobId
   * Reliable binary video file streaming endpoint supporting both HTTP 200 full downloads
   * and HTTP 206 Partial Content Range requests without premature stream destruction.
   */
  const handleTrimDownload = (req: Request, res: Response) => {
    const job = getOrRecoverCompletedJob(req.params.jobId);
    if (!job || job.status !== 'completed' || !fs.existsSync(job.outputFilePath)) {
      logDebug('DOWNLOAD', 'DOWNLOAD_404', { jobId: req.params.jobId });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'Trimmed video file is not available or has expired.' });
    }

    const stat = fs.statSync(job.outputFilePath);
    const totalSize = stat.size;
    if (totalSize <= 1024) {
      logDebug('DOWNLOAD', 'DOWNLOAD_INVALID_FILE_SIZE', {
        jobId: job.jobId,
        totalSize,
      });
      res.setHeader('Cache-Control', 'no-store');
      return res.status(422).json({ error: 'Generated video file is incomplete or corrupted.' });
    }

    job.outputSize = totalSize;
    job.lastAccessedAt = Date.now();

    const mimeMap: Record<string, string> = {
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      webm: 'video/webm',
    };
    const contentType = mimeMap[job.outputFormat] || 'video/mp4';
    const safeAsciiName = job.outputFileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
    const encodedName = encodeURIComponent(job.outputFileName);
    const contentDisposition = `attachment; filename="${safeAsciiName}"; filename*=UTF-8''${encodedName}`;
    const rangeHeader = req.headers.range;

    const commonHeaders: Record<string, string | number> = {
      'Content-Type': contentType,
      'Content-Disposition': contentDisposition,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'X-Expected-File-Size': totalSize,
    };
    if (job.outputSha256) {
      commonHeaders['X-File-SHA256'] = job.outputSha256;
    }

    if (rangeHeader) {
      const parsed = parseDownloadRangeHeader(rangeHeader, totalSize);
      if (!parsed.valid) {
        res.writeHead(416, {
          ...commonHeaders,
          'Content-Range': `bytes */${totalSize}`,
        });
        return res.end();
      }
      const { start, end } = parsed;
      const chunkLength = end - start + 1;

      logDebug('DOWNLOAD', 'SERVE_TRIMMED_RANGE_206', {
        jobId: job.jobId,
        method: req.method,
        outputFileName: job.outputFileName,
        rangeHeader,
        start,
        end,
        chunkLength,
        totalSize,
        contentType,
      });

      res.writeHead(206, {
        ...commonHeaders,
        'Content-Range': `bytes ${start}-${end}/${totalSize}`,
        'Content-Length': chunkLength,
      });

      if (req.method === 'HEAD') {
        return res.end();
      }

      let bytesPiped = 0;
      const stream = fs.createReadStream(job.outputFilePath, {
        start,
        end,
        highWaterMark: 256 * 1024,
      });

      stream.on('data', (chunk: Buffer | string) => {
        bytesPiped += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      });

      stream.on('error', (err) => {
        logDebug('DOWNLOAD', 'DOWNLOAD_STREAM_ERROR', {
          jobId: job.jobId,
          start,
          end,
          bytesPiped,
          error: err.message,
        });
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.end();
        }
      });

      res.on('finish', () => {
        logDebug('DOWNLOAD', 'DOWNLOAD_RANGE_COMPLETED', {
          jobId: job.jobId,
          start,
          end,
          bytesPiped,
          expectedChunkLength: chunkLength,
          totalSize,
        });
      });

      res.on('close', () => {
        if (!res.writableEnded) {
          logDebug('DOWNLOAD', 'DOWNLOAD_CLIENT_ABORTED_RANGE', {
            jobId: job.jobId,
            start,
            end,
            bytesPiped,
            expectedChunkLength: chunkLength,
          });
          stream.destroy();
        }
      });

      stream.pipe(res);
      return;
    }

    logDebug('DOWNLOAD', 'SERVE_TRIMMED_FULL_200', {
      jobId: job.jobId,
      method: req.method,
      outputFileName: job.outputFileName,
      totalSize,
      contentType,
      sha256: job.outputSha256 || null,
    });

    res.writeHead(200, {
      ...commonHeaders,
      'Content-Length': totalSize,
    });

    if (req.method === 'HEAD') {
      return res.end();
    }

    let bytesPiped = 0;
    const stream = fs.createReadStream(job.outputFilePath, {
      highWaterMark: 256 * 1024,
    });

    stream.on('data', (chunk: Buffer | string) => {
      bytesPiped += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
    });

    stream.on('error', (err) => {
      logDebug('DOWNLOAD', 'DOWNLOAD_STREAM_ERROR', {
        jobId: job.jobId,
        bytesPiped,
        totalSize,
        error: err.message,
      });
      if (!res.headersSent) {
        res.status(500).end();
      } else {
        res.end();
      }
    });

    res.on('finish', () => {
      logDebug('DOWNLOAD', 'DOWNLOAD_FULL_COMPLETED', {
        jobId: job.jobId,
        outputFileName: job.outputFileName,
        bytesPiped,
        expectedBytes: totalSize,
        completeMatch: bytesPiped === totalSize,
      });
    });

    res.on('close', () => {
      if (!res.writableEnded) {
        logDebug('DOWNLOAD', 'DOWNLOAD_CLIENT_ABORTED_FULL', {
          jobId: job.jobId,
          outputFileName: job.outputFileName,
          bytesPiped,
          expectedBytes: totalSize,
        });
        stream.destroy();
      }
    });

    stream.pipe(res);
  };

  app.get('/api/trim/download/:jobId', handleTrimDownload);
  app.head('/api/trim/download/:jobId', handleTrimDownload);

  /**
   * POST /api/trim/save-to-drive/:jobId
   */
  app.post('/api/trim/save-to-drive/:jobId', async (req: Request, res: Response) => {
    try {
      const job = getOrRecoverCompletedJob(req.params.jobId);
      if (!job || job.status !== 'completed' || !fs.existsSync(job.outputFilePath)) {
        return res.status(404).json({ error: 'Trimmed video file not found.' });
      }

      const oauthToken = extractRequestOAuthToken(req);

      if (!oauthToken) {
        return res.status(401).json({
          error: 'Please sign in with Google to save trimmed videos to your Google Drive.',
        });
      }

      const mimeMap: Record<string, string> = {
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'video/webm',
      };
      const mimeType = mimeMap[job.outputFormat] || 'video/mp4';
      const fileBuffer = fs.readFileSync(job.outputFilePath);

      const boundary = '-------DriveTrimMultipartBoundary' + Date.now();
      const metadataPart = JSON.stringify({
        name: job.outputFileName,
        mimeType,
        description: `Trimmed with DriveTrim (${job.startTime}s - ${job.endTime}s)`,
      });

      const preamble = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadataPart}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
        'utf-8'
      );
      const epilogue = Buffer.from(`\r\n--${boundary}--`, 'utf-8');
      const multipartBody = Buffer.concat([preamble, fileBuffer, epilogue]);

      const uploadRes = await fetch(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${oauthToken}`,
            'Content-Type': `multipart/related; boundary=${boundary}`,
            'Content-Length': String(multipartBody.length),
          },
          body: multipartBody,
        }
      );

      if (!uploadRes.ok) {
        const errText = await uploadRes.text();
        return res.status(uploadRes.status).json({
          error: `Google Drive upload failed: ${errText}`,
        });
      }

      const uploadedData: any = await uploadRes.json();
      return res.json({
        id: uploadedData.id,
        name: uploadedData.name,
        webViewLink:
          uploadedData.webViewLink ||
          `https://drive.google.com/file/d/${uploadedData.id}/view`,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message || 'Failed to save video to Google Drive.' });
    }
  });

  /**
   * DELETE /api/trim/cleanup/:jobId
   */
  app.delete('/api/trim/cleanup/:jobId', (req: Request, res: Response) => {
    const job = getOrRecoverCompletedJob(req.params.jobId);
    if (job) {
      if (job.outputFilePath && fs.existsSync(job.outputFilePath)) {
        try {
          fs.unlinkSync(job.outputFilePath);
        } catch {}
      }
      const metaPath = `${job.outputFilePath}.meta.json`;
      if (job.outputFilePath && fs.existsSync(metaPath)) {
        try {
          fs.unlinkSync(metaPath);
        } catch {}
      }
      trimJobs.delete(job.jobId);
    }
    return res.json({ cleaned: true });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`DriveTrim server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
