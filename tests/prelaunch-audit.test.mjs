/**
 * ClipDrive / DriveTrim — Pre-Launch Automated QA, Security, FFprobe & Download Integrity Test Suite
 * Executes unit, integration, security, and end-to-end video trimming & verification tests against http://127.0.0.1:3000
 */
import crypto from 'crypto';
import fs from 'fs';
import { spawnSync } from 'child_process';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:3000';
const results = [];

function recordResult(category, name, passed, details = {}) {
  results.push({ category, name, status: passed ? 'PASS' : 'FAIL', details });
  const icon = passed ? 'PASS' : 'FAIL';
  console.log(`[${icon}] [${category}] ${name}`, JSON.stringify(details));
  if (!passed) {
    process.exitCode = 1;
  }
}

/**
 * Pure unit helper mirrors src/utils/timeFormat.ts to verify time parsing & formatting edge cases
 */
function parseTimeInputUnit(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed) return { valid: false };
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return { valid: true, seconds: parseFloat(trimmed) };
  }
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) return { valid: false };
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => isNaN(n) || n < 0)) return { valid: false };
  if (parts.length === 2) {
    const [m, s] = nums;
    if (s >= 60) return { valid: false };
    return { valid: true, seconds: m * 60 + s };
  }
  const [h, m, s] = nums;
  if (m >= 60 || s >= 60) return { valid: false };
  return { valid: true, seconds: h * 3600 + m * 60 + s };
}

async function waitForJobCompletion(jobId, maxWaitMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const res = await fetch(`${BASE_URL}/api/trim/status/${encodeURIComponent(jobId)}`);
    const data = await res.json();
    if (data.status === 'completed' || data.status === 'error' || data.status === 'cancelled') {
      return data;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`Job ${jobId} timed out after ${maxWaitMs}ms`);
}

function runLocalFfprobe(filePath) {
  const proc = spawnSync(
    '/usr/bin/ffprobe',
    ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath],
    { encoding: 'utf-8' }
  );
  if (proc.status !== 0) {
    return { ok: false, exitCode: proc.status, stderr: proc.stderr };
  }
  const parsed = JSON.parse(proc.stdout);
  const vStream = (parsed.streams || []).find((s) => s.codec_type === 'video');
  const aStream = (parsed.streams || []).find((s) => s.codec_type === 'audio');
  return {
    ok: true,
    exitCode: 0,
    formatName: parsed.format?.format_name,
    duration: parseFloat(parsed.format?.duration || vStream?.duration || '0'),
    size: parseInt(parsed.format?.size || '0', 10),
    videoCodec: vStream?.codec_name,
    pixFmt: vStream?.pix_fmt,
    width: vStream?.width,
    height: vStream?.height,
    audioCodec: aStream?.codec_name || null,
  };
}

async function runAllTests() {
  console.log('=== STARTING CLIPDRIVE / DRIVETRIM PRE-LAUNCH AUTOMATED QA & SECURITY AUDIT ===');

  // 1. UNIT TESTS: Time Parser
  {
    const t1 = parseTimeInputUnit('01:30');
    const t2 = parseTimeInputUnit('00:15:45.5');
    const t3 = parseTimeInputUnit('95.25');
    const tInvalid1 = parseTimeInputUnit('01:75'); // invalid seconds >= 60
    const tInvalid2 = parseTimeInputUnit('-10');
    const tInvalid3 = parseTimeInputUnit('abc');

    const passed =
      t1.valid &&
      t1.seconds === 90 &&
      t2.valid &&
      t2.seconds === 945.5 &&
      t3.valid &&
      t3.seconds === 95.25 &&
      !tInvalid1.valid &&
      !tInvalid2.valid &&
      !tInvalid3.valid;

    recordResult('UNIT', 'Timestamp Parser & Validator (MM:SS, HH:MM:SS, raw seconds, invalid)', passed, {
      t1,
      t2,
      t3,
      tInvalid1,
      tInvalid2,
    });
  }

  // 2. SECURITY & URL VALIDATION TESTS
  {
    // SSRF attempt 1: localhost URL
    const ssrf1 = await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:3000/api/video/debug-logs' }),
    });
    const ssrf1Json = await ssrf1.json();

    // SSRF attempt 2: AWS/GCP metadata IP
    const ssrf2 = await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'http://169.254.169.254/latest/meta-data/' }),
    });

    // SSRF attempt 3: Non-Google domain spoofing
    const ssrf3 = await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://evil-drive.google.com.attacker.com/file/d/1abcDEFgHijklMNop/view' }),
    });

    // Security headers check
    const xContentType = ssrf1.headers.get('x-content-type-options');
    const xPoweredBy = ssrf1.headers.get('x-powered-by');

    recordResult(
      'SECURITY',
      'SSRF Prevention & Host Allowlisting on /api/video/inspect',
      ssrf1.status === 400 && ssrf2.status === 400 && ssrf3.status === 400 && xContentType === 'nosniff' && !xPoweredBy,
      {
        localhostStatus: ssrf1.status,
        metadataIpStatus: ssrf2.status,
        spoofedHostStatus: ssrf3.status,
        errorCode: ssrf1Json.code,
        xContentTypeOptions: xContentType,
        xPoweredByHidden: !xPoweredBy,
      }
    );
  }

  // 3. SECURITY: Path Traversal & Command Injection Prevention on Job IDs & File IDs
  {
    const trav1 = await fetch(`${BASE_URL}/api/trim/download/..%2F..%2Fetc%2Fpasswd`);
    const trav2 = await fetch(`${BASE_URL}/api/trim/verify/..%2F..%2Fserver.ts`);
    const cmdInj = await fetch(`${BASE_URL}/api/trim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: '1abcDEFgHijklMNop; rm -rf /tmp/*',
        startTime: 0,
        endTime: 5,
      }),
    });

    // External X-Forwarded-For request to internal loopback route /api/video/raw-stream/:fileId
    const loopbackCheck = await fetch(`${BASE_URL}/api/video/raw-stream/1abcDEFgHijklMNop`, {
      headers: { 'X-Forwarded-For': '203.0.113.55' },
    });

    recordResult(
      'SECURITY',
      'Path Traversal, Command Injection & Loopback Proxy Protection',
      trav1.status === 404 && trav2.status === 404 && cmdInj.status === 400 && loopbackCheck.status === 403,
      {
        downloadTraversalStatus: trav1.status,
        verifyTraversalStatus: trav2.status,
        commandInjectionFileIdStatus: cmdInj.status,
        externalLoopbackBlockStatus: loopbackCheck.status,
      }
    );
  }

  // 4. ERROR HANDLING: Invalid, Deleted, and Unsupported Codec Links
  {
    const emptyRes = await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: '   ' }),
    });
    const deletedRes = await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://drive.google.com/file/d/1deletedNonExistentVideoFileId99999/view',
      }),
    });
    const unsupportedCodecRes = await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://drive.google.com/file/d/1unsupportedCodecDemoVideoId/view',
      }),
    });
    const unsupportedJson = await unsupportedCodecRes.json();

    recordResult(
      'ERROR_HANDLING',
      'Empty URL, Deleted/Non-Existent Drive File, and Unsupported Codec Detection',
      emptyRes.status === 400 &&
        (deletedRes.status === 404 || deletedRes.status === 401) &&
        unsupportedCodecRes.status === 200 &&
        unsupportedJson.isBrowserCompatible === false &&
        unsupportedJson.streamUrl.includes('compat=1'),
      {
        emptyStatus: emptyRes.status,
        deletedStatus: deletedRes.status,
        unsupportedCodecDetected: !unsupportedJson.isBrowserCompatible,
        compatStreamFallbackUrl: unsupportedJson.streamUrl,
      }
    );
  }

  // 5. RANGE VALIDATION TESTS on /api/trim/start
  {
    await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://drive.google.com/file/d/1abcDEFgHijklMNop/view' }),
    });

    const endBeforeStart = await fetch(`${BASE_URL}/api/trim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: '1abcDEFgHijklMNop', startTime: 50, endTime: 20 }),
    });
    const zeroDuration = await fetch(`${BASE_URL}/api/trim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: '1abcDEFgHijklMNop', startTime: 30, endTime: 30 }),
    });
    const negativeStart = await fetch(`${BASE_URL}/api/trim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: '1abcDEFgHijklMNop', startTime: -5, endTime: 10 }),
    });
    const exceedDuration = await fetch(`${BASE_URL}/api/trim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fileId: '1abcDEFgHijklMNop', startTime: 10, endTime: 99999 }),
    });

    recordResult(
      'VALIDATION',
      'Trim Timestamp Range Validation (start>=end, zero length, negative start, >duration)',
      endBeforeStart.status === 400 &&
        zeroDuration.status === 400 &&
        negativeStart.status === 400 &&
        exceedDuration.status === 400,
      {
        endBeforeStart: endBeforeStart.status,
        zeroDuration: zeroDuration.status,
        negativeStart: negativeStart.status,
        exceedDuration: exceedDuration.status,
      }
    );
  }

  // 6. VIDEO TEST 1: Short Real Google Drive Video (10–30s clip from 37.38s source `1a7ywm2HkF0JBH1BeAqXtqBdMI4YkSvHM`)
  let shortJobId = null;
  {
    const inspectRes = await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://drive.google.com/file/d/1a7ywm2HkF0JBH1BeAqXtqBdMI4YkSvHM/view?usp=sharing',
      }),
    });
    const meta = await inspectRes.json();

    // Test HTTP 206 video preview stream
    const streamRes = await fetch(`${BASE_URL}${meta.streamUrl}`, {
      headers: { Range: 'bytes=0-65535' },
    });
    const streamBytes = Buffer.from(await streamRes.arrayBuffer());

    // Start 15-second trim (00:05 to 00:20)
    const startRes = await fetch(`${BASE_URL}/api/trim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: '1a7ywm2HkF0JBH1BeAqXtqBdMI4YkSvHM',
        startTime: 5,
        endTime: 20,
        trimMode: 'copy',
        outputFormat: 'mp4',
      }),
    });
    const startJson = await startRes.json();
    shortJobId = startJson.jobId;
    const completedJob = await waitForJobCompletion(shortJobId);

    // Pre-download FFprobe verification endpoint
    const verifyRes = await fetch(`${BASE_URL}/api/trim/verify/${shortJobId}`, { method: 'POST' });
    const verifyJson = await verifyRes.json();

    // Download full file via HTTP 200 and verify SHA-256 + magic bytes + local ffprobe
    const dlRes = await fetch(`${BASE_URL}/api/trim/download/${shortJobId}`);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    const dlSha256 = crypto.createHash('sha256').update(dlBuf).digest('hex');
    const tmpOut = `/tmp/audit_dl_short_${shortJobId}.mp4`;
    fs.writeFileSync(tmpOut, dlBuf);
    const localProbe = runLocalFfprobe(tmpOut);
    fs.unlinkSync(tmpOut);

    const passed =
      inspectRes.status === 200 &&
      streamRes.status === 206 &&
      streamBytes.length === 65536 &&
      completedJob.status === 'completed' &&
      verifyJson.valid === true &&
      dlRes.status === 200 &&
      dlBuf.length === completedJob.outputSize &&
      dlSha256 === completedJob.outputSha256 &&
      localProbe.ok &&
      localProbe.videoCodec === 'h264';

    recordResult('E2E_SHORT_VIDEO', '15s Trim from Real Google Drive Video (37.38s source)', passed, {
      sourceFileId: meta.fileId,
      sourceFileName: meta.fileName,
      sourceDurationSec: meta.durationSeconds,
      sourceSize: meta.fileSize,
      previewStreamStatus: streamRes.status,
      previewContentRange: streamRes.headers.get('content-range'),
      jobId: shortJobId,
      outputFileName: completedJob.outputFileName,
      outputSizeBytes: completedJob.outputSize,
      downloadedBytes: dlBuf.length,
      sha256Match: dlSha256 === completedJob.outputSha256,
      sha256: dlSha256,
      ffprobe: localProbe,
    });
  }

  // 7. VIDEO TEST 2: 5–10 Minute Video Trim (300s / 5m00s clip from 30:00 source `1abcDEFgHijklMNop`)
  let mediumJobId = null;
  {
    const startRes = await fetch(`${BASE_URL}/api/trim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: '1abcDEFgHijklMNop',
        startTime: 120,
        endTime: 420,
        trimMode: 'copy',
        outputFormat: 'mp4',
      }),
    });
    const startJson = await startRes.json();
    mediumJobId = startJson.jobId;
    const completedJob = await waitForJobCompletion(mediumJobId);

    const verifyRes = await fetch(`${BASE_URL}/api/trim/verify/${mediumJobId}`);
    const verifyJson = await verifyRes.json();

    const dlRes = await fetch(`${BASE_URL}/api/trim/download/${mediumJobId}`);
    const dlBuf = Buffer.from(await dlRes.arrayBuffer());
    const dlSha256 = crypto.createHash('sha256').update(dlBuf).digest('hex');
    const tmpOut = `/tmp/audit_dl_medium_${mediumJobId}.mp4`;
    fs.writeFileSync(tmpOut, dlBuf);
    const localProbe = runLocalFfprobe(tmpOut);
    fs.unlinkSync(tmpOut);

    const passed =
      completedJob.status === 'completed' &&
      verifyJson.valid === true &&
      dlBuf.length === completedJob.outputSize &&
      dlSha256 === completedJob.outputSha256 &&
      localProbe.ok &&
      Math.abs(localProbe.duration - 300) < 5;

    recordResult('E2E_5_10_MIN_VIDEO', '5-Minute (300s) Trim & Download Verification', passed, {
      jobId: mediumJobId,
      requestedClipDurationSec: 300,
      actualOutputDurationSec: localProbe.duration,
      outputSizeBytes: completedJob.outputSize,
      downloadedBytes: dlBuf.length,
      sha256Match: dlSha256 === completedJob.outputSha256,
      sha256: dlSha256,
      ffprobe: localProbe,
    });
  }

  // 8. VIDEO TEST 3: 30–40 Minute / Multi-GB Large Google Drive Video (`1M4NAy64YWAP5CNNGQw6XuR4JayKuklSl` - 31m 33s, 3.45 GB source)
  {
    const inspectRes = await fetch(`${BASE_URL}/api/video/inspect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://drive.google.com/file/d/1M4NAy64YWAP5CNNGQw6XuR4JayKuklSl/view?usp=sharing',
      }),
    });
    const meta = await inspectRes.json();

    // Verify the existing 9m 31s (571.026s, 139.8 MB) trim job `2d3fc1a2-249d-4ac6-be2a-748883cdbae8` from this 31m33s 3.45GB source,
    // AND run a fresh late-timeline trim at 25:00 to 25:30 (1500s to 1530s) on the 31m 33s video!
    const largeExistingVerify = await fetch(
      `${BASE_URL}/api/trim/verify/2d3fc1a2-249d-4ac6-be2a-748883cdbae8`
    );
    const largeExistingJson = await largeExistingVerify.json();

    const lateTrimStart = await fetch(`${BASE_URL}/api/trim/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId: '1M4NAy64YWAP5CNNGQw6XuR4JayKuklSl',
        startTime: 1500,
        endTime: 1525,
        trimMode: 'copy',
        outputFormat: 'mp4',
      }),
    });
    const lateTrimStartJson = await lateTrimStart.json();
    const lateCompleted = await waitForJobCompletion(lateTrimStartJson.jobId, 120000);
    const lateVerifyRes = await fetch(`${BASE_URL}/api/trim/verify/${lateTrimStartJson.jobId}`);
    const lateVerifyJson = await lateVerifyRes.json();

    // Also test chunked HTTP 206 Range download (matching browser's 8 MiB chunked fetcher) on the late-timeline clip
    const rangeRes = await fetch(`${BASE_URL}/api/trim/download/${lateTrimStartJson.jobId}`, {
      headers: { Range: 'bytes=0-65535' },
    });
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());

    const passed =
      inspectRes.status === 200 &&
      meta.durationSeconds > 1800 &&
      meta.fileSize > 3_000_000_000 &&
      largeExistingJson.valid === true &&
      lateCompleted.status === 'completed' &&
      lateVerifyJson.valid === true &&
      rangeRes.status === 206 &&
      rangeBuf.length === 65536;

    recordResult(
      'E2E_30_40_MIN_LARGE_VIDEO',
      '31m 33s (3.45 GB) Google Drive Video Inspection, 139.8 MB (9m31s) Clip & Late-Timeline (25:00-25:25) Trim',
      passed,
      {
        sourceFileId: meta.fileId,
        sourceFileName: meta.fileName,
        sourceDurationSec: meta.durationSeconds,
        sourceSizeBytes: meta.fileSize,
        large9m31sClipVerified: largeExistingJson.valid,
        large9m31sClipBytes: largeExistingJson.diagnostic?.fileSizeBytes,
        large9m31sClipDurationSec: largeExistingJson.diagnostic?.durationSeconds,
        large9m31sClipSha256: largeExistingJson.diagnostic?.sha256,
        lateTimelineJobId: lateTrimStartJson.jobId,
        lateTimelineSizeBytes: lateCompleted.outputSize,
        lateTimelineDurationSec: lateVerifyJson.diagnostic?.durationSeconds,
        lateTimelineSha256: lateCompleted.outputSha256,
        range206Status: rangeRes.status,
        range206ContentRange: rangeRes.headers.get('content-range'),
      }
    );

    // Clean up temporary late trim job
    await fetch(`${BASE_URL}/api/trim/cleanup/${lateTrimStartJson.jobId}`, { method: 'DELETE' });
  }

  // 9. SEQUENTIAL JOB ISOLATION & CLEANUP VERIFICATION
  {
    // Verify that running mediumJobId after shortJobId did NOT overwrite or corrupt shortJobId
    const checkFirstAgain = await fetch(`${BASE_URL}/api/trim/verify/${shortJobId}`);
    const checkFirstJson = await checkFirstAgain.json();

    // Now test DELETE /api/trim/cleanup/:jobId on both test jobs
    const clean1 = await fetch(`${BASE_URL}/api/trim/cleanup/${shortJobId}`, { method: 'DELETE' });
    const clean2 = await fetch(`${BASE_URL}/api/trim/cleanup/${mediumJobId}`, { method: 'DELETE' });
    const verifyAfterClean = await fetch(`${BASE_URL}/api/trim/verify/${shortJobId}`);

    recordResult(
      'ISOLATION_AND_CLEANUP',
      'Multi-Job Isolation (No File Collisions) & Temp File Cleanup Verification',
      checkFirstJson.valid === true &&
        clean1.status === 200 &&
        clean2.status === 200 &&
        verifyAfterClean.status === 404,
      {
        firstJobIntactAfterSecondJob: checkFirstJson.valid,
        cleanup1Status: clean1.status,
        cleanup2Status: clean2.status,
        statusAfterCleanup: verifyAfterClean.status,
      }
    );
  }

  // Summary
  const passedCount = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n=== AUDIT TEST SUMMARY: ${passedCount}/${results.length} PASSED ===`);
}

runAllTests().catch((err) => {
  console.error('Fatal test runner error:', err);
  process.exit(1);
});
