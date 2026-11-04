import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Scissors,
  RotateCcw,
  Download,
  Clock,
  FileText,
  Link2,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Loader2,
  ShieldCheck,
  Zap,
  Smartphone,
  Rocket,
  MonitorSmartphone,
  CloudUpload,
  FolderOpen,
  LogOut,
  XCircle,
  Sparkles,
  Trash2,
  Eye,
} from 'lucide-react';
import { User } from 'firebase/auth';
import {
  initAuth,
  googleSignIn,
  logout,
  getAccessToken,
  getBackendSessionId,
} from './services/googleAuth';
import {
  formatTimeDisplay,
  formatTimeHMS,
  parseTimeInput,
  formatBytes,
} from './utils/timeFormat';
import { ConfirmActionModal } from './components/ConfirmActionModal';
import { DriveBrowserModal } from './components/DriveBrowserModal';

interface VideoMetadata {
  fileId: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  durationSeconds: number;
  width: number;
  height: number;
  fps?: number;
  videoCodec: string;
  videoProfile?: string;
  pixFmt?: string;
  audioCodec: string | null;
  hasAudio: boolean;
  isBrowserCompatible?: boolean;
  incompatibilityReason?: string;
  supportsRange: boolean;
  accessMode: 'public' | 'oauth' | 'demo';
  containerFormat: string;
  streamUrl: string;
}

interface TrimJobStatus {
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
  outputFileName: string;
  outputSize: number;
  outputSha256?: string;
  actualOutputDuration: number;
  error?: string;
  downloadUrl: string | null;
}

interface PreDownloadDiagnosticReport {
  jobId: string;
  outputFileName?: string;
  stage: string;
  fileExists: boolean;
  fileSizeBytes: number;
  sha256?: string | null;
  magicSignature?: {
    firstChunkBytes: number;
    firstBytesHex: string;
    firstBytesAscii: string;
    signatureType: string;
  } | null;
  ffprobeCommand?: string;
  ffprobeExitCode?: number | null;
  ffprobeStderr?: string | null;
  containerFormat?: string;
  containerLongName?: string | null;
  durationSeconds?: number;
  bitRate?: number | null;
  nbStreams?: number;
  videoStream?: {
    codecName: string;
    profile: string;
    width: number;
    height: number;
    pixFmt: string;
    fps: number;
  } | null;
  audioStream?: {
    codecName: string;
    profile?: string | null;
    sampleRate?: string | null;
    channels?: number | null;
  } | null;
  elapsedMs?: number;
  checkedAt: string;
}

const DEFAULT_DEMO_URL =
  'https://drive.google.com/file/d/1abcDEFgHijklMNop/view?usp=sharing';
const THUMBNAIL_SLOT_COUNT = 12;

export default function App() {
  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [backendSessionId, setBackendSessionId] = useState<string | null>(null);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [isDriveModalOpen, setIsDriveModalOpen] = useState(false);

  // Input & Video Metadata state
  const [driveUrl, setDriveUrl] = useState<string>(DEFAULT_DEMO_URL);
  const [isLoadingVideo, setIsLoadingVideo] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<{
    code?: string;
    message: string;
  } | null>(null);
  const [videoMeta, setVideoMeta] = useState<VideoMetadata | null>(null);
  const inspectAbortRef = useRef<AbortController | null>(null);

  // Video Player state
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [isPlayerReady, setIsPlayerReady] = useState<boolean>(false);
  const [useCompatFallback, setUseCompatFallback] = useState<boolean>(false);
  const [streamRetryCount, setStreamRetryCount] = useState<number>(0);
  const [playerErrorMsg, setPlayerErrorMsg] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [volume, setVolume] = useState<number>(1);
  const [isMuted, setIsMuted] = useState<boolean>(false);
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);
  const [showTechOverlay, setShowTechOverlay] = useState<boolean>(false);
  const [previewingSelection, setPreviewingSelection] = useState<boolean>(false);

  // Timeline & Progressive Thumbnail state
  const timelineTrackRef = useRef<HTMLDivElement | null>(null);
  const thumbAbortRef = useRef<AbortController | null>(null);
  const [startTime, setStartTime] = useState<number>(1200); // 20:00 default matching reference UI
  const [endTime, setEndTime] = useState<number>(1320); // 22:00 default matching reference UI
  const [startInputText, setStartInputText] = useState<string>('00:20:00');
  const [endInputText, setEndInputText] = useState<string>('00:22:00');
  const [timeInputError, setTimeInputError] = useState<string | null>(null);
  const [activeDragHandle, setActiveDragHandle] = useState<
    'start' | 'end' | null
  >(null);
  const [thumbnailSlots, setThumbnailSlots] = useState<Array<string | null>>(
    Array(THUMBNAIL_SLOT_COUNT).fill(null)
  );

  // Trimming Engine Options & Job State
  const [trimMode, setTrimMode] = useState<'copy' | 'reencode'>('copy');
  const [outputFormat, setOutputFormat] = useState<'mp4' | 'mov' | 'webm'>('mp4');
  const [activeJob, setActiveJob] = useState<TrimJobStatus | null>(null);
  const [isStartingTrim, setIsStartingTrim] = useState<boolean>(false);
  const [trimError, setTrimError] = useState<string | null>(null);
  const [showTrimmedPreview, setShowTrimmedPreview] = useState<boolean>(false);
  const [isDownloadingFile, setIsDownloadingFile] = useState<boolean>(false);
  const [downloadProgressPct, setDownloadProgressPct] = useState<number>(0);
  const [isVerifyingFfprobe, setIsVerifyingFfprobe] = useState<boolean>(false);
  const [ffprobeDiagnostic, setFfprobeDiagnostic] =
    useState<PreDownloadDiagnosticReport | null>(null);
  const [ffprobeDiagnosticError, setFfprobeDiagnosticError] = useState<{
    message: string;
    diagnostic?: PreDownloadDiagnosticReport;
  } | null>(null);
  const [showDiagnosticPanel, setShowDiagnosticPanel] = useState<boolean>(false);

  // Confirmation Modals (Save to Google Drive & Full-Stream Fallback)
  const [showSaveDriveConfirm, setShowSaveDriveConfirm] = useState<boolean>(false);
  const [isSavingToDrive, setIsSavingToDrive] = useState<boolean>(false);
  const [savedDriveLink, setSavedDriveLink] = useState<{
    name: string;
    webViewLink: string;
  } | null>(null);
  const [showFullStreamConfirm, setShowFullStreamConfirm] =
    useState<boolean>(false);

  // Initialize Firebase Google Auth listener
  useEffect(() => {
    const unsub = initAuth(
      (u, token, sid) => {
        setUser(u);
        setAccessToken(token);
        setBackendSessionId(sid);
      },
      () => {
        setUser(null);
        setAccessToken(null);
        setBackendSessionId(null);
      }
    );
    return () => unsub();
  }, []);

  /**
   * Progressive, non-blocking thumbnail loader:
   * Fetches timeline frames one-by-one AFTER the video player starts loading so
   * thumbnail extraction never blocks playback or seeking.
   */
  const loadThumbnailsProgressively = useCallback(
    async (fileId: string, durationSec: number, sid?: string | null) => {
      if (thumbAbortRef.current) {
        thumbAbortRef.current.abort();
      }
      const controller = new AbortController();
      thumbAbortRef.current = controller;

      setThumbnailSlots(Array(THUMBNAIL_SLOT_COUNT).fill(null));
      const safeDur = Math.max(1, durationSec);
      const effectiveSid = sid ?? getBackendSessionId();

      for (let i = 0; i < THUMBNAIL_SLOT_COUNT; i++) {
        if (controller.signal.aborted) return;

        const ts = Math.min(
          Math.floor(((i + 0.5) / THUMBNAIL_SLOT_COUNT) * safeDur),
          Math.max(0, Math.floor(safeDur - 1))
        );

        try {
          const url = `/api/video/thumbnail/${encodeURIComponent(fileId)}?time=${ts}${
            effectiveSid ? `&sid=${encodeURIComponent(effectiveSid)}` : ''
          }`;
          const res = await fetch(url, { signal: controller.signal });
          if (res.ok && !controller.signal.aborted) {
            const blob = await res.blob();
            const objectUrl = URL.createObjectURL(blob);
            setThumbnailSlots((prev) => {
              const next = [...prev];
              next[i] = objectUrl;
              return next;
            });
          }
        } catch {
          if (controller.signal.aborted) return;
        }
      }
    },
    []
  );

  // Inspect & Load a Google Drive video URL with AbortController & Exponential Backoff Retry
  const handleLoadVideo = useCallback(
    async (urlToLoad?: string, explicitToken?: string | null, explicitSid?: string | null) => {
      const targetUrl = (urlToLoad ?? driveUrl).trim();
      if (!targetUrl) {
        setLoadError({
          code: 'INVALID_LINK',
          message: 'Please enter a valid Google Drive video link.',
        });
        return;
      }

      if (inspectAbortRef.current) {
        inspectAbortRef.current.abort();
      }
      if (thumbAbortRef.current) {
        thumbAbortRef.current.abort();
      }

      const inspectController = new AbortController();
      inspectAbortRef.current = inspectController;

      setIsLoadingVideo(true);
      setLoadError(null);
      setPlayerErrorMsg(null);
      setTrimError(null);
      setActiveJob(null);
      setSavedDriveLink(null);
      setShowTrimmedPreview(false);
      setFfprobeDiagnostic(null);
      setFfprobeDiagnosticError(null);
      setShowDiagnosticPanel(false);
      setIsPlayerReady(false);
      setUseCompatFallback(false);
      setStreamRetryCount(0);

      try {
        const token = explicitToken ?? accessToken ?? (await getAccessToken());
        const sid = explicitSid ?? backendSessionId ?? getBackendSessionId();
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        };
        if (token) {
          headers['Authorization'] = `Bearer ${token}`;
        }

        const inspectEndpoint = sid
          ? `/api/video/inspect?sid=${encodeURIComponent(sid)}`
          : '/api/video/inspect';

        let res: Response | null = null;
        let lastFetchError: any = null;
        const maxAttempts = 3;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          if (inspectController.signal.aborted) return;
          try {
            const timeoutId = setTimeout(() => {
              inspectController.abort();
            }, 25000);
            try {
              res = await fetch(inspectEndpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({ url: targetUrl }),
                signal: inspectController.signal,
              });
            } finally {
              clearTimeout(timeoutId);
            }

            // Retry only on transient gateway/server errors (502, 503, 504)
            if (res && [502, 503, 504].includes(res.status) && attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, attempt * 600));
              continue;
            }
            break;
          } catch (fetchErr: any) {
            lastFetchError = fetchErr;
            if (inspectController.signal.aborted) return;
            if (attempt < maxAttempts) {
              await new Promise((r) => setTimeout(r, attempt * 600));
            }
          }
        }

        if (!res) {
          throw lastFetchError || new Error('Network request failed');
        }

        let data: any = {};
        try {
          data = await res.json();
        } catch {
          data = {};
        }

        if (!res.ok) {
          console.error('[DriveTrim:Inspect:Error]', {
            status: res.status,
            code: data.code,
            error: data.error,
          });

          let errorCode = data.code || 'ERROR';
          let errorMessage =
            data.error || 'Unable to load this Google Drive video link.';

          if (res.status === 401 || errorCode === 'AUTH_REQUIRED') {
            errorCode = 'AUTH_REQUIRED';
            errorMessage =
              data.error ||
              'Your Google Sign-In session has expired. Please sign in with Google again.';
          } else if (res.status === 403 || errorCode === 'ACCESS_DENIED') {
            errorCode = 'ACCESS_DENIED';
            errorMessage =
              data.error ||
              'This video is private or restricted. Check sharing permissions or sign in with Google.';
          } else if (res.status === 404 || errorCode === 'NOT_FOUND') {
            errorCode = 'NOT_FOUND';
            errorMessage =
              data.error ||
              'This Google Drive file was not found or has been deleted.';
          } else if (res.status === 415 || errorCode === 'UNSUPPORTED_FILE') {
            errorCode = 'UNSUPPORTED_FILE';
            errorMessage =
              data.error ||
              'This file is not a supported video format.';
          } else if (res.status === 429 || errorCode === 'QUOTA_EXCEEDED') {
            errorCode = 'QUOTA_EXCEEDED';
            errorMessage =
              data.error ||
              'Google Drive download quota or rate limit exceeded. Sign in with Google or try again shortly.';
          } else if (res.status >= 500) {
            errorCode = 'SERVER_ERROR';
            errorMessage =
              data.error ||
              'Server encountered an error while inspecting the video stream. Please try again.';
          }

          setLoadError({
            code: errorCode,
            message: errorMessage,
          });
          setIsLoadingVideo(false);
          return;
        }

        const meta: VideoMetadata = data;
        console.log('[DriveTrim:Inspect:Success]', {
          fileId: meta.fileId,
          fileName: meta.fileName,
          mimeType: meta.mimeType,
          fileSize: meta.fileSize,
          durationSeconds: meta.durationSeconds,
          videoCodec: meta.videoCodec,
          videoProfile: meta.videoProfile,
          pixFmt: meta.pixFmt,
          audioCodec: meta.audioCodec,
          isBrowserCompatible: meta.isBrowserCompatible,
          supportsRange: meta.supportsRange,
          accessMode: meta.accessMode,
          streamUrl: meta.streamUrl,
        });
        setVideoMeta(meta);
        setUseCompatFallback(meta.isBrowserCompatible === false);

        const dur = Math.max(1, Math.floor(meta.durationSeconds || 60));
        let defaultStart = 0;
        let defaultEnd = dur;

        if (meta.fileId === '1abcDEFgHijklMNop' && dur >= 1500) {
          defaultStart = 1200; // 20:00
          defaultEnd = 1320; // 22:00
        } else if (dur > 10) {
          defaultStart = Math.floor(dur * 0.2);
          defaultEnd = Math.min(dur, Math.max(defaultStart + 5, Math.floor(dur * 0.5)));
        }

        setStartTime(defaultStart);
        setEndTime(defaultEnd);
        setStartInputText(formatTimeHMS(defaultStart));
        setEndInputText(formatTimeHMS(defaultEnd));
        setTimeInputError(null);
        setCurrentTime(0);
        setIsPlaying(false);

        // Start progressive thumbnail loading slightly after video element mounts so playback gets priority
        if (meta.durationSeconds > 0) {
          setTimeout(() => {
            loadThumbnailsProgressively(meta.fileId, dur, sid);
          }, 250);
        }
      } catch (err: any) {
        if (inspectController.signal.aborted) {
          setLoadError({
            code: 'TIMEOUT_ERROR',
            message:
              'Request timed out while connecting to Google Drive. Please check the link or try again.',
          });
        } else {
          setLoadError({
            code: 'NETWORK_ERROR',
            message:
              err?.message && !err.message.includes('fetch')
                ? err.message
                : 'Network error while reaching the video server. Please try again.',
          });
        }
      } finally {
        if (inspectAbortRef.current === inspectController) {
          setIsLoadingVideo(false);
        }
      }
    },
    [driveUrl, accessToken, backendSessionId, loadThumbnailsProgressively]
  );

  // Auto-load initial video on mount
  useEffect(() => {
    handleLoadVideo(DEFAULT_DEMO_URL);
    return () => {
      if (inspectAbortRef.current) inspectAbortRef.current.abort();
      if (thumbAbortRef.current) thumbAbortRef.current.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Poll active FFmpeg trimming job progress
  useEffect(() => {
    if (
      !activeJob ||
      (activeJob.status !== 'starting' && activeJob.status !== 'processing')
    ) {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/trim/status/${activeJob.jobId}`);
        if (!res.ok) return;
        const statusData: TrimJobStatus = await res.json();
        setActiveJob(statusData);
        if (statusData.status === 'error') {
          setTrimError(
            statusData.error ||
              'Unable to process this video. Please try another video or a different trim range.'
          );
        }
      } catch {
        // transient poll error
      }
    }, 550);

    return () => clearInterval(interval);
  }, [activeJob]);

  // Synchronize manual HH:MM:SS text inputs when handles move
  useEffect(() => {
    setStartInputText(formatTimeHMS(startTime));
  }, [startTime]);

  useEffect(() => {
    setEndInputText(formatTimeHMS(endTime));
  }, [endTime]);

  // Handle pointer dragging for timeline handles
  const updateHandleFromClientX = useCallback(
    (clientX: number, handle: 'start' | 'end') => {
      if (!timelineTrackRef.current || !videoMeta) return;
      const rect = timelineTrackRef.current.getBoundingClientRect();
      const totalDur = Math.max(1, videoMeta.durationSeconds);
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      const targetSec = Math.round(ratio * totalDur);
      const minGap = Math.min(1, totalDur * 0.01);

      if (handle === 'start') {
        const clampedStart = Math.max(
          0,
          Math.min(targetSec, Math.floor(endTime - minGap))
        );
        setStartTime(clampedStart);
        setTimeInputError(null);
        if (videoRef.current) {
          videoRef.current.currentTime = clampedStart;
          setCurrentTime(clampedStart);
        }
      } else {
        const clampedEnd = Math.min(
          Math.floor(totalDur),
          Math.max(targetSec, Math.ceil(startTime + minGap))
        );
        setEndTime(clampedEnd);
        setTimeInputError(null);
        if (videoRef.current) {
          videoRef.current.currentTime = clampedEnd;
          setCurrentTime(clampedEnd);
        }
      }
    },
    [videoMeta, startTime, endTime]
  );

  useEffect(() => {
    if (!activeDragHandle) return;

    const handlePointerMove = (e: PointerEvent) => {
      e.preventDefault();
      updateHandleFromClientX(e.clientX, activeDragHandle);
    };

    const handlePointerUp = () => {
      setActiveDragHandle(null);
    };

    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, [activeDragHandle, updateHandleFromClientX]);

  // Handle Google OAuth Sign-In
  const handleGoogleSignIn = async () => {
    setIsLoggingIn(true);
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setAccessToken(result.accessToken);
        setBackendSessionId(result.sessionId);
        if (
          (loadError?.code === 'ACCESS_DENIED' ||
            loadError?.code === 'AUTH_REQUIRED' ||
            loadError?.code === 'QUOTA_EXCEEDED' ||
            playerErrorMsg) &&
          driveUrl.trim()
        ) {
          handleLoadVideo(driveUrl, result.accessToken, result.sessionId);
        }
      }
    } catch (err: any) {
      if (err?.code !== 'auth/popup-closed-by-user') {
        setLoadError({
          code: 'AUTH_ERROR',
          message: 'Google Sign-In was cancelled or could not be completed.',
        });
      }
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleSignOut = async () => {
    await logout();
    setUser(null);
    setAccessToken(null);
    setBackendSessionId(null);
  };

  // Paste from clipboard button
  const handlePasteClipboard = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        setDriveUrl(text.trim());
        handleLoadVideo(text.trim());
      }
    } catch {
      const inputEl = document.getElementById('drive-url-input') as HTMLInputElement | null;
      inputEl?.focus();
      inputEl?.select();
    }
  };

  // Video Player Controls
  const togglePlayPause = () => {
    const vid = videoRef.current;
    if (!vid) return;
    if (vid.paused) {
      vid.play().catch((err) => {
        console.warn('Playback start warning:', err);
      });
    } else {
      vid.pause();
    }
  };

  const handlePlaySelectedRange = () => {
    const vid = videoRef.current;
    if (!vid) return;
    setPreviewingSelection(true);
    vid.currentTime = startTime;
    setCurrentTime(startTime);
    vid.play().catch(() => {});
  };

  const handleTimeUpdate = () => {
    const vid = videoRef.current;
    if (!vid) return;
    const now = vid.currentTime;
    setCurrentTime(now);

    if (previewingSelection && now >= endTime) {
      vid.pause();
      vid.currentTime = startTime;
      setPreviewingSelection(false);
    }
  };

  const handleToggleMute = () => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.muted = !isMuted;
    setIsMuted(!isMuted);
  };

  const handleVolumeChange = (newVol: number) => {
    const vid = videoRef.current;
    if (!vid) return;
    vid.volume = newVol;
    setVolume(newVol);
    if (newVol > 0 && isMuted) {
      vid.muted = false;
      setIsMuted(false);
    }
  };

  const handleToggleFullscreen = () => {
    const container = playerContainerRef.current;
    if (!container) return;
    if (!document.fullscreenElement) {
      container.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  };

  // Manual Start / End Timestamp Commit
  const commitManualStartInput = () => {
    if (!videoMeta) return;
    const parsed = parseTimeInput(startInputText);
    if (parsed === null || parsed < 0) {
      setTimeInputError('Invalid Start Time format. Use HH:MM:SS or MM:SS.');
      setStartInputText(formatTimeHMS(startTime));
      return;
    }
    if (parsed >= endTime) {
      setTimeInputError('Start time must be strictly less than End time.');
      setStartInputText(formatTimeHMS(startTime));
      return;
    }
    setTimeInputError(null);
    setStartTime(parsed);
    if (videoRef.current) {
      videoRef.current.currentTime = parsed;
      setCurrentTime(parsed);
    }
  };

  const commitManualEndInput = () => {
    if (!videoMeta) return;
    const parsed = parseTimeInput(endInputText);
    const maxDur = Math.floor(videoMeta.durationSeconds);
    if (parsed === null || parsed < 0) {
      setTimeInputError('Invalid End Time format. Use HH:MM:SS or MM:SS.');
      setEndInputText(formatTimeHMS(endTime));
      return;
    }
    if (parsed > maxDur) {
      setTimeInputError(
        `End time cannot exceed the video duration (${formatTimeHMS(maxDur)}).`
      );
      setEndInputText(formatTimeHMS(endTime));
      return;
    }
    if (parsed <= startTime) {
      setTimeInputError('End time must be strictly greater than Start time.');
      setEndInputText(formatTimeHMS(endTime));
      return;
    }
    setTimeInputError(null);
    setEndTime(parsed);
    if (videoRef.current) {
      videoRef.current.currentTime = parsed;
      setCurrentTime(parsed);
    }
  };

  // Reset Selection button
  const handleResetSelection = () => {
    if (!videoMeta) return;
    const dur = Math.floor(videoMeta.durationSeconds);
    if (videoMeta.fileId === '1abcDEFgHijklMNop' && dur >= 1500) {
      setStartTime(1200);
      setEndTime(1320);
    } else {
      setStartTime(0);
      setEndTime(dur);
    }
    setTimeInputError(null);
    setTrimError(null);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      setCurrentTime(0);
    }
  };

  // Start FFmpeg Video Trimming Job
  const handleStartTrimJob = async (allowFullStreamFallback = false) => {
    if (!videoMeta) return;

    if (
      startTime < 0 ||
      endTime <= startTime ||
      endTime > videoMeta.durationSeconds + 1
    ) {
      setTrimError('Please select a valid start and end time range before trimming.');
      return;
    }

    setIsStartingTrim(true);
    setTrimError(null);
    setSavedDriveLink(null);
    setShowFullStreamConfirm(false);
    setShowTrimmedPreview(false);
    setFfprobeDiagnostic(null);
    setFfprobeDiagnosticError(null);
    setShowDiagnosticPanel(false);

    try {
      const token = accessToken ?? (await getAccessToken());
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/trim/start', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          fileId: videoMeta.fileId,
          startTime,
          endTime,
          trimMode,
          outputFormat,
          allowFullStreamFallback,
        }),
      });

      const data = await res.json();
      if (res.status === 409 && data.code === 'FULL_STREAM_CONFIRMATION_REQUIRED') {
        setShowFullStreamConfirm(true);
        setIsStartingTrim(false);
        return;
      }

      if (!res.ok) {
        setTrimError(
          data.error ||
            'Unable to process this video. Please try another video or a different trim range.'
        );
        setIsStartingTrim(false);
        return;
      }

      setActiveJob({
        jobId: data.jobId,
        fileId: videoMeta.fileId,
        fileName: videoMeta.fileName,
        startTime,
        endTime,
        clipDuration: endTime - startTime,
        originalDuration: videoMeta.durationSeconds,
        trimMode,
        effectiveTrimMode: data.effectiveTrimMode || trimMode,
        outputFormat,
        status: data.status || 'processing',
        progressPercent: data.progressPercent || 5,
        processedSeconds: 0,
        statusMessage: data.statusMessage || 'Processing selected video segment...',
        outputFileName: '',
        outputSize: 0,
        actualOutputDuration: 0,
        downloadUrl: null,
      });
    } catch {
      setTrimError('Connection interrupted while starting trim job. Please try again.');
    } finally {
      setIsStartingTrim(false);
    }
  };

  // Cancel Running Trim Job
  const handleCancelJob = async () => {
    if (!activeJob) return;
    try {
      await fetch(`/api/trim/cancel/${activeJob.jobId}`, { method: 'POST' });
      setActiveJob((prev) =>
        prev
          ? { ...prev, status: 'cancelled', statusMessage: 'Cancelled by user.' }
          : null
      );
    } catch {
      // ignore
    }
  };

  // Clean up completed temp job file on server
  const handleCleanupJob = async () => {
    if (!activeJob) return;
    try {
      await fetch(`/api/trim/cleanup/${activeJob.jobId}`, { method: 'DELETE' });
      setActiveJob(null);
      setSavedDriveLink(null);
      setShowTrimmedPreview(false);
      setFfprobeDiagnostic(null);
      setFfprobeDiagnosticError(null);
      setShowDiagnosticPanel(false);
    } catch {
      setActiveJob(null);
    }
  };

  /**
   * Pre-Download FFprobe Diagnostic Tool:
   * Triggers a live server-side `ffprobe -v error -show_format -show_streams -of json` check
   * on the output file to verify the video container is valid and file size is non-zero.
   * Displays a detailed server-side error report if any validation stage fails.
   */
  const runPreDownloadDiagnostic = async (
    jobId: string,
    openPanelOnSuccess = false
  ): Promise<PreDownloadDiagnosticReport | null> => {
    setIsVerifyingFfprobe(true);
    setFfprobeDiagnosticError(null);

    try {
      const res = await fetch(`/api/trim/verify/${encodeURIComponent(jobId)}`, {
        method: 'GET',
        credentials: 'include',
        headers: {
          Accept: 'application/json',
        },
      });

      let payload: any = {};
      try {
        payload = await res.json();
      } catch {
        payload = {};
      }

      if (!res.ok || !payload.valid || !payload.diagnostic || payload.diagnostic.fileSizeBytes <= 0) {
        const errorText =
          payload.error ||
          `Server FFprobe diagnostic check failed (HTTP ${res.status}): Video container is invalid or 0 bytes.`;
        setFfprobeDiagnostic(null);
        setFfprobeDiagnosticError({
          message: errorText,
          diagnostic: payload.diagnostic,
        });
        setShowDiagnosticPanel(true);
        return null;
      }

      const diag: PreDownloadDiagnosticReport = payload.diagnostic;
      setFfprobeDiagnostic(diag);
      setFfprobeDiagnosticError(null);
      if (openPanelOnSuccess) {
        setShowDiagnosticPanel(true);
      }
      return diag;
    } catch (err: any) {
      const msg =
        err?.message ||
        'Network failure while running server-side FFprobe pre-download diagnostic.';
      setFfprobeDiagnostic(null);
      setFfprobeDiagnosticError({
        message: msg,
      });
      setShowDiagnosticPanel(true);
      return null;
    } finally {
      setIsVerifyingFfprobe(false);
    }
  };

  /**
   * Verified Binary Video Download Handler:
   * 1. Triggers a pre-download FFprobe container & non-zero size check on the server.
   * 2. Streams the finalized output file in 8 MiB HTTP 206 Range chunks,
   *    verifies HTTP status, MIME type, and video container magic bytes,
   *    confirms the exact byte size matches the FFprobe-verified server output, and saves the file.
   */
  const handleDownloadTrimmedVideo = async (
    e?: React.MouseEvent<HTMLAnchorElement | HTMLButtonElement>,
    jobOverride?: TrimJobStatus
  ) => {
    if (e) {
      e.preventDefault();
    }
    const targetJob = jobOverride ?? activeJob;
    if (!targetJob || !targetJob.downloadUrl || isDownloadingFile || isVerifyingFfprobe) return;

    setTrimError(null);

    // Step 1: Trigger server-side FFprobe diagnostic check before initiating the download
    const verifiedDiag = await runPreDownloadDiagnostic(targetJob.jobId, false);
    if (!verifiedDiag || verifiedDiag.fileSizeBytes <= 0) {
      // Detailed server-side FFprobe error is displayed via ffprobeDiagnosticError
      return;
    }

    setIsDownloadingFile(true);
    setDownloadProgressPct(0);

    try {
      const CHUNK_SIZE = 8 * 1024 * 1024; // 8 MiB per HTTP 206 chunk
      const mimeMap: Record<string, string> = {
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'video/webm',
      };
      const expectedMime = mimeMap[targetJob.outputFormat] || 'video/mp4';

      let totalSize = verifiedDiag.fileSizeBytes || targetJob.outputSize || 0;
      const chunkBlobs: Blob[] = [];
      let offset = 0;

      while (totalSize === 0 || offset < totalSize) {
        const rangeEnd =
          totalSize > 0
            ? Math.min(offset + CHUNK_SIZE - 1, totalSize - 1)
            : offset + CHUNK_SIZE - 1;

        const res = await fetch(targetJob.downloadUrl, {
          method: 'GET',
          headers: {
            Range: `bytes=${offset}-${rangeEnd}`,
          },
          credentials: 'include',
        });

        const contentType = (res.headers.get('content-type') || '').toLowerCase();

        if (!res.ok && res.status !== 206) {
          let errMsg = `Download failed (HTTP ${res.status}).`;
          try {
            if (contentType.includes('application/json')) {
              const errJson = await res.json();
              if (errJson?.error) errMsg = errJson.error;
            }
          } catch {
            // ignore
          }
          throw new Error(errMsg);
        }

        if (contentType.includes('text/html') || contentType.includes('application/json')) {
          throw new Error(
            'Server returned a non-video response instead of binary video bytes. Please retry.'
          );
        }

        // Determine authoritative total byte size from Content-Range or X-Expected-File-Size
        const contentRange = res.headers.get('content-range');
        if (contentRange) {
          const m = contentRange.match(/\/(\d+)$/);
          if (m) {
            const parsedTotal = parseInt(m[1], 10);
            if (parsedTotal > 0) totalSize = parsedTotal;
          }
        }
        if (totalSize === 0) {
          const expectedHeader = res.headers.get('x-expected-file-size');
          const contentLen = res.headers.get('content-length');
          const parsedLen = parseInt(expectedHeader || contentLen || '0', 10);
          if (parsedLen > 0) totalSize = parsedLen;
        }

        const chunkBuffer = await res.arrayBuffer();
        if (chunkBuffer.byteLength === 0) {
          break;
        }

        // Inspect magic bytes on first chunk to ensure we never save an HTML or JSON page as .mp4
        if (offset === 0) {
          const headBytes = new Uint8Array(
            chunkBuffer.slice(0, Math.min(32, chunkBuffer.byteLength))
          );
          const headAscii = Array.from(headBytes)
            .map((b) => (b >= 32 && b <= 126 ? String.fromCharCode(b) : '.'))
            .join('');

          if (
            /^\s*(<!doctype|<html|<head|<script|\{\s*"error")/i.test(headAscii)
          ) {
            throw new Error(
              'Download blocked: received an error page instead of valid video container bytes.'
            );
          }

          if (
            (targetJob.outputFormat === 'mp4' || targetJob.outputFormat === 'mov') &&
            chunkBuffer.byteLength >= 12 &&
            !headAscii.includes('ftyp') &&
            !headAscii.includes('moov') &&
            !headAscii.includes('mdat') &&
            !headAscii.includes('free') &&
            !headAscii.includes('wide')
          ) {
            throw new Error(
              'Downloaded stream is missing a valid MP4/MOV ISO Base Media header.'
            );
          }
        }

        chunkBlobs.push(new Blob([chunkBuffer], { type: expectedMime }));
        offset += chunkBuffer.byteLength;

        if (totalSize > 0) {
          setDownloadProgressPct(Math.min(99, Math.round((offset / totalSize) * 100)));
        }

        // If server responded with 200 OK (full body in one response), we have the entire file
        if (res.status === 200) {
          break;
        }
      }

      const finalBlob = new Blob(chunkBlobs, { type: expectedMime });
      if (finalBlob.size <= 1024) {
        throw new Error(
          `Downloaded file is incomplete (${finalBlob.size} bytes). Please try again.`
        );
      }
      if (totalSize > 0 && finalBlob.size !== totalSize) {
        throw new Error(
          `Download size mismatch: received ${formatBytes(finalBlob.size)} of ${formatBytes(
            totalSize
          )}. Please try again.`
        );
      }

      setDownloadProgressPct(100);

      const blobUrl = URL.createObjectURL(finalBlob);
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = targetJob.outputFileName || `drivetrim-output.${targetJob.outputFormat}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      setTimeout(() => {
        URL.revokeObjectURL(blobUrl);
      }, 60_000);
    } catch (err: any) {
      setTrimError(err?.message || 'Failed to download the trimmed video file.');
    } finally {
      setIsDownloadingFile(false);
    }
  };

  // Confirmed Save to Google Drive action
  const executeSaveToGoogleDrive = async () => {
    if (!activeJob) return;
    setShowSaveDriveConfirm(false);
    setIsSavingToDrive(true);
    setTrimError(null);

    try {
      let token = accessToken ?? (await getAccessToken());
      if (!token) {
        const signInRes = await googleSignIn();
        if (!signInRes) {
          setIsSavingToDrive(false);
          return;
        }
        setUser(signInRes.user);
        setAccessToken(signInRes.accessToken);
        token = signInRes.accessToken;
      }

      const res = await fetch(`/api/trim/save-to-drive/${activeJob.jobId}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (!res.ok) {
        setTrimError(data.error || 'Failed to upload trimmed video to Google Drive.');
      } else {
        setSavedDriveLink({
          name: data.name,
          webViewLink: data.webViewLink,
        });
      }
    } catch (err: any) {
      setTrimError(err.message || 'Could not save video to Google Drive.');
    } finally {
      setIsSavingToDrive(false);
    }
  };

  // Derived metrics
  const totalDuration = videoMeta?.durationSeconds || 1800;
  const trimmedDuration = Math.max(0, endTime - startTime);
  const startPercent = Math.min(100, Math.max(0, (startTime / totalDuration) * 100));
  const endPercent = Math.min(100, Math.max(0, (endTime / totalDuration) * 100));
  const playheadPercent = Math.min(100, Math.max(0, (currentTime / totalDuration) * 100));

  const estimatedBytes = videoMeta?.fileSize
    ? Math.max(
        100_000,
        Math.round((trimmedDuration / Math.max(1, totalDuration)) * videoMeta.fileSize)
      )
    : Math.round(trimmedDuration * 208_333);

  // Build stream URL using opaque backend session ID (never exposing raw OAuth access tokens in DOM)
  const buildStreamUrl = () => {
    if (!videoMeta) return '';
    const base = `/api/video/stream/${encodeURIComponent(videoMeta.fileId)}`;
    const params = new URLSearchParams();
    if (useCompatFallback || videoMeta.isBrowserCompatible === false) {
      params.set('compat', '1');
    }
    const sid = backendSessionId || getBackendSessionId();
    if (sid) {
      params.set('sid', sid);
    }
    if (streamRetryCount > 0) {
      params.set('retry', String(streamRetryCount));
    }
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const streamSrcWithAuth = buildStreamUrl();

  return (
    <div className="min-h-screen bg-[#07162F] text-white relative overflow-hidden flex flex-col justify-between">
      {/* Ambient Background Glows & Filmstrip Reel Motif (Matching Reference Image) */}
      <div
        className="pointer-events-none fixed inset-0 z-0 overflow-hidden"
        aria-hidden="true"
      >
        <div className="absolute -top-40 -left-40 w-[560px] h-[560px] rounded-full bg-[#087BFF]/15 blur-[130px]" />
        <div className="absolute top-[28%] -left-24 w-[420px] h-[420px] rounded-full bg-[#00E5B0]/12 blur-[120px]" />
        <div className="absolute top-10 right-[-6%] w-[640px] h-[640px] rounded-full bg-[#087BFF]/25 blur-[140px]" />

        {/* Decorative Top-Right 3D Filmstrip Reel & Glowing Play Emblem */}
        <div className="hidden lg:block absolute top-14 right-0 w-[370px] h-[340px] select-none opacity-90">
          <svg
            viewBox="0 0 400 360"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className="w-full h-full drop-shadow-[0_0_35px_rgba(8,123,255,0.45)]"
          >
            <defs>
              <linearGradient id="reelGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#19B8FF" stopOpacity="0.45" />
                <stop offset="50%" stopColor="#087BFF" stopOpacity="0.25" />
                <stop offset="100%" stopColor="#07162F" stopOpacity="0.05" />
              </linearGradient>
              <linearGradient id="playGlowGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#B8E8FF" />
                <stop offset="50%" stopColor="#38B6FF" />
                <stop offset="100%" stopColor="#087BFF" />
              </linearGradient>
              <filter id="glowFilter" x="-30%" y="-30%" width="160%" height="160%">
                <feGaussianBlur stdDeviation="12" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            <path
              d="M420 20 C 210 35, 80 110, 85 205 C 90 295, 225 340, 420 330"
              stroke="url(#reelGrad)"
              strokeWidth="84"
              strokeLinecap="round"
              fill="none"
            />
            <path
              d="M420 20 C 210 35, 80 110, 85 205 C 90 295, 225 340, 420 330"
              stroke="#38B6FF"
              strokeOpacity="0.35"
              strokeWidth="66"
              strokeDasharray="10 14"
              fill="none"
            />
            <path
              d="M420 20 C 210 35, 80 110, 85 205 C 90 295, 225 340, 420 330"
              stroke="#07162F"
              strokeOpacity="0.85"
              strokeWidth="48"
              fill="none"
            />

            <g filter="url(#glowFilter)">
              <path
                d="M196 146 C196 139 204 135 210 139 L268 176 C274 180 274 188 268 192 L210 229 C204 233 196 229 196 222 Z"
                fill="url(#playGlowGrad)"
                stroke="#E0F6FF"
                strokeWidth="2.5"
              />
            </g>
          </svg>
        </div>
      </div>

      {/* Main Content Container */}
      <div className="relative z-10 w-full max-w-[1140px] mx-auto px-4 sm:px-6 pt-5 pb-8 flex-1 flex flex-col gap-5">
        {/* HEADER */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-1">
          <div className="flex items-start sm:items-center gap-3.5">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-[#0B2552] to-[#081A3A] border border-[#1E4682] shadow-[0_0_25px_rgba(8,123,255,0.35)] flex items-center justify-center shrink-0">
              <svg
                viewBox="0 0 40 40"
                className="w-8 h-8"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
              >
                <defs>
                  <linearGradient id="logoBlue" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0%" stopColor="#29C5FF" />
                    <stop offset="100%" stopColor="#087BFF" />
                  </linearGradient>
                </defs>
                <path
                  d="M8 7.5C8 5.4 10.4 4.1 12.2 5.3L32.5 17.8C34.2 18.8 34.2 21.2 32.5 22.2L12.2 34.7C10.4 35.9 8 34.6 8 32.5V7.5Z"
                  stroke="url(#logoBlue)"
                  strokeWidth="4.2"
                  strokeLinejoin="round"
                />
                <path d="M15 14L25 20L15 26V14Z" fill="#19B8FF" />
              </svg>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight font-display leading-none">
                  <span className="text-white">Drive</span>
                  <span className="text-[#19B8FF]">Trim</span>
                </h1>
              </div>
              <p className="text-xs sm:text-sm text-slate-300 mt-1 font-medium">
                Paste Google Drive Link <span className="text-[#19B8FF] mx-1">•</span> Trim Your
                Video <span className="text-[#19B8FF] mx-1">•</span> Download Only What You Need
              </p>
            </div>
          </div>

          {/* Right Trust Indicators & Google OAuth Button */}
          <div className="flex flex-wrap items-center gap-4 sm:gap-5 text-xs sm:text-sm text-slate-200">
            <div className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
              <Zap className="w-4 h-4 text-amber-400 fill-amber-400" />
              <span className="font-medium">Fast &amp; Secure</span>
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap shrink-0">
              <Smartphone className="w-4 h-4 text-[#19B8FF]" />
              <span className="font-medium">Works on All Devices</span>
            </div>
            <div
              className="flex items-center gap-1.5 whitespace-nowrap shrink-0"
              title="Uses HTTP 206 Partial Content byte-range streaming and FFmpeg input seeking whenever supported by the video container"
            >
              <ShieldCheck className="w-4 h-4 text-[#08B875]" />
              <span className="font-medium">No Full Download</span>
            </div>

            {user && (accessToken || backendSessionId) ? (
              <div className="flex items-center gap-2 pl-2 border-l border-[#1E3F73]">
                <button
                  type="button"
                  onClick={() => setIsDriveModalOpen(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#10264A] hover:bg-[#173566] border border-[#295496] text-xs font-semibold text-[#19B8FF] transition-colors whitespace-nowrap shrink-0"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>My Drive</span>
                </button>
                <button
                  type="button"
                  onClick={handleSignOut}
                  title={`Signed in as ${user.email || user.displayName || 'Google User'}. Click to sign out.`}
                  className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[#0A1933] hover:bg-rose-950/50 border border-[#1E3F73] text-xs text-slate-300 hover:text-rose-200 transition-colors whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={handleGoogleSignIn}
                disabled={isLoggingIn}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white hover:bg-slate-100 text-slate-800 text-xs font-semibold shadow-sm transition-all whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-60"
              >
                <svg className="w-3.5 h-3.5" viewBox="0 0 48 48">
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                <span>{isLoggingIn ? 'Signing in...' : 'Sign in with Google'}</span>
              </button>
            )}
          </div>
        </header>

        {/* STEP 2–4: GOOGLE DRIVE LINK INPUT CARD */}
        <section
          aria-label="Google Drive Video Link Input"
          className="w-full lg:max-w-[820px] rounded-2xl bg-[#10264A]/90 backdrop-blur-md border border-[#23457A] shadow-[0_12px_40px_rgba(0,0,0,0.45)] px-5 py-4 sm:px-6 sm:py-5"
        >
          <div className="flex items-start gap-4">
            <div className="hidden sm:flex w-12 h-12 rounded-xl bg-[#0B1B36] border border-[#1E3F73] items-center justify-center shrink-0 mt-1">
              <svg viewBox="0 0 87.3 78" className="w-7 h-7">
                <path
                  d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z"
                  fill="#0066da"
                />
                <path
                  d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0 -1.2 4.5h27.5z"
                  fill="#00ac47"
                />
                <path
                  d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z"
                  fill="#ea4335"
                />
                <path
                  d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z"
                  fill="#00832d"
                />
                <path
                  d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z"
                  fill="#2684fc"
                />
                <path
                  d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z"
                  fill="#ffba00"
                />
              </svg>
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-2">
                <label
                  htmlFor="drive-url-input"
                  className="text-sm sm:text-base font-bold text-white tracking-tight"
                >
                  Paste Google Drive Video Link
                </label>

                {driveUrl !== DEFAULT_DEMO_URL && (
                  <button
                    type="button"
                    onClick={() => {
                      setDriveUrl(DEFAULT_DEMO_URL);
                      handleLoadVideo(DEFAULT_DEMO_URL);
                    }}
                    className="text-xs text-[#19B8FF] hover:underline font-medium whitespace-nowrap shrink-0"
                  >
                    Load 30:00 Demo Video
                  </button>
                )}
              </div>

              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  handleLoadVideo();
                }}
                className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3"
              >
                <div className="relative flex-1">
                  <input
                    id="drive-url-input"
                    type="text"
                    value={driveUrl}
                    onChange={(e) => setDriveUrl(e.target.value)}
                    placeholder="https://drive.google.com/file/d/1abcDEFgHijklMNop/view?usp=sharing"
                    className="w-full pl-4 pr-11 py-2.5 sm:py-3 rounded-xl bg-[#0A1936] border border-[#284E8A] focus:border-[#19B8FF] focus:outline-none text-sm sm:text-base text-slate-100 placeholder-slate-400 transition-colors"
                  />
                  <button
                    type="button"
                    onClick={handlePasteClipboard}
                    title="Paste link from clipboard"
                    aria-label="Paste link from clipboard"
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-[#163160] transition-colors cursor-pointer"
                  >
                    <Link2 className="w-4 h-4" />
                  </button>
                </div>

                <button
                  type="submit"
                  disabled={isLoadingVideo}
                  className="px-5 py-2.5 sm:py-3 rounded-xl bg-gradient-to-r from-[#087BFF] to-[#19A8FF] hover:from-[#076CE0] hover:to-[#087BFF] text-white font-bold text-sm sm:text-base shadow-[0_4px_20px_rgba(8,123,255,0.45)] flex items-center justify-center gap-2 transition-all cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  {isLoadingVideo ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <span>Loading...</span>
                    </>
                  ) : (
                    <>
                      <span>Load Video</span>
                      <ArrowRight className="w-4 h-4" />
                    </>
                  )}
                </button>
              </form>

              {/* Validation & Metadata Status Bar */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                {loadError ? (
                  <div className="flex flex-wrap items-center gap-2.5 text-xs sm:text-sm text-rose-300 bg-rose-950/40 border border-rose-500/35 px-3.5 py-2 rounded-xl w-full">
                    <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                    <span className="flex-1">{loadError.message}</span>
                    {(loadError.code === 'ACCESS_DENIED' ||
                      loadError.code === 'AUTH_REQUIRED' ||
                      loadError.code === 'QUOTA_EXCEEDED') && (
                      <button
                        type="button"
                        onClick={handleGoogleSignIn}
                        className="px-3 py-1 rounded-lg bg-[#087BFF] hover:bg-[#076CE0] text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                      >
                        {user ? 'Reconnect Google Account' : 'Connect Google Account'}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleLoadVideo()}
                      className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0"
                    >
                      Retry
                    </button>
                  </div>
                ) : videoMeta ? (
                  <div className="flex flex-wrap items-center gap-2.5 text-xs sm:text-sm">
                    <div className="flex items-center gap-2 text-[#08B875] font-semibold">
                      <CheckCircle2 className="w-4 h-4 fill-[#08B875] text-[#07162F]" />
                      <span className="text-slate-100">Video loaded successfully!</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-slate-300">
                      <span>Duration:</span>
                      <span className="px-2.5 py-0.5 rounded-md bg-[#183462] border border-[#2B528E] text-white font-mono font-bold tabular-nums">
                        {formatTimeDisplay(videoMeta.durationSeconds)}
                      </span>
                    </div>
                    <span className="hidden md:inline text-slate-500">·</span>
                    <span className="hidden md:inline text-xs text-slate-300 truncate max-w-[220px]">
                      {videoMeta.fileName}
                    </span>
                    <span className="hidden sm:inline text-slate-500">·</span>
                    <span className="hidden sm:inline text-xs text-[#19B8FF] font-mono tabular-nums">
                      {useCompatFallback || videoMeta.isBrowserCompatible === false
                        ? `H.264 Preview Proxy (${videoMeta.videoCodec.toUpperCase()} Source)`
                        : videoMeta.supportsRange
                        ? 'HTTP 206 Byte-Range Ready'
                        : 'Sequential Stream'}
                    </span>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </section>

        {/* STEP 5: VIDEO PREVIEW PLAYER */}
        {videoMeta && (
          <section aria-label="Video Preview Player" className="w-full">
            <div
              ref={playerContainerRef}
              className="relative w-full rounded-2xl overflow-hidden bg-[#040C1B] border border-[#24487F] shadow-[0_18px_50px_rgba(0,0,0,0.6)] group"
            >
              <div className="relative w-full aspect-[16/7] min-h-[220px] max-h-[420px] bg-black flex items-center justify-center overflow-hidden">
                <video
                  ref={videoRef}
                  key={streamSrcWithAuth}
                  src={streamSrcWithAuth}
                  preload="auto"
                  playsInline
                  onClick={togglePlayPause}
                  onLoadStart={() => {
                    const vid = videoRef.current;
                    console.log('[DriveTrim:Player:onLoadStart]', {
                      fileId: videoMeta.fileId,
                      src: vid?.currentSrc?.replace(/sid=[^&]+/, 'sid=[REDACTED]'),
                      networkState: vid?.networkState,
                      readyState: vid?.readyState,
                    });
                  }}
                  onLoadedMetadata={() => {
                    const vid = videoRef.current;
                    const detectedDuration =
                      vid && Number.isFinite(vid.duration) && vid.duration > 0
                        ? Math.floor(vid.duration)
                        : 0;
                    console.log('[DriveTrim:Player:onLoadedMetadata]', {
                      fileId: videoMeta.fileId,
                      duration: vid?.duration,
                      videoWidth: vid?.videoWidth,
                      videoHeight: vid?.videoHeight,
                      readyState: vid?.readyState,
                    });
                    setIsPlayerReady(true);
                    setIsBuffering(false);
                    setPlayerErrorMsg(null);

                    // If backend ffprobe had durationSeconds === 0 (e.g. moov atom at end of file),
                    // backfill duration and dimensions from the browser's native media element!
                    if (detectedDuration > 0 && (!videoMeta.durationSeconds || videoMeta.durationSeconds <= 0)) {
                      setVideoMeta((prev) =>
                        prev
                          ? {
                              ...prev,
                              durationSeconds: detectedDuration,
                              width: vid?.videoWidth || prev.width,
                              height: vid?.videoHeight || prev.height,
                            }
                          : prev
                      );
                      const defaultStart =
                        detectedDuration > 10 ? Math.floor(detectedDuration * 0.2) : 0;
                      const defaultEnd =
                        detectedDuration > 10
                          ? Math.min(
                              detectedDuration,
                              Math.max(defaultStart + 5, Math.floor(detectedDuration * 0.5))
                            )
                          : detectedDuration;
                      setStartTime(defaultStart);
                      setEndTime(defaultEnd);
                      loadThumbnailsProgressively(
                        videoMeta.fileId,
                        detectedDuration,
                        backendSessionId
                      );
                    }
                  }}
                  onLoadedData={() => {
                    const vid = videoRef.current;
                    console.log('[DriveTrim:Player:onLoadedData]', {
                      fileId: videoMeta.fileId,
                      readyState: vid?.readyState,
                      currentTime: vid?.currentTime,
                    });
                  }}
                  onCanPlay={() => {
                    const vid = videoRef.current;
                    const bufferedRanges: string[] = [];
                    if (vid && vid.buffered) {
                      for (let i = 0; i < vid.buffered.length; i++) {
                        bufferedRanges.push(
                          `${vid.buffered.start(i).toFixed(1)}s-${vid.buffered.end(i).toFixed(1)}s`
                        );
                      }
                    }
                    console.log('[DriveTrim:Player:onCanPlay]', {
                      fileId: videoMeta.fileId,
                      readyState: vid?.readyState,
                      bufferedRanges,
                    });
                    setIsPlayerReady(true);
                    setIsBuffering(false);
                    setPlayerErrorMsg(null);
                  }}
                  onWaiting={() => {
                    console.log('[DriveTrim:Player:onWaiting]', {
                      fileId: videoMeta.fileId,
                      currentTime: videoRef.current?.currentTime,
                    });
                    setIsBuffering(true);
                  }}
                  onStalled={() => {
                    console.warn('[DriveTrim:Player:onStalled]', {
                      fileId: videoMeta.fileId,
                      currentTime: videoRef.current?.currentTime,
                      networkState: videoRef.current?.networkState,
                    });
                  }}
                  onSeeking={() => {
                    console.log('[DriveTrim:Player:onSeeking]', {
                      fileId: videoMeta.fileId,
                      targetTime: videoRef.current?.currentTime,
                    });
                  }}
                  onSeeked={() => {
                    console.log('[DriveTrim:Player:onSeeked]', {
                      fileId: videoMeta.fileId,
                      currentTime: videoRef.current?.currentTime,
                    });
                  }}
                  onPlaying={() => {
                    setIsPlaying(true);
                    setIsBuffering(false);
                    setPlayerErrorMsg(null);
                  }}
                  onPlay={() => setIsPlaying(true)}
                  onPause={() => setIsPlaying(false)}
                  onTimeUpdate={handleTimeUpdate}
                  onError={() => {
                    const vid = videoRef.current;
                    const mediaErr = vid?.error;
                    const errCode = mediaErr?.code || 0;
                    console.error('[DriveTrim:Player:onError]', {
                      fileId: videoMeta.fileId,
                      errorCode: errCode,
                      errorMessage: mediaErr?.message,
                      networkState: vid?.networkState,
                      readyState: vid?.readyState,
                      useCompatFallback,
                      streamRetryCount,
                    });
                    fetch(`/api/video/debug-logs?fileId=${encodeURIComponent(videoMeta.fileId)}`)
                      .then((r) => r.json())
                      .then((diag) => {
                        console.error('[DriveTrim:ServerStreamDiagnostics]', diag);
                      })
                      .catch(() => {});

                    // 1. If codec/format error and not yet in compatibility mode, switch to H.264 compatibility stream
                    if (!useCompatFallback) {
                      console.warn(
                        '[DriveTrim:Player] Switching to H.264 compatibility preview proxy (?compat=1)...'
                      );
                      setUseCompatFallback(true);
                      return;
                    }

                    // 2. Retry once with fresh stream session before surfacing an error
                    if (streamRetryCount < 1) {
                      setTimeout(() => {
                        setStreamRetryCount((c) => c + 1);
                      }, 400);
                      return;
                    }

                    setPlayerErrorMsg(
                      'Unable to decode this video stream in your browser. Try signing in with Google or clicking Reload Stream.'
                    );
                  }}
                  className="w-full h-full object-cover cursor-pointer"
                />

                {/* Technical Stream & Timecode Overlay (Toggled by CC button) */}
                {showTechOverlay && (
                  <div className="absolute top-3 left-3 z-20 bg-[#07162F]/85 backdrop-blur-md border border-[#28508C] rounded-xl px-3.5 py-2 text-xs font-mono tabular-nums text-slate-200 pointer-events-none space-y-0.5">
                    <div className="text-[#19B8FF] font-semibold">
                      Stream: HTTP 206 Partial Content ({videoMeta.videoCodec.toUpperCase()}
                      {videoMeta.pixFmt ? ` ${videoMeta.pixFmt}` : ''}
                      {videoMeta.audioCodec ? ` / ${videoMeta.audioCodec.toUpperCase()}` : ''})
                    </div>
                    <div>
                      Resolution: {videoMeta.width}×{videoMeta.height} · Total Size:{' '}
                      {formatBytes(videoMeta.fileSize)} · Ready:{' '}
                      {isPlayerReady ? 'Yes' : 'Buffering'}
                    </div>
                    <div>
                      Playhead: {formatTimeHMS(currentTime)} · Selected:{' '}
                      {formatTimeHMS(startTime)} → {formatTimeHMS(endTime)}
                    </div>
                  </div>
                )}

                {playerErrorMsg && (
                  <div className="absolute inset-0 z-30 bg-[#07162F]/90 flex flex-col items-center justify-center p-6 text-center gap-3">
                    <AlertCircle className="w-8 h-8 text-rose-400" />
                    <p className="text-sm text-slate-200 max-w-md">{playerErrorMsg}</p>
                    <div className="flex flex-wrap items-center justify-center gap-2.5">
                      {!user && (
                        <button
                          type="button"
                          onClick={handleGoogleSignIn}
                          className="px-4 py-2 rounded-xl bg-white hover:bg-slate-100 text-xs font-semibold text-slate-800 cursor-pointer"
                        >
                          Sign in with Google
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => handleLoadVideo()}
                        className="px-4 py-2 rounded-xl bg-[#087BFF] hover:bg-[#076CE0] text-xs font-semibold text-white cursor-pointer"
                      >
                        Reload Stream
                      </button>
                    </div>
                  </div>
                )}

                {/* Center Translucent Play/Pause Button (Matches Reference Image) */}
                <button
                  type="button"
                  onClick={togglePlayPause}
                  aria-label={isPlaying ? 'Pause video' : 'Play video'}
                  className={`w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-[#091832]/65 hover:bg-[#087BFF]/80 border-2 border-white/60 backdrop-blur-md flex items-center justify-center transition-all duration-200 shadow-[0_0_30px_rgba(0,0,0,0.6)] cursor-pointer ${
                    isPlaying && !isBuffering
                      ? 'opacity-0 group-hover:opacity-100'
                      : 'opacity-100'
                  }`}
                >
                  {isBuffering ? (
                    <Loader2 className="w-7 h-7 sm:w-8 sm:h-8 text-[#19B8FF] animate-spin" />
                  ) : isPlaying ? (
                    <Pause className="w-7 h-7 sm:w-8 sm:h-8 text-white fill-white" />
                  ) : (
                    <Play className="w-7 h-7 sm:w-8 sm:h-8 text-white fill-white ml-1" />
                  )}
                </button>
              </div>

              {/* Bottom Video Control Bar */}
              <div className="bg-gradient-to-t from-[#050E20] via-[#07152E]/95 to-[#07152E]/80 px-4 sm:px-5 py-2.5 flex items-center gap-3 sm:gap-4 border-t border-white/10">
                <button
                  type="button"
                  onClick={togglePlayPause}
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                  className="text-white hover:text-[#19B8FF] transition-colors p-1 cursor-pointer shrink-0"
                >
                  {isPlaying ? (
                    <Pause className="w-5 h-5 fill-current" />
                  ) : (
                    <Play className="w-5 h-5 fill-current" />
                  )}
                </button>

                <div className="flex flex-col shrink-0">
                  <span className="text-xs sm:text-sm font-mono tabular-nums font-semibold text-white">
                    {formatTimeDisplay(currentTime)} / {formatTimeDisplay(totalDuration)}
                  </span>
                  <div className="h-0.5 w-full bg-gradient-to-r from-[#087BFF] to-transparent rounded-full mt-0.5" />
                </div>

                {/* Interactive Video Progress Bar */}
                <div
                  className="relative flex-1 h-6 flex items-center cursor-pointer group/scrub"
                  onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = Math.min(
                      1,
                      Math.max(0, (e.clientX - rect.left) / rect.width)
                    );
                    const newTime = pct * totalDuration;
                    setCurrentTime(newTime);
                    if (videoRef.current) {
                      videoRef.current.currentTime = newTime;
                    }
                  }}
                >
                  <div className="w-full h-1.5 rounded-full bg-white/20 overflow-hidden relative">
                    <div
                      className="absolute top-0 bottom-0 bg-[#087BFF]/45"
                      style={{
                        left: `${startPercent}%`,
                        width: `${Math.max(0, endPercent - startPercent)}%`,
                      }}
                    />
                    <div
                      className="h-full bg-[#19B8FF] rounded-full"
                      style={{ width: `${playheadPercent}%` }}
                    />
                  </div>
                  <div
                    className="w-3 h-3 rounded-full bg-[#19B8FF] shadow-[0_0_8px_#19B8FF] absolute -translate-x-1/2 transition-transform group-hover/scrub:scale-125"
                    style={{ left: `${playheadPercent}%` }}
                  />
                </div>

                {/* Right Player Controls */}
                <div className="flex items-center gap-2 sm:gap-3 shrink-0">
                  <button
                    type="button"
                    onClick={handlePlaySelectedRange}
                    title="Preview selected trim segment"
                    className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-[#122B54] hover:bg-[#193B73] border border-[#2A5394] text-[11px] font-semibold text-[#19B8FF] transition-colors cursor-pointer whitespace-nowrap shrink-0"
                  >
                    <Play className="w-3 h-3 fill-current" />
                    <span>Preview Cut</span>
                  </button>

                  <div className="flex items-center gap-1.5 group/vol">
                    <button
                      type="button"
                      onClick={handleToggleMute}
                      aria-label={isMuted ? 'Unmute' : 'Mute'}
                      className="text-slate-200 hover:text-white p-1 transition-colors cursor-pointer"
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX className="w-5 h-5" />
                      ) : (
                        <Volume2 className="w-5 h-5" />
                      )}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={isMuted ? 0 : volume}
                      onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                      aria-label="Volume"
                      className="hidden md:block w-16 accent-[#19B8FF] cursor-pointer h-1 bg-white/25 rounded-lg"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={() => setShowTechOverlay((v) => !v)}
                    title="Toggle stream & timecode info overlay"
                    aria-pressed={showTechOverlay}
                    className={`px-1.5 py-0.5 rounded border text-[11px] font-bold tracking-tight transition-colors cursor-pointer ${
                      showTechOverlay
                        ? 'bg-[#087BFF] border-[#19B8FF] text-white'
                        : 'border-white/60 text-white/90 hover:border-white'
                    }`}
                  >
                    CC
                  </button>

                  <button
                    type="button"
                    onClick={handleToggleFullscreen}
                    aria-label="Toggle Fullscreen"
                    className="text-slate-200 hover:text-white p-1 transition-colors cursor-pointer"
                  >
                    {isFullscreen ? (
                      <Minimize className="w-4 h-4" />
                    ) : (
                      <Maximize className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* STEP 6 & 7: SELECT TRIM RANGE & INTERACTIVE FILMSTRIP TIMELINE */}
        {videoMeta && (
          <section
            aria-label="Select Trim Range"
            className="w-full rounded-2xl bg-[#10264A]/90 backdrop-blur-md border border-[#23457A] shadow-[0_12px_40px_rgba(0,0,0,0.45)] px-5 py-4 sm:px-6 sm:py-5"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
              <div className="flex items-center gap-2.5">
                <Scissors className="w-5 h-5 text-white -rotate-45" />
                <h2 className="text-base sm:text-lg font-bold text-white tracking-tight">
                  Select Trim Range
                </h2>
              </div>

              <div className="flex flex-wrap items-center gap-2.5 sm:gap-3">
                <div className="flex items-center gap-1.5 bg-[#091834] border border-[#244880] rounded-xl px-2.5 py-1">
                  <label
                    htmlFor="start-time-input"
                    className="text-[11px] text-slate-300 font-medium whitespace-nowrap"
                  >
                    Start:
                  </label>
                  <input
                    id="start-time-input"
                    type="text"
                    value={startInputText}
                    onChange={(e) => setStartInputText(e.target.value)}
                    onBlur={commitManualStartInput}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitManualStartInput();
                    }}
                    aria-label="Start Time HH:MM:SS"
                    className="w-[72px] bg-transparent text-xs font-mono tabular-nums font-bold text-[#19B8FF] focus:outline-none text-center"
                  />
                </div>

                <div className="flex items-center gap-1.5 bg-[#091834] border border-[#244880] rounded-xl px-2.5 py-1">
                  <label
                    htmlFor="end-time-input"
                    className="text-[11px] text-slate-300 font-medium whitespace-nowrap"
                  >
                    End:
                  </label>
                  <input
                    id="end-time-input"
                    type="text"
                    value={endInputText}
                    onChange={(e) => setEndInputText(e.target.value)}
                    onBlur={commitManualEndInput}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitManualEndInput();
                    }}
                    aria-label="End Time HH:MM:SS"
                    className="w-[72px] bg-transparent text-xs font-mono tabular-nums font-bold text-[#19B8FF] focus:outline-none text-center"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleResetSelection}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[#132C58] hover:bg-[#1B3B73] border border-[#2C5494] text-xs sm:text-sm font-semibold text-slate-100 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  <span>Reset</span>
                </button>
              </div>
            </div>

            {timeInputError && (
              <div className="mb-3 text-xs text-amber-300 bg-amber-950/40 border border-amber-500/30 rounded-lg px-3 py-1.5 flex items-center gap-2">
                <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span>{timeInputError}</span>
              </div>
            )}

            {/* Interactive Filmstrip Timeline Container */}
            <div className="pt-8 pb-1 select-none">
              <div
                ref={timelineTrackRef}
                onClick={(e) => {
                  if (activeDragHandle) return;
                  const rect = e.currentTarget.getBoundingClientRect();
                  const ratio = Math.min(
                    1,
                    Math.max(0, (e.clientX - rect.left) / rect.width)
                  );
                  const clickedSec = Math.round(ratio * totalDuration);
                  setCurrentTime(clickedSec);
                  if (videoRef.current) {
                    videoRef.current.currentTime = clickedSec;
                  }
                }}
                className="relative w-full h-14 sm:h-16 rounded-xl bg-[#07142B] border border-[#2B528C] overflow-visible cursor-pointer"
              >
                <div className="absolute inset-0 rounded-xl overflow-hidden flex flex-col justify-between bg-[#061226]">
                  <div className="w-full h-1.5 bg-[#050E1F] filmstrip-sprockets-top opacity-80 z-10" />

                  {/* Progressive Frame Thumbnails Row */}
                  <div className="flex-1 w-full grid grid-cols-12 overflow-hidden relative">
                    {thumbnailSlots.map((slotUrl, idx) => (
                      <div
                        key={idx}
                        className="h-full w-full border-r border-black/40 last:border-r-0 overflow-hidden bg-gradient-to-b from-[#13396E] via-[#17486B] to-[#0B2239] relative"
                      >
                        {slotUrl ? (
                          <img
                            src={slotUrl}
                            alt={`Timeline frame ${idx + 1}`}
                            className="w-full h-full object-cover pointer-events-none select-none transition-opacity duration-300"
                          />
                        ) : (
                          <div className="absolute inset-0 animate-pulse bg-white/5" />
                        )}
                      </div>
                    ))}
                  </div>

                  <div className="w-full h-1.5 bg-[#050E1F] filmstrip-sprockets-bottom opacity-80 z-10" />

                  <div
                    className="absolute top-0 bottom-0 left-0 bg-[#040C1C]/60 pointer-events-none z-10"
                    style={{ width: `${startPercent}%` }}
                  />
                  <div
                    className="absolute top-0 bottom-0 right-0 bg-[#040C1C]/60 pointer-events-none z-10"
                    style={{ width: `${Math.max(0, 100 - endPercent)}%` }}
                  />
                </div>

                {/* Highlighted Blue Active Trim Window */}
                <div
                  className="absolute top-0 bottom-0 bg-[#087BFF]/35 border-y-2 border-[#63B8FF] shadow-[0_0_25px_rgba(8,123,255,0.45)] pointer-events-none z-20"
                  style={{
                    left: `${startPercent}%`,
                    width: `${Math.max(0.5, endPercent - startPercent)}%`,
                  }}
                />

                {/* Live Playhead Vertical Indicator Line */}
                <div
                  className="absolute -top-1 -bottom-1 w-0.5 bg-white/90 shadow-[0_0_6px_#fff] pointer-events-none z-20"
                  style={{ left: `${playheadPercent}%` }}
                />

                {/* LEFT DRAGGABLE HANDLE (START TIME) */}
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label="Start Time Handle"
                  aria-valuemin={0}
                  aria-valuemax={endTime - 1}
                  aria-valuenow={startTime}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setActiveDragHandle('start');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') {
                      setStartTime((s) => Math.max(0, s - 5));
                    } else if (e.key === 'ArrowRight') {
                      setStartTime((s) => Math.min(endTime - 1, s + 5));
                    }
                  }}
                  style={{ left: `${startPercent}%` }}
                  className="absolute -top-1 -bottom-1 -translate-x-1/2 w-6 flex items-center justify-center cursor-ew-resize z-30 touch-none group/handle"
                >
                  <div className="absolute -top-9 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-lg bg-[#087BFF] text-white font-mono tabular-nums font-bold text-xs shadow-[0_4px_14px_rgba(8,123,255,0.65)] whitespace-nowrap">
                    {formatTimeDisplay(startTime)}
                    <div className="w-2 h-2 bg-[#087BFF] rotate-45 absolute -bottom-1 left-1/2 -translate-x-1/2" />
                  </div>
                  <div className="w-3.5 h-full rounded-full bg-gradient-to-b from-[#7CC8FF] via-[#2898FF] to-[#087BFF] border border-white/80 shadow-[0_0_15px_rgba(25,184,255,0.8)] flex items-center justify-center group-hover/handle:scale-105 transition-transform">
                    <div className="w-0.5 h-5 bg-[#07162F]/60 rounded-full" />
                  </div>
                </div>

                {/* RIGHT DRAGGABLE HANDLE (END TIME) */}
                <div
                  role="slider"
                  tabIndex={0}
                  aria-label="End Time Handle"
                  aria-valuemin={startTime + 1}
                  aria-valuemax={totalDuration}
                  aria-valuenow={endTime}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    setActiveDragHandle('end');
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'ArrowLeft') {
                      setEndTime((s) => Math.max(startTime + 1, s - 5));
                    } else if (e.key === 'ArrowRight') {
                      setEndTime((s) => Math.min(totalDuration, s + 5));
                    }
                  }}
                  style={{ left: `${endPercent}%` }}
                  className="absolute -top-1 -bottom-1 -translate-x-1/2 w-6 flex items-center justify-center cursor-ew-resize z-30 touch-none group/handle"
                >
                  <div className="absolute -top-9 left-1/2 -translate-x-1/2 px-2.5 py-1 rounded-lg bg-[#087BFF] text-white font-mono tabular-nums font-bold text-xs shadow-[0_4px_14px_rgba(8,123,255,0.65)] whitespace-nowrap">
                    {formatTimeDisplay(endTime)}
                    <div className="w-2 h-2 bg-[#087BFF] rotate-45 absolute -bottom-1 left-1/2 -translate-x-1/2" />
                  </div>
                  <div className="w-3.5 h-full rounded-full bg-gradient-to-b from-[#7CC8FF] via-[#2898FF] to-[#087BFF] border border-white/80 shadow-[0_0_15px_rgba(25,184,255,0.8)] flex items-center justify-center group-hover/handle:scale-105 transition-transform">
                    <div className="w-0.5 h-5 bg-[#07162F]/60 rounded-full" />
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs sm:text-sm font-mono tabular-nums text-slate-300 mt-2.5 px-0.5">
                <span>00:00</span>
                <span>{formatTimeDisplay(totalDuration)}</span>
              </div>
            </div>
          </section>
        )}

        {/* STEP 8–10: DOWNLOAD & PROCESSING BAR */}
        {videoMeta && (
          <section
            aria-label="Trim Summary and Download"
            className="w-full rounded-2xl bg-[#10264A]/90 backdrop-blur-md border border-[#23457A] shadow-[0_12px_40px_rgba(0,0,0,0.45)] px-5 py-3.5 sm:px-6 sm:py-4 flex flex-col gap-4"
          >
            <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3 sm:gap-5 text-sm">
                <div className="flex items-center gap-2">
                  <Clock className="w-4 h-4 text-slate-300 shrink-0" />
                  <span className="text-slate-200 font-medium">Trimmed Duration:</span>
                  <span className="px-3 py-1 rounded-lg bg-[#087BFF] text-white font-mono tabular-nums font-bold text-xs sm:text-sm shadow-[0_2px_10px_rgba(8,123,255,0.45)]">
                    {formatTimeDisplay(trimmedDuration)}
                  </span>
                </div>

                <div className="hidden sm:block h-6 w-px bg-[#254B85]" />

                <div className="flex items-center gap-2">
                  <FileText className="w-4 h-4 text-slate-300 shrink-0" />
                  <span className="text-slate-200 font-medium">Estimated Size:</span>
                  <span className="text-white font-mono tabular-nums font-bold">
                    {formatBytes(estimatedBytes, true)}
                  </span>
                </div>

                <div className="hidden md:block h-6 w-px bg-[#254B85]" />

                <div className="flex items-center gap-2">
                  <select
                    aria-label="Output video format"
                    value={outputFormat}
                    onChange={(e) =>
                      setOutputFormat(e.target.value as 'mp4' | 'mov' | 'webm')
                    }
                    className="px-2.5 py-1.5 rounded-lg bg-[#091834] border border-[#28508C] text-xs font-semibold text-slate-200 focus:outline-none focus:border-[#19B8FF] cursor-pointer"
                  >
                    <option value="mp4">MP4</option>
                    <option value="mov">MOV</option>
                    <option value="webm">WebM</option>
                  </select>

                  <div
                    className="inline-flex items-center p-0.5 rounded-lg bg-[#091834] border border-[#28508C]"
                    role="group"
                    aria-label="Trimming Engine Mode"
                  >
                    <button
                      type="button"
                      onClick={() => setTrimMode('copy')}
                      title="Fast Stream Copy: Instant keyframe extraction with AAC audio sync"
                      className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        trimMode === 'copy'
                          ? 'bg-[#087BFF] text-white'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      Fast Copy
                    </button>
                    <button
                      type="button"
                      onClick={() => setTrimMode('reencode')}
                      title="Frame-Accurate Re-encode: Exact frame boundary H.264/AAC cutting"
                      className={`px-2.5 py-1 rounded-md text-xs font-semibold transition-colors cursor-pointer whitespace-nowrap shrink-0 ${
                        trimMode === 'reencode'
                          ? 'bg-[#087BFF] text-white'
                          : 'text-slate-300 hover:text-white'
                      }`}
                    >
                      Accurate Cut
                    </button>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-end">
                <button
                  type="button"
                  onClick={() => handleStartTrimJob(false)}
                  disabled={
                    isStartingTrim ||
                    activeJob?.status === 'starting' ||
                    activeJob?.status === 'processing'
                  }
                  className="w-full sm:w-auto px-6 py-3 rounded-xl bg-gradient-to-r from-[#08B875] to-[#069E63] hover:from-[#07A368] hover:to-[#058A56] text-white font-bold text-sm sm:text-base shadow-[0_6px_24px_rgba(8,184,117,0.4)] flex items-center justify-center gap-2.5 transition-all cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
                >
                  {isStartingTrim ||
                  activeJob?.status === 'starting' ||
                  activeJob?.status === 'processing' ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Processing Segment...</span>
                    </>
                  ) : (
                    <>
                      <Download className="w-5 h-5" />
                      <span>Download Trimmed Video</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            {/* Active Processing Progress Panel */}
            {activeJob &&
              (activeJob.status === 'starting' ||
                activeJob.status === 'processing') && (
                <div className="p-4 rounded-xl bg-[#091834] border border-[#264E8A] space-y-2.5">
                  <div className="flex items-center justify-between gap-2 text-xs sm:text-sm">
                    <div className="flex items-center gap-2 text-[#19B8FF] font-semibold">
                      <Loader2 className="w-4 h-4 animate-spin shrink-0" />
                      <span>{activeJob.statusMessage}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="font-mono tabular-nums font-bold text-white">
                        {activeJob.progressPercent}%
                      </span>
                      <button
                        type="button"
                        onClick={handleCancelJob}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-rose-950/60 hover:bg-rose-900/80 border border-rose-500/40 text-xs font-semibold text-rose-200 transition-colors cursor-pointer"
                      >
                        <XCircle className="w-3.5 h-3.5" />
                        <span>Cancel</span>
                      </button>
                    </div>
                  </div>
                  <div className="w-full h-2 rounded-full bg-[#050E21] overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-[#087BFF] to-[#19B8FF] transition-all duration-300"
                      style={{ width: `${activeJob.progressPercent}%` }}
                    />
                  </div>
                </div>
              )}

            {/* Error Notification Banner */}
            {trimError && (
              <div className="p-3.5 rounded-xl bg-rose-950/40 border border-rose-500/35 flex items-center justify-between gap-3 text-xs sm:text-sm text-rose-200">
                <div className="flex items-center gap-2">
                  <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                  <span>{trimError}</span>
                </div>
                <button
                  type="button"
                  onClick={() => handleStartTrimJob(false)}
                  className="px-3 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Completion Interface (STEP 9 & 10) */}
            {activeJob && activeJob.status === 'completed' && activeJob.downloadUrl && (
              <div className="p-4 sm:p-5 rounded-xl bg-gradient-to-r from-[#082A38] via-[#0B2548] to-[#0A1F40] border border-[#08B875]/50 shadow-lg flex flex-col gap-4">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-[#08B875] font-bold text-sm sm:text-base">
                      <Sparkles className="w-4 h-4" />
                      <span>Video Successfully Trimmed!</span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs sm:text-sm text-slate-200 font-mono tabular-nums">
                      <span>
                        Original Duration:{' '}
                        <strong className="text-white">
                          {formatTimeDisplay(activeJob.originalDuration)}
                        </strong>
                      </span>
                      <span>·</span>
                      <span>
                        Selected Duration:{' '}
                        <strong className="text-[#19B8FF]">
                          {formatTimeDisplay(activeJob.clipDuration)}
                        </strong>
                      </span>
                      <span>·</span>
                      <span>
                        Output Format:{' '}
                        <strong className="text-white uppercase">
                          {activeJob.outputFormat}
                        </strong>
                      </span>
                      <span>·</span>
                      <span>
                        Verified Size:{' '}
                        <strong className="text-[#08B875]">
                          {formatBytes(activeJob.outputSize)}
                        </strong>
                      </span>
                    </div>

                    {savedDriveLink && (
                      <div className="pt-1 text-xs text-[#19B8FF]">
                        Saved to Google Drive:{' '}
                        <a
                          href={savedDriveLink.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="underline font-semibold hover:text-white"
                        >
                          {savedDriveLink.name} (Open in Drive)
                        </a>
                      </div>
                    )}
                  </div>

                  <div className="flex flex-wrap items-center gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => {
                        if (showDiagnosticPanel && (ffprobeDiagnostic || ffprobeDiagnosticError)) {
                          setShowDiagnosticPanel(false);
                        } else {
                          runPreDownloadDiagnostic(activeJob.jobId, true);
                        }
                      }}
                      disabled={isVerifyingFfprobe}
                      title="Run live server-side FFprobe container & byte-size diagnostic check"
                      className="px-3.5 py-2.5 rounded-xl bg-[#0D2347] hover:bg-[#143366] border border-[#2B579A] text-white text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
                    >
                      {isVerifyingFfprobe ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin text-[#19B8FF]" />
                          <span>Running FFprobe...</span>
                        </>
                      ) : (
                        <>
                          <ShieldCheck className="w-4 h-4 text-[#08B875]" />
                          <span>
                            {showDiagnosticPanel ? 'Hide FFprobe Report' : 'FFprobe Diagnostic'}
                          </span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={() => setShowTrimmedPreview((v) => !v)}
                      className="px-3.5 py-2.5 rounded-xl bg-[#122D59] hover:bg-[#193B73] border border-[#2C589E] text-white text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap shrink-0"
                    >
                      <Eye className="w-4 h-4 text-[#19B8FF]" />
                      <span>{showTrimmedPreview ? 'Hide Clip Preview' : 'Verify Clip'}</span>
                    </button>

                    <a
                      href={activeJob.downloadUrl}
                      download={activeJob.outputFileName}
                      onClick={(e) => handleDownloadTrimmedVideo(e, activeJob)}
                      className={`px-4 py-2.5 rounded-xl bg-[#08B875] hover:bg-[#07A368] text-white text-xs sm:text-sm font-bold shadow-md flex items-center gap-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                        isDownloadingFile || isVerifyingFfprobe
                          ? 'opacity-80 pointer-events-none'
                          : ''
                      }`}
                    >
                      {isVerifyingFfprobe ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Verifying FFprobe...</span>
                        </>
                      ) : isDownloadingFile ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Downloading {downloadProgressPct}%...</span>
                        </>
                      ) : (
                        <>
                          <Download className="w-4 h-4" />
                          <span>Download Video ({activeJob.outputFormat.toUpperCase()})</span>
                        </>
                      )}
                    </a>

                    <button
                      type="button"
                      onClick={() => setShowSaveDriveConfirm(true)}
                      disabled={isSavingToDrive}
                      className="px-3.5 py-2.5 rounded-xl bg-[#087BFF] hover:bg-[#076CE0] text-white text-xs sm:text-sm font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 whitespace-nowrap shrink-0"
                    >
                      {isSavingToDrive ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          <span>Saving to Drive...</span>
                        </>
                      ) : (
                        <>
                          <CloudUpload className="w-4 h-4" />
                          <span>Save to Drive</span>
                        </>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={handleCleanupJob}
                      title="Delete temporary processed file from server"
                      className="p-2.5 rounded-xl bg-[#091834] hover:bg-rose-950/60 border border-[#264E8A] text-slate-300 hover:text-rose-200 transition-colors cursor-pointer"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Detailed Server-Side FFprobe Pre-Download Error Diagnostic Panel */}
                {ffprobeDiagnosticError && (
                  <div className="p-4 rounded-xl bg-rose-950/70 border border-rose-500/60 text-rose-100 space-y-2.5 text-xs">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-2 font-bold text-rose-300 text-xs sm:text-sm">
                        <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
                        <span>Pre-Download FFprobe Check Failed — Download Blocked</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => runPreDownloadDiagnostic(activeJob.jobId, true)}
                        className="px-2.5 py-1 rounded-lg bg-rose-900/80 hover:bg-rose-800 border border-rose-400/40 text-white font-semibold transition-colors cursor-pointer shrink-0"
                      >
                        Re-run FFprobe Check
                      </button>
                    </div>
                    <p className="text-rose-200 font-medium">{ffprobeDiagnosticError.message}</p>

                    {ffprobeDiagnosticError.diagnostic && (
                      <div className="p-3 rounded-lg bg-black/50 border border-rose-500/30 font-mono text-[11px] space-y-1.5 overflow-x-auto">
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-rose-200/90">
                          <div>
                            <span className="text-slate-400">Failure Stage:</span>{' '}
                            <strong className="text-rose-300">
                              {ffprobeDiagnosticError.diagnostic.stage}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-400">File Exists on Server:</span>{' '}
                            <strong>
                              {ffprobeDiagnosticError.diagnostic.fileExists ? 'Yes' : 'No'}
                            </strong>
                          </div>
                          <div>
                            <span className="text-slate-400">File Size:</span>{' '}
                            <strong>
                              {ffprobeDiagnosticError.diagnostic.fileSizeBytes.toLocaleString()}{' '}
                              bytes
                            </strong>
                          </div>
                        </div>

                        {ffprobeDiagnosticError.diagnostic.ffprobeExitCode !== undefined &&
                          ffprobeDiagnosticError.diagnostic.ffprobeExitCode !== null && (
                            <div>
                              <span className="text-slate-400">FFprobe Exit Code:</span>{' '}
                              <strong className="text-rose-300">
                                {ffprobeDiagnosticError.diagnostic.ffprobeExitCode}
                              </strong>
                            </div>
                          )}

                        {ffprobeDiagnosticError.diagnostic.ffprobeStderr && (
                          <div>
                            <span className="text-slate-400">Server FFprobe Stderr:</span>
                            <pre className="mt-1 p-2 rounded bg-rose-950/60 text-rose-200 whitespace-pre-wrap break-all">
                              {ffprobeDiagnosticError.diagnostic.ffprobeStderr}
                            </pre>
                          </div>
                        )}

                        {ffprobeDiagnosticError.diagnostic.magicSignature && (
                          <div>
                            <span className="text-slate-400">Header Signature:</span>{' '}
                            <span className="text-amber-300">
                              {ffprobeDiagnosticError.diagnostic.magicSignature.signatureType}
                            </span>{' '}
                            ({ffprobeDiagnosticError.diagnostic.magicSignature.firstBytesAscii})
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Verified FFprobe Pre-Download Container Diagnostic Report Panel */}
                {showDiagnosticPanel && ffprobeDiagnostic && !ffprobeDiagnosticError && (
                  <div className="p-3.5 sm:p-4 rounded-xl bg-[#07162E]/95 border border-[#1E4B85] text-xs space-y-2.5 font-mono">
                    <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-white/10">
                      <div className="flex items-center gap-2 text-[#08B875] font-bold font-sans text-xs sm:text-sm">
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                        <span>
                          Pre-Download FFprobe Check Passed (Container Valid &amp; Non-Zero Size)
                        </span>
                      </div>
                      <span className="text-[11px] text-slate-400">
                        Verified in {ffprobeDiagnostic.elapsedMs ?? 0}ms · Exit Code:{' '}
                        {ffprobeDiagnostic.ffprobeExitCode ?? 0}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5 text-[11px] text-slate-200">
                      <div className="p-2 rounded-lg bg-[#0B1E3D] border border-[#1B3B6F]">
                        <div className="text-slate-400">File Size (Non-Zero)</div>
                        <div className="text-white font-bold mt-0.5">
                          {formatBytes(ffprobeDiagnostic.fileSizeBytes)} (
                          {ffprobeDiagnostic.fileSizeBytes.toLocaleString()} B)
                        </div>
                      </div>

                      <div className="p-2 rounded-lg bg-[#0B1E3D] border border-[#1B3B6F]">
                        <div className="text-slate-400">Container Format</div>
                        <div className="text-white font-bold mt-0.5">
                          {ffprobeDiagnostic.containerFormat}
                        </div>
                      </div>

                      <div className="p-2 rounded-lg bg-[#0B1E3D] border border-[#1B3B6F]">
                        <div className="text-slate-400">Video Stream</div>
                        <div className="text-[#19B8FF] font-bold mt-0.5">
                          {ffprobeDiagnostic.videoStream
                            ? `${ffprobeDiagnostic.videoStream.codecName.toUpperCase()} (${
                                ffprobeDiagnostic.videoStream.profile
                              }) · ${ffprobeDiagnostic.videoStream.width}x${
                                ffprobeDiagnostic.videoStream.height
                              } · ${ffprobeDiagnostic.videoStream.pixFmt}`
                            : 'N/A'}
                        </div>
                      </div>

                      <div className="p-2 rounded-lg bg-[#0B1E3D] border border-[#1B3B6F]">
                        <div className="text-slate-400">Audio Stream &amp; Duration</div>
                        <div className="text-white font-bold mt-0.5">
                          {ffprobeDiagnostic.audioStream
                            ? `${ffprobeDiagnostic.audioStream.codecName.toUpperCase()} (${
                                ffprobeDiagnostic.audioStream.sampleRate || 44100
                              }Hz, ${ffprobeDiagnostic.audioStream.channels || 2}ch)`
                            : 'No Audio'}{' '}
                          · {ffprobeDiagnostic.durationSeconds}s
                        </div>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-300 pt-1">
                      {ffprobeDiagnostic.magicSignature && (
                        <div>
                          <span className="text-slate-400">Header Signature:</span>{' '}
                          <span className="text-[#08B875] font-semibold">
                            {ffprobeDiagnostic.magicSignature.signatureType}
                          </span>{' '}
                          <span className="text-slate-400">
                            [{ffprobeDiagnostic.magicSignature.firstBytesAscii}]
                          </span>
                        </div>
                      )}
                      {ffprobeDiagnostic.sha256 && (
                        <div className="truncate max-w-full">
                          <span className="text-slate-400">SHA-256:</span>{' '}
                          <span className="text-slate-200">{ffprobeDiagnostic.sha256}</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Inline Trimmed Output Verification Player */}
                {showTrimmedPreview && (
                  <div className="pt-2 border-t border-white/10">
                    <p className="text-xs text-slate-300 mb-2 font-mono">
                      Playing verified output clip: {activeJob.outputFileName}
                    </p>
                    <video
                      src={activeJob.downloadUrl}
                      controls
                      autoPlay
                      className="w-full max-h-[260px] rounded-xl bg-black border border-[#28508C]"
                    />
                  </div>
                )}
              </div>
            )}
          </section>
        )}
      </div>

      {/* FOOTER */}
      <footer className="relative z-10 w-full border-t border-[#17305B] bg-[#051024]/80 backdrop-blur-sm py-4 px-4">
        <div className="max-w-[1140px] mx-auto flex flex-wrap items-center justify-center gap-6 sm:gap-10 text-xs sm:text-sm text-slate-200">
          <div className="flex items-center gap-2 whitespace-nowrap">
            <Rocket className="w-4 h-4 text-[#19B8FF]" />
            <span className="font-semibold">Lightning Fast</span>
          </div>

          <div className="hidden sm:block h-4 w-px bg-[#214177]" />

          <div className="flex items-center gap-2 whitespace-nowrap">
            <ShieldCheck className="w-4 h-4 text-[#08B875]" />
            <span className="font-semibold">100% Secure</span>
          </div>

          <div className="hidden sm:block h-4 w-px bg-[#214177]" />

          <div className="flex items-center gap-2 whitespace-nowrap">
            <MonitorSmartphone className="w-4 h-4 text-[#19B8FF]" />
            <span className="font-semibold">Mobile &amp; Desktop Friendly</span>
          </div>
        </div>
      </footer>

      {/* Google Drive Video Browser Modal */}
      <DriveBrowserModal
        isOpen={isDriveModalOpen}
        accessToken={accessToken}
        onClose={() => setIsDriveModalOpen(false)}
        onSelectVideo={(selectedId) => {
          const newUrl = `https://drive.google.com/file/d/${selectedId}/view?usp=sharing`;
          setDriveUrl(newUrl);
          handleLoadVideo(newUrl, accessToken);
        }}
      />

      {/* Mandatory User Confirmation Modal before saving/creating a file in Google Drive */}
      <ConfirmActionModal
        isOpen={showSaveDriveConfirm}
        title="Save Trimmed Video to Google Drive?"
        description={`This will upload and create a new video file "${
          activeJob?.outputFileName || 'trimmed_video.mp4'
        }" (${formatBytes(activeJob?.outputSize || 0)}) in your Google Drive account.`}
        confirmLabel="Confirm & Upload"
        variant="drive"
        onConfirm={executeSaveToGoogleDrive}
        onCancel={() => setShowSaveDriveConfirm(false)}
      />

      {/* Full-Stream Fallback Confirmation Modal */}
      <ConfirmActionModal
        isOpen={showFullStreamConfirm}
        title="Sequential Stream Processing Required"
        description="This video container does not support partial HTTP byte-range seeking. To extract your selected segment, the server must read the video stream sequentially up to your cut point. Do you want to proceed?"
        confirmLabel="Proceed with Trimming"
        variant="warning"
        onConfirm={() => handleStartTrimJob(true)}
        onCancel={() => setShowFullStreamConfirm(false)}
      />
    </div>
  );
}
