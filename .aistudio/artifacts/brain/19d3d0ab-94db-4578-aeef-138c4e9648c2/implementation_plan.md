# DriveTrim — High-Performance Google Drive Video Trimmer

DriveTrim is a full-stack web application that enables users to paste any Google Drive video sharing link (or select a video from their authenticated Google Drive), preview and scrub through an interactive frame-thumbnail timeline, and extract custom video segments via HTTP byte-range streaming and server-side FFmpeg without forcing a full original file download to their device.

## User Review & Critical Decisions

> [!IMPORTANT]
> The following core product decisions have been locked in based on your preferences and the reference UI design:

- **Confirmed Decision 1 — Hybrid Google Drive Access (Public Links + Google OAuth)**: DriveTrim supports public/shared Google Drive links out of the box (resolving direct media streams, virus-scan confirmation tokens for large files, and HTTP 206 byte ranges) and also includes **Sign in with Google** (`drive.readonly` + `drive.file` scopes) so users can access restricted/private Drive videos and browse their recent Drive video library directly.
- **Confirmed Decision 2 — User-Selectable Trimming Engine Mode**: Users can toggle between **Fast Stream Copy** (`-c copy`, instant keyframe-aligned extraction with zero quality loss and minimal byte transfer) and **Frame-Accurate Re-encode** (`libx264` / `aac` or WebM equivalent, exact millisecond cutting when frame precision is required), with automatic intelligent fallback and explicit user disclosure if a source container lacks random-access byte range support.
- **Confirmed Decision 3 — Dual Export (Local Device Download + Save to Google Drive)**: Once a clip is processed, users can download the trimmed video directly to their device with real-time progress or save the trimmed clip straight back to their Google Drive account with one click.

---

## 1. Overview & Core Concept

- **What It Does**: Allows users to extract specific time segments (e.g., `20:00` to `22:00` from a 30-minute, 2 GB video) directly from Google Drive links. Using an Express + FFmpeg/FFprobe backend streaming proxy and HTTP `Range` requests (`206 Partial Content`), DriveTrim inspects container headers, streams video previews, generates timeline frame thumbnails, and trims only the requested time window.
- **Target Audience / Persona**: Content creators, video editors, educators, and teams working with long recordings, lectures, or raw footage hosted on Google Drive who need rapid clip extraction on desktop or mobile without downloading multi-gigabyte source files.
- **Key Value**: Eliminates wasted bandwidth and local storage by performing partial byte-range seeking and server-side stream slicing while preserving original resolution, aspect ratio, and audio sync.

---

## 2. User Experience & Visual Design

- **Key User Flows**:
  1. **Link Input & Authentication**: User pastes a Google Drive link (supporting `/file/d/ID/view`, `open?id=ID`, `uc?id=ID`, etc.) using the one-click Paste button, or signs in with Google to access private videos / pick from their Drive. A built-in sample high-definition mountain lake video (matching the reference design) is also available for instant one-click testing.
  2. **Validation & Metadata Probe**: Backend validates the file ID, verifies accessibility and video MIME type, detects quota or large-file confirmation tokens, and probes duration, resolution, codec, and byte-range support without downloading the full file.
  3. **Interactive Video Preview**: Full-featured custom video player streaming via `/api/stream/:fileId` with HTTP 206 byte-range seeking, play/pause, scrubbing bar, volume/mute, playback speed/captions toggle, and fullscreen support.
  4. **Filmstrip Timeline & Precision Time Controls**: Interactive dual-handle trim timeline displaying extracted filmstrip thumbnails across the full duration, floating blue timestamp callouts (`20:00`, `22:00`), shaded selected region, synchronized playhead indicator, manual `HH:MM:SS` / `MM:SS` editable start/end inputs, and a **Reset** button.
  5. **Processing & Export**: Displays calculated **Trimmed Duration**, **Estimated Size**, **Output Format** selector (`MP4`, `MOV`, `WebM`), **Trim Mode** toggle (`Fast Stream Copy` vs `Frame-Accurate`), and the prominent green **Download Trimmed Video** CTA (plus **Save to Drive** when signed in). Shows live job progress, cancellation support, completion summary card, and automatic temporary file cleanup.

- **Visual Identity & Theme**:
  - *Aesthetic Direction*: Faithful reproduction of the attached DriveTrim reference design — a sleek, dark studio video-engineering workspace with atmospheric blue depth, crisp 1px structural borders, and luminous interactive controls.
  - *Color Palette & Mood*:
    - Primary Canvas (`--background`): Dark Navy (`#07162F`) with subtle radial atmospheric blue glow and decorative film-reel background motif.
    - Structural Cards (`--card`): Deep Blue (`#10264A`) with refined glassmorphism (`backdrop-blur-md`) and subtle blue-grey hairline borders (`rgba(56, 139, 253, 0.22)`).
    - Primary Accent (`--primary`): Electric Blue (`#087BFF`) to Cyan (`#19B8FF`) gradients for the `Load Video` button, active timeline selection range, and floating handle callouts.
    - Primary Export Action (`--success`): Vibrant Emerald Green (`#08B875` to `#069660`) for the `Download Trimmed Video` CTA and validation checkmarks.
    - Typography Colors: Crisp White (`#FFFFFF`) for primary headings and timestamps; cool light grey (`#94A3B8` / `#CBD5E1`) for secondary labels.
  - *Typography & Hierarchy*:
    - Display & UI Headings: `Plus Jakarta Sans` (Bold 700 / SemiBold 600) for the `DriveTrim` brand lockup, section titles, and action buttons.
    - Body & Controls: `DM Sans` (Regular 400 / Medium 500) for clean legibility across inputs and status banners.
    - Timestamps & Telemetry: `JetBrains Mono` with `font-variant-numeric: tabular-nums` for all timecodes (`00:20:00`), durations (`30:00`), file sizes (`~25 MB`), and progress percentages so numbers never jitter during timeline scrubbing.
  - *Component Styling & Layout*:
    - Desktop-first `1120px` centered workspace container on a `1440px` canvas with single-elevation card depth (no nested card clutter).
    - Fully responsive mobile and tablet adaptation: touch-friendly `44px` hit targets on timeline handles, stacked control bar on narrow screens, and zero horizontal overflow.

---

## 3. Key Product Decisions & Trade-Offs

- **Decision 1: HTTP Range Seeking & FFmpeg Input Seeking (`-ss` before `-i`)**
  - *Chosen Approach*: Pass the resolved Google Drive media stream URL (with appropriate auth headers or confirmation cookies) directly to FFmpeg with `-ss <startTime>` placed **before** `-i <streamUrl>` and `-t <duration>`.
  - *Why*: Placing `-ss` before `-i` instructs FFmpeg's demuxer to parse the MP4/MOV `moov` atom (using HTTP `Range` requests) and seek directly to the byte offset of the target keyframe around the start timestamp. This transfers only the container header plus the 2-minute byte slice rather than downloading the entire 2 GB file.
  - *Alternatives Considered*: Downloading the full file to disk before running FFmpeg was rejected as the default path because it violates the core requirement of avoiding full-video downloads. If a rare container has an unseekable layout, the backend detects this, notifies the user clearly, and requests confirmation before falling back to sequential streaming.

- **Decision 2: Hybrid Stream Copy vs. Frame-Accurate Re-encoding**
  - *Chosen Approach*: Expose a clear toggle defaulting to **Fast Stream Copy** (`-c copy -avoid_negative_ts make_zero`) alongside **Frame-Accurate Re-encode** (`-c:v libx264 -preset fast -crf 18 -c:a aac`).
  - *Why*: Stream copy is near-instantaneous and preserves 100% of the original video bitstream quality, while re-encoding guarantees exact sub-second frame boundaries when a cut falls between keyframes.

- **Decision 3: Real Timeline Filmstrip Generation via Range-Seeked Frame Extraction**
  - *Chosen Approach*: Generate timeline thumbnails by sampling 10–12 evenly spaced timestamps across the video duration using lightweight range-seeked frame captures (with client-side HTML5 `<video>`/`<canvas>` range seeking + server-side FFmpeg single-frame extraction fallback).
  - *Why*: Produces authentic visual frames of the loaded video along the filmstrip track without reading the full video stream.

---

## 4. Technical Architecture & Data Strategy

### Architecture & Component Diagram

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                        DRIVETRIM CLIENT (React + Vite)                       │
│                                                                              │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ HeaderBar: Brand Logo • Tagline • Trust Indicators • Google Sign-In    │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ DriveLinkCard: URL Input • Paste • Load Video • Drive Picker • Status  │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ VideoPreviewPlayer: HTML5 Range Stream • Play/Pause • Scrub • Volume   │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ TrimTimelineCard: Filmstrip Thumbnails • Dual Handles • HH:MM:SS Edit  │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
│                                      ▼                                       │
│  ┌────────────────────────────────────────────────────────────────────────┐  │
│  │ ExportControlBar: Duration & Size Calc • Mode/Format • Download / Save │  │
│  └───────────────────────────────────┬────────────────────────────────────┘  │
└──────────────────────────────────────┼───────────────────────────────────────┘
                                       │ REST / HTTP 206 Range / SSE Progress
                                       ▼
┌──────────────────────────────────────────────────────────────────────────────┐
│                     DRIVETRIM BACKEND (Express + Node.js)                    │
│                                                                              │
│  ┌─────────────────────────┐  ┌──────────────────────┐  ┌─────────────────┐  │
│  │ Google Drive Resolver   │  │ HTTP 206 Range Proxy │  │ FFmpeg / Probe  │  │
│  │ • File ID Parser        │  │ • /api/stream/:id    │  │ Trim Engine     │  │
│  │ • OAuth Bearer Forward  │  │ • Cookie/Token Cache │  │ • Input -ss Seek│  │
│  │ • Confirm Token Handler │  │ • Byte-Range Forward │  │ • Job Progress  │  │
│  │ • Metadata & Quota Check│  │ • SSRF Guard         │  │ • Temp Cleanup  │  │
│  └─────────────────────────┘  └──────────────────────┘  └─────────────────┘  │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Data Model & State

- **`VideoMetadata`**:
  - `fileId`: Extracted Google Drive ID (or sample stream identifier).
  - `fileName`: Sanitized original filename (e.g., `mountain_expedition_raw.mp4`).
  - `mimeType`: Validated video MIME type (`video/mp4`, `video/quicktime`, `video/webm`, `video/x-matroska`).
  - `fileSize`: Total size in bytes (used to calculate estimated trimmed clip size proportionally to bitrate).
  - `durationSeconds`: Exact total duration in seconds probed via Drive `videoMediaMetadata` or `ffprobe`.
  - `supportsRange`: Boolean indicating verified HTTP `206 Partial Content` support.
  - `accessMode`: `'public' | 'oauth' | 'sample'`.
- **`TrimSelectionState`**:
  - `startTime`: Start position in seconds (`0 <= startTime < endTime`).
  - `endTime`: End position in seconds (`startTime < endTime <= durationSeconds`).
  - `trimMode`: `'copy' | 'reencode'`.
  - `outputFormat`: `'mp4' | 'mov' | 'webm'`.
- **`TrimJobState`**:
  - `jobId`: Unique UUID for active server-side FFmpeg job.
  - `status`: `'idle' | 'starting' | 'processing' | 'completed' | 'cancelled' | 'error'`.
  - `progressPercent`: Real-time percentage (`0–100`) parsed from FFmpeg `out_time_ms` output relative to `endTime - startTime`.
  - `outputFilePath` / `outputSize`: Generated file details on completion, auto-purged by the retention cleanup scheduler.

### Interactive Component & State Mapping

1. **URL Extraction & Validation (`DriveLinkCard`)**:
   - Parses all Google Drive link patterns (`/file/d/{id}`, `id={id}`, `/open?id={id}`, `drive.google.com/uc?id={id}`) and rejects non-Google domains to prevent SSRF.
   - Calls `POST /api/video/inspect` with optional `Authorization: Bearer <token>`.
   - If a file is private and the user is unauthenticated, prompts the user with an inline **Sign in with Google** action to retry with their OAuth token.
2. **Synchronized Player & Dual-Handle Timeline (`VideoPreviewPlayer` + `TrimTimelineCard`)**:
   - Dragging the left handle (`startTime`) or right handle (`endTime`) via mouse or touch updates the blue selection window in real time, clamps bounds (`minGap = 1s`), and seeks the video preview to the active handle for visual frame verification.
   - Typing into the editable `Start Time` or `End Time` fields (`HH:MM:SS` or `MM:SS`) validates range constraints and immediately moves the corresponding handle on the filmstrip.
   - Playback includes a "Loop Trim Selection" behavior: pressing Play while inside the trim range plays the selected segment and pauses at `endTime`.
3. **FFmpeg Partial-Stream Trimming & Export (`ExportControlBar`)**:
   - Clicking **Download Trimmed Video** dispatches `POST /api/trim/start` with `{ fileId, startTime, endTime, trimMode, outputFormat }`.
   - Frontend polls/streams `/api/trim/status/:jobId` to render live progress percentage, elapsed time, and a working **Cancel** button (`POST /api/trim/cancel/:jobId` which kills the child FFmpeg process and deletes partial temp files).
   - Upon completion, displays the completion modal/banner with actual output file size, one-click streaming download (`GET /api/trim/download/:jobId`), and **Save to Google Drive** (`POST /api/trim/save-to-drive/:jobId` using multipart upload to `https://www.googleapis.com/upload/drive/v3/files`).
