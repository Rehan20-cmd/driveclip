import React, { useEffect, useState } from 'react';
import { Film, Loader2, Search, X, Clock, HardDrive } from 'lucide-react';
import { DriveVideoItem, listUserDriveVideos } from '../services/googleAuth';
import { formatBytes, formatTimeDisplay } from '../utils/timeFormat';

interface DriveBrowserModalProps {
  isOpen: boolean;
  accessToken: string | null;
  onClose: () => void;
  onSelectVideo: (fileId: string, fileName: string) => void;
}

export const DriveBrowserModal: React.FC<DriveBrowserModalProps> = ({
  isOpen,
  accessToken,
  onClose,
  onSelectVideo,
}) => {
  const [videos, setVideos] = useState<DriveVideoItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchVideos = async (query: string) => {
    if (!accessToken) return;
    setLoading(true);
    setError(null);
    try {
      const items = await listUserDriveVideos(accessToken, query);
      setVideos(items);
    } catch (err: any) {
      setError(err.message || 'Failed to load videos from your Google Drive.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && accessToken) {
      fetchVideos('');
    }
  }, [isOpen, accessToken]);

  if (!isOpen) return null;

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    fetchVideos(searchQuery);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[#040D1E]/80 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="drive-browser-title"
    >
      <div className="w-full max-w-2xl rounded-2xl bg-[#10264A] border border-[#254B85] shadow-2xl overflow-hidden flex flex-col max-h-[82vh]">
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#1E3F73]">
          <div className="flex items-center gap-2.5">
            <HardDrive className="w-5 h-5 text-[#19B8FF]" />
            <h3 id="drive-browser-title" className="text-lg font-bold text-white">
              Select a Video from Your Google Drive
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-slate-400 hover:text-white p-1.5 rounded-lg transition-colors"
            aria-label="Close Google Drive picker"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSearchSubmit} className="p-4 border-b border-[#1E3F73] bg-[#0B1B38]">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search video files in your Google Drive..."
                className="w-full pl-10 pr-4 py-2 rounded-xl bg-[#07162F] border border-[#254B85] text-sm text-white placeholder-slate-400 focus:outline-none focus:border-[#087BFF]"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-[#087BFF] hover:bg-[#076CE0] text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0"
            >
              Search
            </button>
          </div>
        </form>

        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {loading ? (
            <div className="py-12 flex flex-col items-center justify-center text-slate-300 gap-3">
              <Loader2 className="w-7 h-7 animate-spin text-[#19B8FF]" />
              <span className="text-sm">Loading videos from your Google Drive...</span>
            </div>
          ) : error ? (
            <div className="p-6 text-center text-rose-300 bg-rose-950/30 border border-rose-500/30 rounded-xl text-sm">
              {error}
            </div>
          ) : videos.length === 0 ? (
            <div className="py-12 text-center text-slate-400 text-sm">
              No video files found in your Google Drive matching your search.
            </div>
          ) : (
            videos.map((v) => {
              const durationSec = v.videoMediaMetadata?.durationMillis
                ? Math.round(Number(v.videoMediaMetadata.durationMillis) / 1000)
                : null;
              const sizeNum = v.size ? parseInt(v.size, 10) : 0;

              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => {
                    onSelectVideo(v.id, v.name);
                    onClose();
                  }}
                  className="w-full flex items-center justify-between gap-4 p-3 rounded-xl bg-[#0A1933]/80 hover:bg-[#152E5B] border border-[#1E3F73] hover:border-[#087BFF] transition-all text-left group"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {v.thumbnailLink ? (
                      <img
                        src={v.thumbnailLink}
                        alt={v.name}
                        referrerPolicy="no-referrer"
                        className="w-16 h-10 rounded-lg object-cover bg-[#07162F] shrink-0 border border-[#254B85]"
                      />
                    ) : (
                      <div className="w-16 h-10 rounded-lg bg-[#07162F] border border-[#254B85] flex items-center justify-center shrink-0">
                        <Film className="w-5 h-5 text-[#19B8FF]" />
                      </div>
                    )}
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-white truncate group-hover:text-[#19B8FF] transition-colors">
                        {v.name}
                      </p>
                      <div className="flex items-center gap-2 text-xs text-slate-400 font-mono tabular-nums mt-0.5">
                        {durationSec ? (
                          <span className="inline-flex items-center gap-1">
                            <Clock className="w-3 h-3 text-[#19B8FF]" />
                            {formatTimeDisplay(durationSec)}
                          </span>
                        ) : null}
                        {durationSec && sizeNum > 0 ? <span>·</span> : null}
                        {sizeNum > 0 ? <span>{formatBytes(sizeNum)}</span> : null}
                      </div>
                    </div>
                  </div>

                  <span className="px-3 py-1.5 rounded-lg bg-[#087BFF]/20 text-[#19B8FF] group-hover:bg-[#087BFF] group-hover:text-white text-xs font-semibold transition-colors whitespace-nowrap shrink-0">
                    Load Video
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
